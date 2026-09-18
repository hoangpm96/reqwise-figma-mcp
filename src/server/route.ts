/**
 * Resolve which Figma window an op should hit.
 *
 * Agents think in file + page names, not opaque channel ids. Several windows
 * may be connected at once — different files, or two windows of the same file
 * on different pages — and they run in parallel because each window is its
 * own plugin main thread. Same file + same page collapses onto ONE window so
 * two plugin threads never race on one canvas.
 *
 * Explicit `file`/`page`/`channel` always win. Otherwise the session's sticky
 * target (user Connect, or auto after the first successful route) wins. A
 * brand-new session with no hint follows the window the user last touched,
 * if that activity is fresh. Two different files and no hint at all still
 * refuse — guessing the wrong file is worse than asking the agent to pass
 * `file` from the conversation.
 */

import { ErrorCode } from "../shared/protocol.js";

/** A connected Figma window, as routing sees it. */
export interface RouteWindow {
  channel: string;
  fileName: string;
  pageName: string;
  /** 0 = the user has not touched this window since it connected. */
  lastUserActivityAt: number;
  queueLength: number;
}

export type RouteArg =
  | string
  | {
      channel?: string;
      file?: string;
      page?: string;
    };

export interface RouteInput {
  channel?: string;
  file?: string;
  page?: string;
  sessionId?: string;
  sessionBoundChannel?: string;
  sessionBoundSource?: "user" | "auto";
  windows: RouteWindow[];
  now?: number;
}

export type RouteReason =
  | "channel"
  | "file-page"
  | "session"
  | "single"
  | "same-file"
  | "focus";

export type RouteDecision =
  | {
      ok: true;
      channel: string;
      reason: RouteReason;
      /** Switch this window to `ensurePage` before the op, if it is not there. */
      ensurePage?: string;
      /** Write/update this session's sticky target after a successful route. */
      sticky?: "auto";
      notice?: string;
    }
  | {
      ok: false;
      code: typeof ErrorCode.AMBIGUOUS_CHANNEL | typeof ErrorCode.CHANNEL_NOT_FOUND;
      message: string;
      hint: string;
    };

/** User activity older than this is not "the window they are working in". */
export const USER_ACTIVITY_FRESH_MS = 5 * 60 * 1000;

export function parseRouteArg(route?: RouteArg): {
  channel?: string;
  file?: string;
  page?: string;
} {
  if (!route) return {};
  if (typeof route === "string") {
    const channel = route.trim();
    return channel ? { channel } : {};
  }
  const channel = typeof route.channel === "string" ? route.channel.trim() : "";
  const file = typeof route.file === "string" ? route.file.trim() : "";
  const page = typeof route.page === "string" ? route.page.trim() : "";
  return {
    ...(channel ? { channel } : {}),
    ...(file ? { file } : {}),
    ...(page ? { page } : {}),
  };
}

/**
 * A `channel` tool arg is often a file name, or "file · page". Split those
 * so the caller can try exact-id first and name-match second.
 */
export function parseTargetHint(raw: string): { file?: string; page?: string } {
  const s = raw.trim();
  if (!s) return {};
  for (const sep of [" · ", " / ", " | "]) {
    const at = s.indexOf(sep);
    if (at > 0) {
      return { file: s.slice(0, at).trim(), page: s.slice(at + sep.length).trim() };
    }
  }
  const slash = s.indexOf("/");
  if (slash > 0 && slash < s.length - 1 && !s.includes("://")) {
    return { file: s.slice(0, slash).trim(), page: s.slice(slash + 1).trim() };
  }
  return { file: s };
}

export function normalizeName(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "");
}

export function namesMatch(have: string, want: string): boolean {
  const a = normalizeName(have);
  const b = normalizeName(want);
  if (!b) return true;
  if (!a) return false;
  return a === b || a.includes(b) || b.includes(a);
}

export function describeWindows(windows: RouteWindow[]): string {
  return windows
    .map((w) => `"${w.fileName || "untitled"}" · ${w.pageName || "?"} (${w.channel})`)
    .join(", ");
}

function uniqueMatch(windows: RouteWindow[], pred: (w: RouteWindow) => boolean): RouteWindow[] {
  return windows.filter(pred);
}

function collapseSamePage(windows: RouteWindow[]): RouteWindow {
  // Two windows of the same file on the same page: pin to ONE thread so the
  // Plugin API never sees overlapping mutations on one canvas. The pick is
  // stable by channel id — load-balancing onto the idle twin would run two
  // plugin main threads against the same document.
  const ranked = [...windows].sort((a, b) => a.channel.localeCompare(b.channel));
  return ranked[0]!;
}

function focusedWindow(windows: RouteWindow[], now: number): RouteWindow | undefined {
  let best: RouteWindow | undefined;
  for (const w of windows) {
    if (w.lastUserActivityAt <= 0) continue;
    if (now - w.lastUserActivityAt > USER_ACTIVITY_FRESH_MS) continue;
    if (!best || w.lastUserActivityAt > best.lastUserActivityAt) best = w;
  }
  return best;
}

function allSameFile(windows: RouteWindow[]): boolean {
  if (windows.length === 0) return false;
  const key = normalizeName(windows[0]!.fileName);
  if (!key) return false;
  return windows.every((w) => normalizeName(w.fileName) === key);
}

function pickAmongFile(
  windows: RouteWindow[],
  page: string | undefined,
  now: number,
): { window: RouteWindow; ensurePage?: string } | { ambiguous: true } {
  if (windows.length === 0) return { ambiguous: true };
  if (page) {
    const onPage = uniqueMatch(windows, (w) => namesMatch(w.pageName, page));
    if (onPage.length === 1) return { window: onPage[0]! };
    if (onPage.length > 1) return { window: collapseSamePage(onPage) };
    // No window is on that page — use one window of the file and switch.
    return { window: collapseSamePage(windows), ensurePage: page };
  }
  if (windows.length === 1) return { window: windows[0]! };
  const byPage = new Map<string, RouteWindow[]>();
  for (const w of windows) {
    const k = normalizeName(w.pageName) || w.channel;
    const list = byPage.get(k) ?? [];
    list.push(w);
    byPage.set(k, list);
  }
  if (byPage.size === 1) return { window: collapseSamePage(windows) };
  const focused = focusedWindow(windows, now);
  if (focused) return { window: focused };
  return { ambiguous: true };
}

function filePageNotice(w: RouteWindow): string {
  return `This session now targets "${w.fileName || "untitled"}" · "${w.pageName || "?"}". Later calls stay here unless you pass a different file/page. Other agents on other files or pages (separate windows) run in parallel.`;
}

export function resolveRoute(input: RouteInput): RouteDecision {
  const now = input.now ?? Date.now();
  const windows = input.windows;
  const channel = input.channel?.trim() ?? "";
  const file = input.file?.trim() ?? "";
  const page = input.page?.trim() ?? "";
  const explicit = Boolean(channel || file || page);

  if (windows.length === 0) {
    return {
      ok: false,
      code: ErrorCode.CHANNEL_NOT_FOUND,
      message: "No Figma window is connected.",
      hint: "Open the Reqwise plugin in the Figma file you want, then retry.",
    };
  }

  // 1. Exact channel id.
  if (channel && windows.some((w) => w.channel === channel)) {
    const w = windows.find((x) => x.channel === channel)!;
    const ensurePage = page && !namesMatch(w.pageName, page) ? page : undefined;
    return {
      ok: true,
      channel: w.channel,
      reason: "channel",
      ...(ensurePage ? { ensurePage } : {}),
      sticky: "auto",
      notice: filePageNotice(w),
    };
  }

  // 2. `channel` used as a file/page name (agents often pass the file there).
  let wantFile = file;
  let wantPage = page;
  if (channel && !wantFile) {
    const parsed = parseTargetHint(channel);
    wantFile = parsed.file ?? "";
    if (!wantPage && parsed.page) wantPage = parsed.page;
  }

  // 3. File / page match.
  if (wantFile || wantPage) {
    let matched = windows;
    if (wantFile) {
      matched = uniqueMatch(matched, (w) => namesMatch(w.fileName, wantFile));
      if (matched.length === 0) {
        return {
          ok: false,
          code: ErrorCode.CHANNEL_NOT_FOUND,
          message: `No connected Figma window matches file "${wantFile}".`,
          hint: `Connected: ${describeWindows(windows)}. Pass file as it appears there (fuzzy is fine: "klopop" matches "Klopop official").`,
        };
      }
      // Two different files both fuzzy-matched the query → refuse rather than guess.
      if (!allSameFile(matched) && matched.length > 1) {
        return {
          ok: false,
          code: ErrorCode.AMBIGUOUS_CHANNEL,
          message: `Several files match "${wantFile}".`,
          hint: `Matches: ${describeWindows(matched)}. Pass a more specific file name.`,
        };
      }
    }
    if (wantPage && wantFile) {
      const picked = pickAmongFile(matched, wantPage, now);
      if ("ambiguous" in picked) {
        return {
          ok: false,
          code: ErrorCode.AMBIGUOUS_CHANNEL,
          message: `Several windows of "${matched[0]?.fileName}" are connected and page "${wantPage}" is not unique.`,
          hint: `Connected: ${describeWindows(matched)}. Open one window on that page, or pass channel.`,
        };
      }
      return {
        ok: true,
        channel: picked.window.channel,
        reason: "file-page",
        ...(picked.ensurePage ? { ensurePage: picked.ensurePage } : {}),
        sticky: "auto",
        notice: filePageNotice(picked.window),
      };
    }
    if (wantPage && !wantFile) {
      const onPage = uniqueMatch(matched, (w) => namesMatch(w.pageName, wantPage));
      if (onPage.length === 0) {
        return {
          ok: false,
          code: ErrorCode.CHANNEL_NOT_FOUND,
          message: `No connected Figma window is on a page matching "${wantPage}".`,
          hint: `Connected: ${describeWindows(windows)}. Pass file as well if the page lives in a window that is currently showing something else — the window will switch.`,
        };
      }
      if (!allSameFile(onPage) && onPage.length > 1) {
        return {
          ok: false,
          code: ErrorCode.AMBIGUOUS_CHANNEL,
          message: `Several files have a page matching "${wantPage}".`,
          hint: `Matches: ${describeWindows(onPage)}. Pass file too.`,
        };
      }
      const picked = pickAmongFile(onPage, undefined, now);
      if ("ambiguous" in picked) {
        return {
          ok: false,
          code: ErrorCode.AMBIGUOUS_CHANNEL,
          message: `Several windows match page "${wantPage}".`,
          hint: `Connected: ${describeWindows(onPage)}. Pass file too.`,
        };
      }
      return {
        ok: true,
        channel: picked.window.channel,
        reason: "file-page",
        sticky: "auto",
        notice: filePageNotice(picked.window),
      };
    }
    // File only.
    const picked = pickAmongFile(matched, undefined, now);
    if ("ambiguous" in picked) {
      return {
        ok: false,
        code: ErrorCode.AMBIGUOUS_CHANNEL,
        message: `Several pages of "${matched[0]?.fileName}" are open in different windows.`,
        hint: `Connected: ${describeWindows(matched)}. Pass page (e.g. "Flows") so this session pins to one. Two agents on two pages run in parallel.`,
      };
    }
    return {
      ok: true,
      channel: picked.window.channel,
      reason: "file-page",
      ...(picked.ensurePage ? { ensurePage: picked.ensurePage } : {}),
      sticky: "auto",
      notice: filePageNotice(picked.window),
    };
  }

  // 4. Session sticky (user Connect, or auto from an earlier call).
  if (!explicit && input.sessionBoundChannel) {
    const w = windows.find((x) => x.channel === input.sessionBoundChannel);
    if (w) {
      return {
        ok: true,
        channel: w.channel,
        reason: "session",
        notice:
          input.sessionBoundSource === "user"
            ? `The user bound this session to channel "${w.channel}" (${w.fileName || "untitled"}) from the Figma plugin UI — operations now route to that window by default.`
            : undefined,
      };
    }
  }

  // 5. Single window.
  if (windows.length === 1) {
    const w = windows[0]!;
    return {
      ok: true,
      channel: w.channel,
      reason: "single",
      sticky: "auto",
    };
  }

  // 6. Every window is the same file — the "page đang làm" case.
  if (allSameFile(windows)) {
    const picked = pickAmongFile(windows, undefined, now);
    if (!("ambiguous" in picked)) {
      return {
        ok: true,
        channel: picked.window.channel,
        reason: "same-file",
        sticky: "auto",
        notice: filePageNotice(picked.window),
      };
    }
  }

  // 7. Follow the window the user last touched.
  const focused = focusedWindow(windows, now);
  if (focused) {
    return {
      ok: true,
      channel: focused.channel,
      reason: "focus",
      sticky: "auto",
      notice: `This session followed the focused Figma window ("${focused.fileName || "untitled"}" · "${focused.pageName || "?"}"). Later calls stay here unless you pass file/page.`,
    };
  }

  // 8. Refuse rather than draw on the wrong file.
  return {
    ok: false,
    code: ErrorCode.AMBIGUOUS_CHANNEL,
    message: `${windows.length} Figma windows are connected — pass file (and page if the same file is open twice).`,
    hint: `Connected: ${describeWindows(windows)}. Pass file from the user's request or from figma_status.channels — do not ask them to click Connect. Different files run in parallel. Click a shape in the window you want and retry if you have no file name yet.`,
  };
}
