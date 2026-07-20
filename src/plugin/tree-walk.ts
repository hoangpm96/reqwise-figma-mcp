/**
 * Pure parallel tree-walk to build a childMap from an original subtree to a
 * cloned subtree. NO figma globals — operates on a minimal tree shape so it is
 * unit-testable and reused by clone / create_variants.
 */

export interface MiniNode {
  id: string;
  children?: readonly MiniNode[];
}

/**
 * Walk two structurally-parallel trees, mapping original id → clone id.
 * Assumes clone preserves child order and count (Figma's node.clone() does).
 * Includes the roots. If structures diverge, mapping stops at the divergence
 * for that branch (defensive — never throws).
 */
export function buildChildMap(
  original: MiniNode,
  clone: MiniNode,
): Record<string, string> {
  const map: Record<string, string> = {};
  const stack: Array<[MiniNode, MiniNode]> = [[original, clone]];
  while (stack.length > 0) {
    const [o, c] = stack.pop() as [MiniNode, MiniNode];
    map[o.id] = c.id;
    const oc = o.children ?? [];
    const cc = c.children ?? [];
    const n = Math.min(oc.length, cc.length);
    for (let i = 0; i < n; i++) {
      stack.push([oc[i]!, cc[i]!]);
    }
  }
  return map;
}
