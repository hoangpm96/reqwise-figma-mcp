/**
 * MCP tool handlers. These sit above the coordinator: each handler shapes user
 * input, runs ops through the single validate+dispatch choke point
 * (`runValidated`, provided by index.ts) and formats a token-frugal result.
 *
 * figma_status assembles rich diagnostics + an ordered `hints` list of
 * concrete next steps (never a bare boolean). figma_rules runs the three
 * design-system reads in parallel and formats a markdown rule sheet.
 */
import {
  HEARTBEAT_DEAD_MS,
  PROTOCOL_VERSION,
  type LeaderInfo,
} from "../shared/protocol.js";
import { BUILD, VERSION } from "./version.js";
import { ErrorCode, OpError } from "./errors.js";
import { validateOperation, isReadOp } from "./validate.js";
import { runUserflow } from "./userflow.js";
import { runActivity, type OpCall } from "./activity.js";
import { runErd } from "./erd.js";
import { runSequence } from "./sequence.js";
import { runState } from "./state.js";
import { runSitemap } from "./sitemap.js";
import { applyPatch } from "./patch.js";
import { checkConsistency, type ConsistencyFinding } from "../shared/model/check.js";
import { checkCoverage, type ArtboardRef } from "../shared/model/coverage.js";
import { indexPage, type StoredDiagram } from "../shared/model/facts.js";
import { getDoc, DOC_SECTION_NAMES, type DocLevel } from "./docs-content/index.js";
import { isProFeature, proFeatureMessage } from "../shared/editions.js";
import type { SessionRegistry } from "./session.js";

/** Everything the tool handlers need from the running server. */
export interface ToolContext {
  /** validate → dispatch (leader) OR validate → forward (follower). */
  runValidated: (op: string, params: Record<string, unknown>, sessionId?: string, channel?: string) => Promise<unknown>;
  /** figma_write executor (leader only; followers forward a "write" pseudo-op). */
  runWrite: (code: string, sessionId?: string, channel?: string) => Promise<unknown>;
  sessions: SessionRegistry;
  diagnostics: () => Promise<Diagnostics>;
}

export interface ChannelDiagnostics {
  channel: string;
  plugin: {
    version: string;
    /** Build stamp of the bundle Figma is running; absent on an older plugin. */
    build?: string;
    protocolVersion: number;
    fileKey: string | null;
    fileName: string;
    pageName: string;
    editorType: string;
    connectedAt: number;
  };
  queueLength: number;
  pendingCount: number;
  lastHeartbeatMs: number;
  /** Agent sessions the user bound to this window from the plugin UI. */
  boundSessions?: string[];
}

export interface Diagnostics {
  mode: "leader" | "follower";
  port: number;
  bridgeAuth: "ok" | "missing";
  /**
   * true/false = MEASURED. null = UNKNOWN — we could not reach the leader to
   * ask, so we do not know. Never collapse null to false: a follower that
   * reported a momentary "leader unreachable" as pluginConnected:false sent
   * users off to restart a plugin that was running fine the whole time.
   */
  pluginConnected: boolean | null;
  /**
   * Where the plugin state came from: this process's own bridge ("local"),
   * the leader answering /rpc ("leader"), or nowhere ("unknown").
   */
  statusSource: "local" | "leader" | "unknown";
  /** Why statusSource is "unknown" (follower could not query the leader). */
  statusError?: string;
  plugin?: {
    version: string;
    protocolVersion: number;
    fileName: string;
    pageName: string;
    editorType: string;
  };
  /** One entry per connected Figma window. undefined when unknown. */
  channels?: ChannelDiagnostics[];
  /** -1 = no heartbeat yet; null = unknown (leader unreachable). */
  lastHeartbeatMs: number | null;
  queueLength: number;
  pendingCount: number;
  leader?: LeaderInfo | undefined;
  /** This MCP connection's own (private) session id. */
  defaultSessionId?: string;
  /** Channel this process's session is bound to via the plugin UI, if any. */
  boundChannel?: string;
}

// ---- figma_status ----

export async function handleStatus(ctx: ToolContext): Promise<Record<string, unknown>> {
  const d = await ctx.diagnostics();
  const apiVersionMatch = d.plugin ? d.plugin.protocolVersion === PROTOCOL_VERSION : null;
  const hints = buildHints(d, apiVersionMatch);

  return {
    // null (not false) when we could not measure — see Diagnostics.pluginConnected.
    pluginConnected: d.pluginConnected,
    statusSource: d.statusSource,
    ...(d.statusError ? { statusError: d.statusError } : {}),
    mode: d.mode,
    port: d.port,
    serverVersion: VERSION,
    serverBuild: BUILD,
    protocolVersion: PROTOCOL_VERSION,
    bridgeAuth: d.bridgeAuth,
    plugin: d.plugin
      ? {
          version: d.plugin.version,
          apiVersionMatch,
          fileName: d.plugin.fileName,
          pageName: d.plugin.pageName,
          editorType: d.plugin.editorType,
        }
      : null,
    // null, not [], when unknown — an empty array reads as "measured: none".
    channels:
      d.channels === undefined
        ? null
        : d.channels.map((c) => ({
            channel: c.channel,
            fileName: c.plugin.fileName,
            pageName: c.plugin.pageName,
            queueLength: c.queueLength,
            lastHeartbeatMs: c.lastHeartbeatMs,
            ...(c.plugin.build ? { pluginBuild: c.plugin.build } : {}),
            ...(c.boundSessions?.length ? { boundSessions: c.boundSessions } : {}),
          })),
    lastHeartbeatMs: d.lastHeartbeatMs,
    queueLength: d.queueLength,
    pendingCount: d.pendingCount,
    sessions: ctx.sessions.summaries(),
    ...(d.defaultSessionId ? { mySessionId: d.defaultSessionId } : {}),
    ...(d.boundChannel ? { myBoundChannel: d.boundChannel } : {}),
    hints,
  };
}

/**
 * The question that has cost this project the most time, answered without
 * anybody having to reason about it.
 *
 * Figma keeps the bundle a plugin was launched with, so a rebuild never
 * reaches a window that is already open — and the symptom is a fix that
 * visibly did not apply, which is indistinguishable from a fix that does not
 * work. Worse, the obvious remedy makes it look solved: reconnecting restarts
 * the SERVER and rotates the bridge channel id, so the plugin appears to have
 * restarted too.
 *
 * A stamp on each half turns that deduction into a comparison. Two silences
 * are deliberate: a plugin too old to report a stamp says nothing (an absent
 * value is not evidence), and a server running unbundled — `dev`, i.e. vitest
 * or tsx — compares nothing, because it has no build of its own to compare
 * against.
 */
export function staleBundleHints(
  channels: ChannelDiagnostics[] | undefined,
  serverBuild: string,
): string[] {
  if (serverBuild === "dev") return [];
  const out: string[] = [];
  for (const c of channels ?? []) {
    const build = c.plugin.build;
    if (!build || build === serverBuild) continue;
    out.push(
      `The plugin open in "${c.plugin.fileName}" is running a bundle built ${build}, but this server is running ${serverBuild}. Anything fixed in between is NOT loaded there — re-run the plugin from Figma's Plugins → Development. (A reconnect restarts the SERVER and rotates the channel id; it does not reload the plugin.)`,
    );
  }
  return out;
}

/** Ordered, concrete next steps — the most actionable first. */
function buildHints(d: Diagnostics, apiVersionMatch: boolean | null): string[] {
  const hints: string[] = [];

  for (const hint of staleBundleHints(d.channels, BUILD)) hints.push(hint);

  if (d.mode === "follower") {
    hints.push(
      "This process is a FOLLOWER; operations forward to the leader over /rpc. This is normal with multiple IDE windows." +
        (d.statusSource === "leader" ? " Plugin state below was read from the leader and is live." : ""),
    );
  }
  if (d.bridgeAuth === "missing") {
    hints.push(
      "Bridge auth token is missing — the discovery file (leader-<port>.json) was not written or is unreadable. Restart the server.",
    );
  }
  if (d.pluginConnected === null) {
    // UNKNOWN, not disconnected. Telling the user to restart a plugin we never
    // managed to ask about is exactly the wasted-turns bug this branch exists
    // to prevent — say what we could not do, and let ops speak for themselves.
    hints.push(
      `Plugin connection is UNKNOWN — this follower could not query the leader for status${
        d.statusError ? ` (${d.statusError})` : ""
      }. This does NOT mean the plugin is disconnected; do not ask the user to restart it on this basis. Ops still forward to the leader — try figma_read {op:"list_channels"}, and only if that fails treat the bridge as down.`,
    );
  } else if (!d.pluginConnected) {
    hints.push(
      "No Figma plugin connected. Open Figma Desktop → Plugins → Reqwise, and keep the plugin window open.",
    );
  } else {
    if ((d.channels?.length ?? 0) > 1 && !d.boundChannel) {
      hints.push(
        `${d.channels?.length} Figma windows are connected. Pass channel in figma_write/figma_read (see channels above or figma_read {op:"list_channels"}), or ask the user to pick this session (${d.defaultSessionId ?? "?"}) in the plugin UI of the window they want.`,
      );
    }
    if (d.boundChannel) {
      hints.push(
        `This session is bound to channel "${d.boundChannel}" (picked by the user in the plugin UI) — operations route there by default.`,
      );
    }
    if (apiVersionMatch === false) {
      hints.push(
        `Plugin protocol v${d.plugin?.protocolVersion} ≠ server v${PROTOCOL_VERSION} — reinstall the plugin from plugin/manifest.json.`,
      );
    }
    if (d.lastHeartbeatMs !== null && d.lastHeartbeatMs >= 0 && d.lastHeartbeatMs > HEARTBEAT_DEAD_MS) {
      hints.push(
        `No heartbeat for ${Math.round(d.lastHeartbeatMs / 1000)}s — the Figma window may be minimized or the machine asleep.`,
      );
    }
    if (d.queueLength > 0) {
      hints.push(`${d.queueLength} operation(s) queued — the plugin is busy; batch related ops to reduce round-trips.`);
    }
  }
  if (hints.length === 0) {
    hints.push("All systems nominal. Draw with figma_write; verify with figma_read layout_audit.");
  }
  return hints;
}

// ---- figma_read ----

export async function handleRead(
  ctx: ToolContext,
  op: string,
  params: Record<string, unknown>,
  channel?: string,
): Promise<unknown> {
  if (!isReadOp(op)) {
    throw new OpError(
      ErrorCode.INVALID_PARAMS,
      `"${op}" is not a read operation.`,
      "Use figma_write for mutations. Read ops: see figma_docs(section=\"api\").",
    );
  }
  // validateOperation is applied inside runValidated (the choke point).
  const result = await ctx.runValidated(op, params, undefined, channel);

  // The plugin hands back what each frame stores; deriving what the PAGE knows
  // from it is the server's job, and it is what makes "the hold becomes 15
  // minutes — what has to change?" a lookup instead of five diagrams read by
  // hand. The frames an entry names are the frames to patch.
  if (op === "get_page_model" && result && typeof result === "object") {
    const page = result as { diagrams?: Array<StoredDiagram & { unreadable?: boolean }> };
    const all = page.diagrams ?? [];
    const usable = all.filter((d) => d && d.spec !== undefined);

    // Frames that are diagrams but cannot be read are counted, not buried. A
    // caller acting on this index needs to know the picture is incomplete.
    const unreadable = all.filter((d) => d?.unreadable);
    const artboards = readArtboards(result);
    const coverage = checkCoverage(usable, artboards);
    return {
      ...page,
      index: indexPage(usable),
      consistency: checkConsistency(usable),
      ...(coverage ? { coverage } : {}),
      ...(unreadable.length
        ? {
            unreadable: unreadable.length,
            hint: `${unreadable.length} frame(s) were drawn before the model was stored on the frame, so they are in no index and no check here. Redraw each once (figma_diagram with its spec, or \`update\` its frameId) and it joins in.`,
          }
        : {}),
    };
  }
  return result;
}

// ---- figma_write ----

export async function handleWrite(
  ctx: ToolContext,
  code: string,
  sessionId?: string,
  channel?: string,
): Promise<unknown> {
  if (typeof code !== "string" || code.trim().length === 0) {
    throw new OpError(
      ErrorCode.INVALID_PARAMS,
      "figma_write requires non-empty `code`.",
      "Pass JavaScript that uses the figma.* proxy, e.g. await figma.create({type:'FRAME'}).",
    );
  }
  return ctx.runWrite(code, sessionId, channel);
}

// ---- figma_diagram ----

/**
 * Draw a diagram that is NOT a userflow. One tool with a `type` rather than one
 * tool per diagram: every tool description is paid for in tokens in every
 * session, and the shapes differ far more than the call does.
 */
export async function handleDiagram(
  ctx: ToolContext,
  type: unknown,
  spec: unknown,
  channel?: string,
): Promise<unknown> {
  const batch = (spec as { diagrams?: unknown })?.diagrams;
  if (Array.isArray(batch)) return handleDiagramBatch(ctx, spec as BatchSpec, channel);
  if (batch !== undefined) {
    throw new OpError(
      ErrorCode.INVALID_PARAMS,
      "`diagrams` must be an array of diagram specs.",
      'Either one diagram at the top level ({ type, title, ... }) or several in `diagrams: [{ type: "erd", title, ... }, ...]`.',
    );
  }
  const update = (spec as { update?: unknown })?.update;
  if (update !== undefined) {
    if (typeof update !== "string" || !update.trim()) {
      throw new OpError(
        ErrorCode.INVALID_PARAMS,
        "`update` must be the id of the frame to redraw.",
        'It is the `frameId` a diagram tool returned, e.g. update: "140:5914".',
      );
    }
    return handleDiagramUpdate(ctx, update, type, spec as Record<string, unknown>, channel);
  }
  if ((spec as { patch?: unknown })?.patch !== undefined) {
    throw new OpError(
      ErrorCode.INVALID_PARAMS,
      "`patch` needs an `update` saying which frame to patch.",
      'e.g. { update: "140:5914", patch: [{ collection: "messages", id: "m7", set: { label: "200 paid" } }] }.',
    );
  }
  if (type === undefined) {
    throw new OpError(
      ErrorCode.INVALID_PARAMS,
      "figma_diagram needs a `type` (or a `diagrams` array).",
      'One diagram: { type: "sequence", title, ... }. Several at once: { diagrams: [{ type: "erd", ... }, { type: "state", ... }], place: "column", x, y }.',
    );
  }
  return drawWithChecks(ctx, spec, channel, (s) => runDiagramType(ctx, type, s, channel));
}

/**
 * Change a diagram that is already on the canvas.
 *
 * `update` is the frame to redraw. It keeps its id, so comments pinned to it,
 * prototype links into it and wherever the user dragged it all survive — which
 * is the difference between editing a diagram and replacing it.
 *
 * With `patch`, the spec does not have to be sent at all: the frame carries the
 * model it was drawn from, so the change is expressed against that. Without
 * `patch`, the spec in the call is drawn into the frame as-is.
 */
async function handleDiagramUpdate(
  ctx: ToolContext,
  update: string,
  type: unknown,
  spec: Record<string, unknown>,
  channel?: string,
): Promise<unknown> {
  // `update` is where the drawing goes, not part of what is drawn.
  const { patch, update: _target, ...rest } = spec;
  let next: unknown = rest;
  let kind = type;
  let applied: string[] | undefined;

  if (patch !== undefined) {
    const stored = (await ctx.runValidated(
      "get_diagram_spec",
      { nodeId: update },
      undefined,
      channel,
    )) as { kind?: string; spec?: unknown };
    const result = applyPatch(stored.spec, patch);
    // Anything else in the call would be a second, contradictory source for
    // the same fields, and silently picking one of them is how a patch stops
    // meaning what it says.
    const extra = Object.keys(rest).filter((k) => !PATCH_CALL_FIELDS.has(k));
    if (extra.length) {
      throw new OpError(
        ErrorCode.INVALID_PARAMS,
        `A patch changes the model the frame already holds, so it cannot also carry ${extra.join(", ")}.`,
        "Either patch the stored model, or send a whole spec with `update` and no `patch` to redraw the frame from scratch.",
      );
    }
    next = result.spec;
    applied = result.applied;
    if (kind === undefined) kind = stored.kind;
  }

  if (kind === undefined) {
    throw new OpError(
      ErrorCode.INVALID_PARAMS,
      "figma_diagram needs a `type` to redraw a frame from a full spec.",
      'e.g. { type: "sequence", update: "140:5914", title, messages: [...] }. A `patch` does not need one — the frame remembers its kind.',
    );
  }

  const drawn = (await drawWithChecks(ctx, next, channel, (s) =>
    runDiagramType(ctx, kind, s, channel, update),
  )) as Record<string, unknown>;
  return applied ? { ...drawn, patched: applied } : drawn;
}

/** What may accompany a `patch` — placement and options, never model fields. */
const PATCH_CALL_FIELDS = new Set(["type", "options"]);

interface BatchSpec {
  diagrams: unknown[];
  /** How to lay the frames out relative to each other. */
  place?: "column" | "row" | "none";
  /** Gap between frames, px. Defaults to the 250 the shared rules ask for. */
  gap?: number;
  x?: number;
  y?: number;
  parentId?: string;
  options?: Record<string, unknown>;
}

/**
 * Draw a whole set of diagrams in ONE call, placing them for the caller.
 *
 * Two things this removes, both of which were the agent's job before: a round
 * trip per diagram, and the arithmetic of stacking frames from the `box` each
 * previous draw returned (get it wrong and the frames land on top of each
 * other, because everything defaults to 0,0).
 *
 * Sizing comes from a dry build per item — the layout is deterministic and
 * costs single-digit milliseconds, so the placement is known before the first
 * frame is drawn.
 */
async function handleDiagramBatch(
  ctx: ToolContext,
  spec: BatchSpec,
  channel?: string,
): Promise<unknown> {
  const items = spec.diagrams;
  if (!items.length) {
    throw new OpError(
      ErrorCode.INVALID_PARAMS,
      "`diagrams` is empty — nothing to draw.",
      'Pass one entry per diagram: diagrams: [{ type: "erd", title, entities, relations }, ...].',
    );
  }
  const place = spec.place ?? "column";
  const gap = typeof spec.gap === "number" ? spec.gap : 250;
  const shared = spec.options ?? {};
  const checkFirst = shared.checkFirst === true;
  const dryRun = shared.dryRun === true;

  // 1. Build every item dry: the findings and the size of each frame, with
  //    nothing on the canvas yet.
  const prepared: Array<{
    type: unknown;
    spec: Record<string, unknown>;
    sized: DiagramResult;
    /** An existing frame to redraw into, keeping its id and its position. */
    into?: string;
    applied?: string[];
  }> = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new OpError(
        ErrorCode.INVALID_PARAMS,
        "Every entry in `diagrams` must be a diagram spec object.",
        'Each entry carries its own `type` and `title`, e.g. { type: "state", title: "Booking lifecycle", states, transitions }.',
      );
    }
    const item = { ...(raw as Record<string, unknown>) };
    const { type: rawType, update, patch, ...rest } = item;
    let type = rawType;

    // An entry can redraw a frame that already exists, and can express the
    // change as a patch against the model that frame holds — the same two
    // things a single-diagram call can do. Without this, re-running a set is
    // the fastest way to end up with every diagram on the page twice.
    let body: Record<string, unknown> = rest;
    let applied: string[] | undefined;
    if (patch !== undefined) {
      if (update === undefined) {
        throw new OpError(
          ErrorCode.INVALID_PARAMS,
          `"${titleOf(rest, prepared.length)}": \`patch\` needs an \`update\` saying which frame to patch.`,
          'Each entry patches its own frame: { update: "140:5914", patch: [...] }.',
        );
      }
      const stored = (await ctx.runValidated(
        "get_diagram_spec",
        { nodeId: update },
        undefined,
        channel,
      )) as { kind?: string; spec?: unknown };
      const result = applyPatch(stored.spec, patch);
      const extra = Object.keys(rest).filter((k) => !PATCH_CALL_FIELDS.has(k));
      if (extra.length) {
        throw new OpError(
          ErrorCode.INVALID_PARAMS,
          `"${titleOf(rest, prepared.length)}": a patch changes the model the frame already holds, so it cannot also carry ${extra.join(", ")}.`,
          "Either patch the stored model, or send a whole spec with `update` and no `patch`.",
        );
      }
      body = result.spec;
      applied = result.applied;
      if (type === undefined) type = stored.kind;
    }

    const merged = { ...body, options: { ...shared, ...readOptions(body) } } as Record<string, unknown>;
    if (spec.parentId !== undefined && merged.parentId === undefined) merged.parentId = spec.parentId;
    const sized = (await runDiagramType(
      ctx,
      type,
      withOptions(merged, { dryRun: true }),
      channel,
    )) as DiagramResult;
    prepared.push({
      type,
      spec: merged,
      sized,
      ...(typeof update === "string" ? { into: update } : {}),
      ...(applied ? { applied } : {}),
    });
  }

  // 2. One verdict for the set: proof-reading a set and then drawing half of
  //    it is worse than drawing none, because the half tells you it passed.
  const findings = prepared.flatMap((p, i) =>
    (p.sized.warnings ?? []).map((w) => `[${titleOf(p.spec, i)}] ${w}`),
  );
  if (dryRun || (checkFirst && findings.length)) {
    return {
      ...(dryRun ? { dryRun: true } : { checkedOnly: true }),
      diagrams: prepared.map((p, i) => ({
        type: p.type,
        title: titleOf(p.spec, i),
        warnings: p.sized.warnings ?? [],
        stats: p.sized.stats,
      })),
      warnings: findings,
      ...(checkFirst && findings.length
        ? {
            hint: "Nothing was drawn: checkFirst was set and the set has findings. Fix them (or drop checkFirst to draw anyway) and call again.",
          }
        : {}),
    };
  }

  // 3. Place and draw. An explicit x/y on an entry always wins — a caller who
  //    positioned a frame meant it.
  let cursorX = typeof spec.x === "number" ? spec.x : 0;
  let cursorY = typeof spec.y === "number" ? spec.y : 0;
  const results: Array<Record<string, unknown>> = [];
  let setConsistency: unknown[] = [];
  for (const [i, p] of prepared.entries()) {
    const stats = (p.sized.stats ?? {}) as { w?: number; h?: number };
    const w = stats.w ?? 0;
    const h = stats.h ?? 0;
    const at: Record<string, unknown> = { ...p.spec };
    // A frame being redrawn keeps where the user put it, so it neither takes
    // its x/y from the cursor nor moves the cursor on for the next one.
    if (place !== "none" && !p.into) {
      if (at.x === undefined) at.x = cursorX;
      if (at.y === undefined) at.y = cursorY;
    }
    try {
      const drawn = (await drawWithChecks(ctx, withOptions(at, { checkFirst: false }), channel, (s) =>
        runDiagramType(ctx, p.type, s, channel, p.into),
      )) as Record<string, unknown>;
      // Each entry sees the diagrams drawn BEFORE it, so the last one sees the
      // whole set — and every earlier entry's findings are a prefix of its.
      // Keeping them per entry would report the same disagreement once for
      // every diagram drawn after it.
      //
      // ALWAYS the last one, empty included. Keeping the last non-empty result
      // meant that a set which FIXED the last disagreement still reported it,
      // because the final entry's clean answer was discarded in favour of a
      // stale one — a findings feature that cries wolf at the moment you fix
      // something is worse than no findings feature.
      const { consistency, ...entry } = drawn;
      setConsistency = Array.isArray(consistency) ? consistency : [];
      results.push({ type: p.type, ...entry, ...(p.applied ? { patched: p.applied } : {}) });
    } catch (err) {
      // Partial commit, said out loud: the frames before this one are on the
      // canvas and the caller has to know which.
      return {
        diagrams: results,
        failedAt: { index: i, title: titleOf(p.spec, i), error: String(err instanceof Error ? err.message : err) },
        warnings: findings,
        hint: "The frames listed in `diagrams` were drawn; the set stopped at `failedAt`. Fix that entry and re-send the rest.",
      };
    }
    if (p.into) continue;
    // Advance from where the frame ACTUALLY landed, not from where it was
    // asked to go. The plugin slides a frame clear of work already on the
    // page, and a cursor that ignored that put the next diagram back on top
    // of the thing the first one had just been moved off.
    const box = (results[results.length - 1] as { box?: { x: number; y: number; w: number; h: number } })
      ?.box;
    const landed = box ?? { x: cursorX, y: cursorY, w, h };
    if (place === "column") cursorY = landed.y + landed.h + gap;
    if (place === "row") cursorX = landed.x + landed.w + gap;
  }

  return {
    diagrams: results,
    warnings: findings,
    ...(setConsistency.length ? { consistency: setConsistency } : {}),
    stats: {
      diagrams: results.length,
      place,
      gap,
      ...(place === "column" ? { nextY: cursorY } : {}),
      ...(place === "row" ? { nextX: cursorX } : {}),
    },
  };
}

function titleOf(spec: Record<string, unknown>, i: number): string {
  const t = spec.title;
  return typeof t === "string" && t.trim() ? t : `#${i + 1}`;
}

/**
 * The one-call draw shared by every diagram tool: proof-read, draw, verify.
 *
 * It exists because each of those used to be a separate MCP call, and a call
 * is a model generation — the expensive part by three orders of magnitude
 * (the server side of all three is milliseconds).
 */
async function drawWithChecks(
  ctx: ToolContext,
  spec: unknown,
  channel: string | undefined,
  run: (spec: unknown) => Promise<unknown>,
): Promise<unknown> {
  const options = readOptions(spec);
  const dryRun = options.dryRun === true;

  // `checkFirst` collapses the two-call dry-run ritual into one: the checker
  // and the layout run here (single-digit ms, no canvas write), and the draw
  // only happens when the model came back clean. A dry run does NOT prove the
  // write path — it returns before the create op is dispatched — so this is
  // about proof-reading, not about probing the bridge.
  if (!dryRun && options.checkFirst === true) {
    const checked = (await run(withOptions(spec, { dryRun: true }))) as DiagramResult;
    if (checked.warnings?.length) {
      return {
        ...checked,
        dryRun: undefined,
        checkedOnly: true,
        hint: "Nothing was drawn: checkFirst was set and the model has findings. Fix them (or drop checkFirst to draw anyway) and call again.",
      };
    }
  }

  const result = (await run(spec)) as DiagramResult;
  if (dryRun || !result.frameId) return result;

  // Fold the render-side check into the draw. `warnings` are SEMANTIC (the
  // model, checked before drawing); `audit` is STRUCTURAL (overflow, clipping,
  // truncation, measured on the canvas after). Two different questions, so
  // they stay two different fields.
  const audit = options.verify === false ? undefined : await auditFrame(ctx, result.frameId, channel);

  // The plugin handed the other diagrams' models back WITH the drawing, so
  // asking whether they agree costs no round trip. Fetching them separately
  // would have cost one per diagram, and five per `diagrams` batch.
  const { pageModel, artboards, ...clean } = result as DiagramResult & {
    pageModel?: StoredDiagram[];
    artboards?: ArtboardRef[];
  };
  const consistency = options.crossCheck === false ? [] : crossCheckAgainst(pageModel);

  // A fourth question, and a fourth field: `warnings` is the model,
  // `audit` the drawing, `consistency` the other diagrams, and this one the
  // ARTBOARDS. Only a sitemap draw sends them back, and `checkCoverage`
  // returns null unless the author is actually naming artboards — so no other
  // kind grows a field it has nothing to say in.
  const coverage =
    options.crossCheck === false || !Array.isArray(artboards) || !Array.isArray(pageModel)
      ? null
      : checkCoverage(pageModel.filter((d) => d && d.spec !== undefined), artboards);

  return {
    ...clean,
    ...(audit ? { audit } : {}),
    ...(consistency.length ? { consistency } : {}),
    ...(coverage ? { coverage } : {}),
  };
}

/**
 * Does the frame just drawn agree with the diagrams already beside it?
 *
 * A THIRD question, so a third field. `warnings` ask whether this model is a
 * legal diagram of its kind; `audit` asks whether the drawing came out
 * legible; `consistency` asks whether it contradicts its neighbours — which no
 * checker reading a single model can see, and which a page of mermaid diagrams
 * can never be asked at all, because there each diagram is an island.
 */
function crossCheckAgainst(
  onPage: StoredDiagram[] | undefined,
): ConsistencyFinding[] {
  if (!Array.isArray(onPage)) return [];
  const usable = onPage.filter((d) => d && d.spec !== undefined);
  // One diagram cannot disagree with anything, so say nothing rather than
  // making every first draw carry an empty field.
  if (usable.length < 2) return [];
  return checkConsistency(usable);
}

/** The artboard list the plugin sends back, defended against an old build. */
function readArtboards(result: unknown): ArtboardRef[] {
  const raw = (result as { artboards?: unknown } | undefined)?.artboards;
  if (!Array.isArray(raw)) return [];
  const out: ArtboardRef[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const a = item as { nodeId?: unknown; name?: unknown };
    if (typeof a.nodeId === "string" && typeof a.name === "string") {
      out.push({ nodeId: a.nodeId, name: a.name });
    }
  }
  return out;
}

interface DiagramResult {
  frameId?: string;
  warnings?: string[];
  [k: string]: unknown;
}

function runDiagramType(
  ctx: ToolContext,
  type: unknown,
  spec: unknown,
  channel?: string,
  /** Redraw into this existing frame, keeping its id, instead of a new one. */
  into?: string,
): Promise<unknown> {
  const call: OpCall = (op, params) =>
    ctx.runValidated(op, params, undefined, channel);
  if (type === "activity") return runActivity(spec, call, undefined, into);
  if (type === "erd") return runErd(spec, call, undefined, into);
  if (type === "sequence") return runSequence(spec, call, undefined, into);
  if (type === "state") return runState(spec, call, undefined, into);
  if (type === "sitemap") return runSitemap(spec, call, undefined, into);
  if (type === "userflow") return runUserflow(spec, call, undefined, into);
  if (typeof type === "string" && isProFeature(type)) {
    const pro = proFeatureMessage(`figma_diagram type:"${type}"`);
    throw new OpError(ErrorCode.INVALID_PARAMS, pro.message, pro.hint);
  }
  const supported = [
    'type:"activity" (a business process)',
    'type:"erd" (a data model)',
    'type:"sequence" (an exchange between systems, over time)',
    'type:"sitemap" (the product\'s pages and which one contains which)',
    'type:"state" (the lifecycle of one entity)',
    'type:"userflow" (the screens a user moves through)',
  ];
  throw new OpError(
    ErrorCode.INVALID_PARAMS,
    `Unknown diagram type ${JSON.stringify(type)}.`,
    `Supported: ${supported.join(", ")}.`,
  );
}

function readOptions(spec: unknown): Record<string, unknown> {
  if (!spec || typeof spec !== "object") return {};
  const o = (spec as Record<string, unknown>).options;
  return o && typeof o === "object" ? (o as Record<string, unknown>) : {};
}

function withOptions(spec: unknown, extra: Record<string, unknown>): unknown {
  const base = spec && typeof spec === "object" ? (spec as Record<string, unknown>) : {};
  return { ...base, options: { ...readOptions(spec), ...extra } };
}

/**
 * layout_audit on the frame just drawn, reduced to what an agent acts on. A
 * clean frame costs one line instead of a records array — the whole point of
 * folding it in is that it stops being a round trip, not that it gets chatty.
 */
export async function auditFrame(
  ctx: ToolContext,
  frameId: string,
  channel?: string,
): Promise<Record<string, unknown>> {
  try {
    const raw = (await ctx.runValidated("layout_audit", { nodeId: frameId }, undefined, channel)) as
      | { nodeCount?: number; summary?: { issues?: unknown[]; styleHints?: unknown[] } }
      | undefined;
    const issues = (raw?.summary?.issues ?? []).map(String);
    const styleHints = (raw?.summary?.styleHints ?? []).map(String);
    const nodeCount = raw?.nodeCount ?? 0;
    if (!issues.length && !styleHints.length) return { nodeCount, clean: true };
    return {
      nodeCount,
      ...(issues.length ? { issues } : {}),
      ...(styleHints.length ? { styleHints } : {}),
    };
  } catch (err) {
    // A failed verification must not sink a drawing that already landed.
    return { skipped: String(err instanceof Error ? err.message : err) };
  }
}

// ---- figma_rules ----

export async function handleRules(ctx: ToolContext, channel?: string): Promise<string> {
  const [styles, variables, components] = await Promise.allSettled([
    ctx.runValidated("get_styles", {}, undefined, channel),
    ctx.runValidated("get_variables", {}, undefined, channel),
    ctx.runValidated("get_components", {}, undefined, channel),
  ]);

  const lines: string[] = ["# Design-system rule sheet", ""];

  const stylesMd = formatSection(styles, formatStyles);
  const variablesMd = formatSection(variables, formatVariables);
  const componentsMd = formatSection(components, formatComponents);

  lines.push("## Styles");
  lines.push(stylesMd);
  lines.push("");
  lines.push("## Variables");
  lines.push(variablesMd);
  lines.push("");
  lines.push("## Components");
  lines.push(componentsMd);
  lines.push("");

  // An empty rule sheet is a decision point, not a shrug: without this, agents
  // proceed to hardcode a guessed palette (observed live). Tell them exactly
  // what to do instead.
  const empty = (s: string) => s === "_none_";
  if (empty(stylesMd) && empty(variablesMd) && empty(componentsMd)) {
    lines.push("## No design system in this file — set one up BEFORE drawing");
    lines.push(
      [
        "There are no styles, variables or components to reuse. Do NOT silently invent values — that is what makes AI-drawn UI look generic and lifeless (arbitrary font sizes, flat surfaces, dead greys, one harsh shadow). Instead:",
        "1. If the codebase has a `design.md` (or the user gave brand/type/spacing earlier), use THOSE values — they always win.",
        "2. Otherwise DON'T guess. Read `figma_docs(section=\"style\")` — a ready default type scale, 4px spacing grid, tinted palette and layered-elevation ramp, plus the anti-lifeless rules (hierarchy via size+weight+color, in-group < between-group spacing, no #000/#FFF, line-height that shrinks as size grows). It is brand-neutral: change one `color/primary` and the rest still looks right.",
        "3. Apply it once (setupTokens + setupTextStyles from that section), confirm the primary color with the user, then draw by NAME (`textStyle:`, `$color/...`, `tokens:`) — never re-hardcode.",
        "4. After the first screens exist, `figma.generateDesignMd()` produces a `design.md` to save for future sessions.",
      ].join("\n"),
    );
    lines.push("");
  }

  lines.push(
    "> Reuse the above before creating new nodes: figma.applyVariable for colors/numbers.",
  );
  lines.push(
    "> Drawing a multi-screen flow (login/signup, onboarding, checkout…)? The screen list is almost always underspecified. Ask the user first: exact screens & order, the states each needs (empty/loading/error/success), entry variations (social/SSO/OTP/verify-email), platform & frame size, light/dark. One round of questions now beats redrawing every screen. See figma_docs(section=\"rules\") → \"Scope a flow before drawing it\".",
  );

  return lines.join("\n");
}

function formatSection(
  settled: PromiseSettledResult<unknown>,
  fmt: (v: unknown) => string,
): string {
  if (settled.status === "rejected") {
    const err = settled.reason;
    const msg = err instanceof OpError ? `${err.message}${err.hint ? ` (${err.hint})` : ""}` : String(err);
    return `_Could not load: ${msg}_`;
  }
  try {
    return fmt(settled.value);
  } catch {
    return "_none_";
  }
}

function formatStyles(v: unknown): string {
  const groups = v as { paint?: unknown[]; text?: unknown[]; effect?: unknown[] } | unknown[] | undefined;
  if (Array.isArray(groups)) {
    return groups.length ? groups.map((s) => `- ${nameOf(s)}`).join("\n") : "_none_";
  }
  const parts: string[] = [];
  for (const key of ["paint", "text", "effect"] as const) {
    const arr = groups?.[key];
    if (Array.isArray(arr) && arr.length) {
      parts.push(`**${key}**: ${arr.map(nameOf).join(", ")}`);
    }
  }
  return parts.length ? parts.join("\n\n") : "_none_";
}

interface WireVariable {
  name?: string;
  type?: string;
  values?: Record<string, unknown>;
}

/**
 * Render each variable as `name: value` (value from the FIRST/default mode)
 * rather than just its name. get_variables already serializes every mode's
 * value, so printing it here costs a few hundred tokens but saves the agent an
 * entire second get_variables round-trip (a much larger payload) just to learn
 * the hex/number behind a token name it's about to reuse.
 */
function formatVariables(v: unknown): string {
  const collections = (v as { collections?: Array<{ name?: string; modes?: Array<{ name?: string }>; variables?: WireVariable[] }> } | undefined)?.collections;
  if (!Array.isArray(collections) || collections.length === 0) {
    if (Array.isArray(v) && v.length) return v.map((x) => `- ${nameOf(x)}`).join("\n");
    return "_none_";
  }
  return collections
    .map((c) => {
      const modeNames = Array.isArray(c.modes) ? c.modes.map((m) => m?.name).filter(Boolean) : [];
      const modesLabel = modeNames.length ? modeNames.join(", ") : "default";
      const vars = Array.isArray(c.variables) ? c.variables : [];
      if (vars.length === 0) {
        return `- **${c.name ?? "collection"}** (modes: ${modesLabel}): _no variables_`;
      }
      const lines = vars.map((variable) => {
        const value = defaultModeValue(variable, modeNames[0]);
        return value !== undefined
          ? `  - ${variable.name ?? "?"}: ${value}`
          : `  - ${variable.name ?? "?"}`;
      });
      return `- **${c.name ?? "collection"}** (modes: ${modesLabel}):\n${lines.join("\n")}`;
    })
    .join("\n");
}

/** The variable's value in the default (first) mode, formatted for one line. */
function defaultModeValue(variable: WireVariable, firstMode?: string): string | undefined {
  const values = variable.values;
  if (!values || typeof values !== "object") return undefined;
  const key = firstMode && firstMode in values ? firstMode : Object.keys(values)[0];
  if (key === undefined) return undefined;
  const raw = values[key];
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === "object") {
    // alias reference from get_variables: { alias: "VariableID:..." }
    const alias = (raw as { alias?: unknown }).alias;
    return alias ? `→ ${String(alias)}` : JSON.stringify(raw);
  }
  return String(raw);
}

function formatComponents(v: unknown): string {
  const arr = Array.isArray(v) ? v : (v as { components?: unknown[] } | undefined)?.components;
  if (!Array.isArray(arr) || arr.length === 0) return "_none_";
  return arr.map((c) => `- ${nameOf(c)}`).join("\n");
}

function nameOf(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return String(o["name"] ?? o["key"] ?? o["id"] ?? JSON.stringify(o));
  }
  return String(v);
}

// ---- figma_docs ----

export function handleDocs(section: string, level: DocLevel = "full"): string {
  if (!section) {
    return `# figma_docs\n\nAvailable sections: ${DOC_SECTION_NAMES.join(", ")}.\nCall figma_docs({ section: "api" }) etc. Add level:"cheat" for just the call shape.`;
  }
  return getDoc(section, level);
}


export { validateOperation };
