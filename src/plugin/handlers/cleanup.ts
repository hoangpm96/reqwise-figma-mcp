/// <reference types="@figma/plugin-typings" />
import { HandlerContext } from "../context.js";
import { err } from "../errors.js";
import { ErrorCode } from "../../shared/protocol.js";

/**
 * Cleanup ops: delete a page, delete a local style, and sweep the local
 * styles nothing uses. Each one is gated the same way delete_variable is —
 * losing work takes an explicit second step, never a default.
 */

// ---- delete_page ----

/**
 * delete_page: remove a whole page. Figma refuses to remove the last page or
 * the page the user is on ("Removing this node is not allowed"), so the last
 * page is refused up front and the current page is switched away from first.
 * A page that still holds layers needs force:true.
 */
export async function deletePage(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  await figma.loadAllPagesAsync?.();
  const page = resolvePage(p.page ?? p.pageId ?? p.name);
  const pages = figma.root.children;
  if (pages.length <= 1) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      `"${page.name}" is the only page — a Figma file needs at least one.`,
      "Create another page first, or delete the layers on this one instead.",
    );
  }
  await page.loadAsync?.();
  const layers = page.children.length;
  const components = countComponents(page);
  if (layers > 0 && p.force !== true) {
    const names = page.children.slice(0, 5).map((n) => n.name);
    throw err(
      ErrorCode.CONFIRM_REQUIRED,
      `Page "${page.name}" still has ${layers} top-level layer(s)` +
        (components > 0 ? `, including ${components} component(s)` : "") +
        ` (${names.join(", ")}${layers > names.length ? ", …" : ""}).`,
      "Confirm with the user that this page's content can go, then re-run with force:true.",
    );
  }

  let switchedTo: string | undefined;
  if (figma.currentPage.id === page.id) {
    const index = pages.indexOf(page);
    const next = pages[index + 1] ?? pages[index - 1]!;
    if (typeof figma.setCurrentPageAsync === "function") await figma.setCurrentPageAsync(next);
    else figma.currentPage = next;
    if (figma.currentPage.id === page.id) {
      throw err(
        ErrorCode.INTERNAL,
        `Could not leave "${page.name}" before deleting it.`,
        "Switch to another page in the Figma UI, then retry.",
      );
    }
    switchedTo = next.name;
  }

  const id = page.id;
  const name = page.name;
  page.remove();
  if (figma.root.children.some((c) => c.id === id)) {
    throw err(
      ErrorCode.INTERNAL,
      `Page "${name}" is still in the file after remove().`,
      "Delete it from the Pages panel in the Figma UI.",
    );
  }
  commitUndo();
  return {
    deleted: name,
    id,
    layersRemoved: layers,
    ...(components > 0
      ? {
          note: `${components} component(s) went with the page; their instances elsewhere stay and can "Restore component".`,
        }
      : {}),
    ...(switchedTo ? { switchedTo } : {}),
  };
}

function resolvePage(ref: unknown): PageNode {
  const query = typeof ref === "string" ? ref.trim() : "";
  const pages = figma.root.children;
  const byId = pages.find((pg) => pg.id === query);
  if (byId) return byId;
  const matches = pages.filter((pg) => pg.name.toLowerCase() === query.toLowerCase());
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      `${matches.length} pages are named "${query}".`,
      `Pass the page id instead: ${matches.map((pg) => pg.id).join(", ")}.`,
    );
  }
  throw err(
    ErrorCode.NODE_NOT_FOUND,
    `No page "${query}".`,
    `Pages in this file: ${pages.map((pg) => `${pg.name} (${pg.id})`).join(", ")}.`,
  );
}

function countComponents(page: PageNode): number {
  let count = 0;
  const stack: BaseNode[] = [...page.children];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.type === "COMPONENT" || n.type === "COMPONENT_SET") {
      count++;
      continue; // a set's variants are counted once, as the set
    }
    if ("children" in n) stack.push(...(n as ChildrenMixin).children);
  }
  return count;
}

// ---- styles: lookup + usage scan ----

export type StyleKind = "PAINT" | "TEXT" | "EFFECT" | "GRID";
const KINDS: StyleKind[] = ["PAINT", "TEXT", "EFFECT", "GRID"];

async function localStyles(kind: StyleKind): Promise<BaseStyle[]> {
  switch (kind) {
    case "PAINT":
      return figma.getLocalPaintStylesAsync();
    case "TEXT":
      return figma.getLocalTextStylesAsync();
    case "EFFECT":
      return figma.getLocalEffectStylesAsync();
    case "GRID":
      return figma.getLocalGridStylesAsync();
  }
}

function toKinds(value: unknown): StyleKind[] {
  if (value === undefined) return KINDS;
  const list = Array.isArray(value) ? value : [value];
  return list.map((v) => {
    const kind = String(v).toUpperCase();
    if (!(KINDS as string[]).includes(kind)) {
      throw err(
        ErrorCode.INVALID_PARAMS,
        `Unknown style type "${String(v)}".`,
        "Use PAINT, TEXT, EFFECT or GRID.",
      );
    }
    return kind as StyleKind;
  });
}

/** A local style by id or exact (case-insensitive) name. */
async function resolveStyle(ref: unknown, type: unknown): Promise<BaseStyle> {
  const query = typeof ref === "string" ? ref.trim() : "";
  const kinds = toKinds(type);
  const all = (await Promise.all(kinds.map(localStyles))).flat();
  const byId = all.find((s) => s.id === query);
  if (byId) return byId;
  if (query.startsWith("S:")) {
    const remote = await figma.getStyleByIdAsync(query);
    if (remote?.remote) {
      throw err(
        ErrorCode.UNSUPPORTED_OPERATION,
        `Style "${remote.name}" comes from a library and is read-only here.`,
        "Delete it in the file that publishes the library.",
      );
    }
  }
  const matches = all.filter((s) => s.name.toLowerCase() === query.toLowerCase());
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      `${matches.length} styles are named "${query}" (${matches.map((s) => s.type).join(", ")}).`,
      "Pass type: PAINT|TEXT|EFFECT|GRID, or the style id.",
    );
  }
  throw err(
    ErrorCode.NODE_NOT_FOUND,
    `No local style "${query}".`,
    "List styles with figma_read get_styles.",
  );
}

const STYLE_FIELDS = [
  "fillStyleId",
  "strokeStyleId",
  "textStyleId",
  "effectStyleId",
  "gridStyleId",
] as const;
type StyleField = (typeof STYLE_FIELDS)[number];

export interface StyleUsage {
  node: SceneNode;
  field: StyleField;
  /** Set when the style covers only part of a text layer. */
  range?: { start: number; end: number };
}

/**
 * Every node field in the document that points at a style, grouped by style
 * id. One walk serves both a single delete and the unused sweep. Our own
 * walk, not getStyleConsumersAsync: that call has been reported to never
 * resolve, and a hung usage check is the one place we cannot fail open.
 */
export async function scanStyleUsages(ctx: HandlerContext): Promise<Map<string, StyleUsage[]>> {
  await figma.loadAllPagesAsync?.();
  const out = new Map<string, StyleUsage[]>();
  const add = (id: string, usage: StyleUsage): void => {
    const list = out.get(id);
    if (list) list.push(usage);
    else out.set(id, [usage]);
  };
  const stack: SceneNode[] = [];
  for (const page of figma.root.children) stack.push(...page.children);
  let visited = 0;
  while (stack.length > 0) {
    const n = stack.pop()!;
    visited++;
    if (visited % 500 === 0) ctx.progress(visited, visited + stack.length, "scanning style usages");
    const o = n as unknown as Record<StyleField, unknown>;
    for (const field of STYLE_FIELDS) {
      if (!(field in n)) continue;
      const value = o[field];
      if (typeof value === "string") {
        if (value) add(value, { node: n, field });
      } else if (value === figma.mixed && n.type === "TEXT" && (field === "fillStyleId" || field === "textStyleId")) {
        for (const seg of (n as TextNode).getStyledTextSegments([field])) {
          const id = (seg as unknown as Record<StyleField, string>)[field];
          if (id) add(id, { node: n, field, range: { start: seg.start, end: seg.end } });
        }
      }
    }
    if ("children" in n) stack.push(...(n as ChildrenMixin).children);
  }
  return out;
}

async function rebind(usage: StyleUsage, style: BaseStyle): Promise<void> {
  const node = usage.node as unknown as Record<string, unknown>;
  if (usage.field === "textStyleId") {
    await figma.loadFontAsync((style as TextStyle).fontName);
    const text = usage.node as TextNode;
    const fonts = usage.range
      ? text.getRangeAllFontNames(usage.range.start, usage.range.end)
      : text.getRangeAllFontNames(0, text.characters.length);
    for (const f of fonts) await figma.loadFontAsync(f);
  }
  const suffix = usage.field.charAt(0).toUpperCase() + usage.field.slice(1); // FillStyleId
  if (usage.range) {
    const fn = node[`setRange${suffix}Async`] ?? node[`setRange${suffix}`];
    await (fn as (s: number, e: number, id: string) => unknown).call(
      usage.node,
      usage.range.start,
      usage.range.end,
      style.id,
    );
  } else if (typeof node[`set${suffix}Async`] === "function") {
    await (node[`set${suffix}Async`] as (id: string) => Promise<void>).call(usage.node, style.id);
  } else {
    node[usage.field] = style.id;
  }
}

function commitUndo(): void {
  (figma as { commitUndo?: () => void }).commitUndo?.();
}

// ---- delete_style ----

/**
 * delete_style: remove one local style. Like delete_variable it is
 * replace-gated — a style still applied somewhere is refused unless the
 * caller passes replaceWith (rebind every layer to another style of the same
 * type first) or force:true (the layers keep their look, the link is lost).
 */
export async function deleteStyle(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const style = await resolveStyle(p.style ?? p.name ?? p.styleId, p.type);
  let replaceWith: BaseStyle | null = null;
  if (p.replaceWith !== undefined) {
    replaceWith = await resolveStyle(p.replaceWith, style.type);
    if (replaceWith.id === style.id) {
      throw err(ErrorCode.INVALID_PARAMS, "replaceWith is the style being deleted.");
    }
  }

  const usages = (await scanStyleUsages(ctx)).get(style.id) ?? [];
  if (usages.length > 0 && !replaceWith && p.force !== true) {
    const layers = new Set(usages.map((u) => u.node.id)).size;
    throw err(
      ErrorCode.COMPONENT_IN_USE,
      `Style "${style.name}" is applied on ${layers} layer(s); deleting it unlinks them.`,
      "Pass replaceWith: <style name/id> to move those layers to another style first, or force: true to delete anyway (the layers keep their look but lose the style link).",
    );
  }

  let rebound = 0;
  const reboundFailed: string[] = [];
  if (replaceWith) {
    for (const u of usages) {
      try {
        await rebind(u, replaceWith);
        rebound++;
      } catch (e) {
        reboundFailed.push(`${u.node.id}.${u.field}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (reboundFailed.length > 0 && p.force !== true) {
      throw err(
        ErrorCode.INTERNAL,
        `Moved ${rebound} of ${usages.length} usage(s) to "${replaceWith.name}"; ${reboundFailed.length} failed, so "${style.name}" was kept.`,
        `Failures: ${reboundFailed.slice(0, 5).join("; ")}. Fix them or re-run with force:true.`,
      );
    }
  }

  const { name, id, type } = style;
  style.remove();
  commitUndo();
  return {
    deleted: name,
    id,
    type,
    usagesFound: usages.length,
    rebound,
    reboundFailed,
    ...(replaceWith ? { replacedWith: replaceWith.name } : {}),
  };
}

// ---- delete_unused_styles ----

/**
 * delete_unused_styles: sweep local styles no layer uses. Two calls, always.
 * Without `confirm` it only returns the list and a confirmToken; deleting
 * needs that token back. The token is a hash of the exact styles in the
 * list, so if the file changed between the two calls (a style got used,
 * another went unused) the token no longer matches and nothing is deleted.
 */
export async function deleteUnusedStyles(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const kinds = toKinds(p.types ?? p.type);
  const keep = new Set(
    (Array.isArray(p.keep) ? p.keep : []).map((k) => String(k).toLowerCase()),
  );
  const usages = await scanStyleUsages(ctx);
  const unused: BaseStyle[] = [];
  let inUse = 0;
  let kept = 0;
  for (const kind of kinds) {
    for (const style of await localStyles(kind)) {
      if (usages.has(style.id)) inUse++;
      else if (keep.has(style.name.toLowerCase()) || keep.has(style.id.toLowerCase())) kept++;
      else unused.push(style);
    }
  }
  const confirmToken = tokenFor(unused);
  const list = unused.map((s) => ({ name: s.name, type: s.type, id: s.id }));
  const caveat =
    "Only this file is scanned. If this file publishes a library, other files may still use these styles.";

  if (p.confirm === undefined) {
    return {
      preview: true,
      wouldDelete: list,
      count: list.length,
      inUse,
      kept,
      confirmToken,
      caveat,
      next:
        list.length === 0
          ? "Nothing to delete."
          : "Nothing was deleted. Show the user this exact list, ask them to confirm deleting it, and only after an explicit yes re-run with confirm: <confirmToken>.",
    };
  }
  if (p.confirm !== confirmToken) {
    throw err(
      ErrorCode.CONFIRM_REQUIRED,
      "The unused-style list changed since the preview (or the token is wrong); nothing was deleted.",
      "Run delete_unused_styles again without confirm, show the user the new list, and confirm with the new token.",
    );
  }
  const deleted: string[] = [];
  const failed: string[] = [];
  for (const style of unused) {
    // Read the name first: a removed style throws on every property access.
    const name = style.name;
    try {
      style.remove();
      deleted.push(name);
    } catch (e) {
      failed.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  commitUndo();
  return { deleted, count: deleted.length, failed, inUse, kept };
}

/** djb2 over the sorted style ids — stable, and changes if the set does. */
export function tokenFor(styles: BaseStyle[]): string {
  const text = styles.map((s) => s.id).sort().join("|");
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  return `del-${styles.length}-${hash.toString(36)}`;
}
