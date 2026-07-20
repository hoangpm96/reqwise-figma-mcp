/// <reference types="@figma/plugin-typings" />
import { resolveInsertIndex, InsertAt } from "./layout-math.js";
import { isParentNode } from "./context.js";
import { err } from "./errors.js";
import { ErrorCode } from "../shared/protocol.js";

/**
 * Append/insert `node` into `parent` honouring an insertAt spec.
 * The node may already live elsewhere; appendChild/insertChild reparents it.
 */
export function insertInto(
  parent: BaseNode & ChildrenMixin,
  node: SceneNode,
  insertAt: InsertAt | undefined,
): void {
  // Ids of the parent's current children EXCLUDING node (it may be moving in).
  const childIds = parent.children
    .filter((c) => c.id !== node.id)
    .map((c) => c.id);
  const index = resolveInsertIndex(insertAt, childIds);
  parent.insertChild(index, node);
}

/**
 * Resolve the parent for a create/move: explicit parentId, else current page.
 */
export async function resolveParent(
  parentId: unknown,
): Promise<BaseNode & ChildrenMixin> {
  if (typeof parentId === "string" && parentId.length > 0) {
    const p = await figma.getNodeByIdAsync(parentId);
    if (!p) {
      throw err(
        ErrorCode.NODE_NOT_FOUND,
        `Parent node "${parentId}" not found.`,
        "Pass a valid container node id (FRAME/GROUP/PAGE/COMPONENT) or omit parentId to use the current page.",
      );
    }
    if (!isParentNode(p)) {
      throw err(
        ErrorCode.INVALID_PARAMS,
        `Node "${parentId}" (${p.type}) cannot contain children.`,
        "Choose a FRAME, GROUP, COMPONENT, SECTION or PAGE as the parent.",
      );
    }
    return p;
  }
  return figma.currentPage;
}
