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

/** Resolve a node id (async, dynamic-page safe) or throw NODE_NOT_FOUND. */
export async function requireNode(id: unknown): Promise<SceneNode> {
  if (typeof id !== "string" || id.length === 0) {
    throw nodeNotFound(String(id));
  }
  const node = await figma.getNodeByIdAsync(id);
  if (!node || node.type === "DOCUMENT" || node.type === "PAGE") {
    throw nodeNotFound(id);
  }
  return node as SceneNode;
}

/** Resolve a node id but allow PAGE/DOCUMENT for reads. */
export async function findNode(id: unknown): Promise<BaseNode | null> {
  if (typeof id !== "string" || id.length === 0) return null;
  return figma.getNodeByIdAsync(id);
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
