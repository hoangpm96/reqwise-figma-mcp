/// <reference types="@figma/plugin-typings" />
import { nodeNotFound } from "./errors.js";

/**
 * Per-request context handed to every handler. Collects warnings and posts
 * progress. `params` is the validated (server-side) params object; the plugin
 * still treats it defensively.
 */
export interface HandlerContext {
  params: Record<string, unknown>;
  warnings: string[];
  /** Emit a progress ping to the server (resets the op timeout). */
  progress(done: number, total: number, note?: string): void;
  warn(msg: string): void;
}

export function makeContext(
  params: Record<string, unknown>,
  emitProgress: (done: number, total: number, note?: string) => void,
): HandlerContext {
  const warnings: string[] = [];
  return {
    params,
    warnings,
    progress: emitProgress,
    warn(msg: string) {
      if (!warnings.includes(msg)) warnings.push(msg);
    },
  };
}

// `documentAccess: "dynamic-page"` keeps only the current page in memory, and
// a getNodeByIdAsync for a node on an UNLOADED page does not fail — it hangs
// until Figma gives up ~10s in with "Unable to establish connection to Figma
// after 10 seconds": a network message for a page-loading bug, which sends
// you debugging the wrong layer entirely. 2500ms is comfortably past any
// healthy lookup but well under that dead end.
const LOOKUP_SETTLE_MS = 2500;

// The cure is loadAllPagesAsync, paid once per plugin run — pages stay
// loaded. Held as a promise so lookups that stall together share the one
// load; a failed load is forgotten so the next stall can try again.
let allPagesLoaded: Promise<unknown> | null = null;

/**
 * figma.getNodeByIdAsync that survives unloaded pages. A lookup still pending
 * after LOOKUP_SETTLE_MS is assumed to reach into an unloaded page: every
 * page is loaded once, then the lookup is retried. When the retry also fails,
 * Figma's own error propagates — at that point it is honest.
 */
export async function getNodeByIdSafe(id: string): Promise<BaseNode | null> {
  const lookup = figma.getNodeByIdAsync(id);
  // The abandoned lookup keeps pending after the race is lost; swallow its
  // late rejection so it never surfaces as an unhandled rejection.
  lookup.catch(() => {});
  const stalled = Symbol("lookup stalled");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: BaseNode | null | typeof stalled;
  try {
    result = await Promise.race([
      lookup,
      new Promise<typeof stalled>((resolve) => {
        timer = setTimeout(() => resolve(stalled), LOOKUP_SETTLE_MS);
      }),
    ]);
  } finally {
    // Every handler lookup goes through here; a timer left behind per call
    // keeps the plugin's event loop busy for nothing.
    clearTimeout(timer);
  }
  if (result !== stalled) return result;
  if (!allPagesLoaded) {
    // `?.`: a runtime without loadAllPagesAsync (older Figma, test mocks)
    // falls through to the retry — the only load it gets.
    allPagesLoaded = Promise.resolve(figma.loadAllPagesAsync?.());
    allPagesLoaded.catch(() => {
      allPagesLoaded = null;
    });
  }
  await allPagesLoaded;
  return figma.getNodeByIdAsync(id);
}

/** Resolve a node id (async, dynamic-page safe) or throw NODE_NOT_FOUND. */
export async function requireNode(id: unknown): Promise<SceneNode> {
  if (typeof id !== "string" || id.length === 0) {
    throw nodeNotFound(String(id));
  }
  const node = await getNodeByIdSafe(id);
  if (!node || node.type === "DOCUMENT" || node.type === "PAGE") {
    throw nodeNotFound(id);
  }
  return node as SceneNode;
}

/** Resolve a node id but allow PAGE/DOCUMENT for reads. */
export async function findNode(id: unknown): Promise<BaseNode | null> {
  if (typeof id !== "string" || id.length === 0) return null;
  return getNodeByIdSafe(id);
}

/** Does a node accept children? */
export function isParentNode(node: BaseNode): node is BaseNode & ChildrenMixin {
  return "children" in node && "appendChild" in node;
}

/** True when node has an explicit width property (frame/instance/etc). */
export function hasFixedWidth(node: BaseNode): boolean {
  if (!("width" in node)) return false;
  // Auto-layout frames with HUG width do not have a "fixed" width.
  if ("layoutMode" in node && (node as FrameNode).layoutMode !== "NONE") {
    const f = node as FrameNode;
    if (f.primaryAxisSizingMode === "AUTO" && f.layoutMode === "HORIZONTAL") {
      return false;
    }
    if (f.counterAxisSizingMode === "AUTO" && f.layoutMode === "VERTICAL") {
      return false;
    }
  }
  return true;
}
