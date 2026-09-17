/// <reference types="@figma/plugin-typings" />
import { HandlerContext, requireNode } from "../context.js";
import { resolveParent, insertInto } from "../insert.js";
import { serializeNode } from "../serialize.js";
import { buildChildMap, MiniNode } from "../tree-walk.js";
import { InsertAt } from "../layout-math.js";
import { keepClearOnCanvas } from "../keep-clear.js";

/** Convert a figma node subtree into the minimal shape for buildChildMap. */
function toMini(node: BaseNode): MiniNode {
  const mini: MiniNode = { id: node.id };
  if ("children" in node) {
    const kids = (node as ChildrenMixin).children;
    if (kids.length > 0) mini.children = kids.map(toMini);
  }
  return mini;
}

/** node.clone() with reparent/insertAt + original→clone id map. */
export async function clone(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const node = await requireNode(p.nodeId ?? p.id);
  const cloned = node.clone();

  if (p.parentId !== undefined) {
    const parent = await resolveParent(p.parentId);
    insertInto(parent, cloned, p.insertAt as InsertAt | undefined);
  } else if (node.parent && "insertChild" in node.parent) {
    insertInto(node.parent as BaseNode & ChildrenMixin, cloned, p.insertAt as InsertAt | undefined);
  }
  if (typeof p.name === "string") cloned.name = p.name;
  if (typeof p.x === "number" && "x" in cloned) (cloned as LayoutMixin).x = p.x;
  if (typeof p.y === "number" && "y" in cloned) (cloned as LayoutMixin).y = p.y;
  // A clone lands exactly on its original; on a page that is never the intent.
  keepClearOnCanvas(cloned, p, ctx);

  const childMap = buildChildMap(toMini(node), toMini(cloned));
  return { id: cloned.id, childMap, node: serializeNode(cloned, "compact") };
}
