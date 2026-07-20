/**
 * Structural signatures for componentize's copy detection. NO figma globals —
 * pure logic on a minimal tree shape, testable without the plugin runtime.
 *
 * Two nodes are "copies" when their subtrees agree on type, name and child
 * structure. Geometry is deliberately excluded: copies are usually moved, and
 * auto-layout may resize them.
 */

export interface StructNode {
  type: string;
  name: string;
  children?: StructNode[];
}

/** Deterministic signature string of a subtree. */
export function structureSignature(node: StructNode): string {
  const kids = node.children ?? [];
  const inner = kids.map(structureSignature).join(",");
  return `${node.type}:${node.name}(${inner})`;
}

/** Guard against pathological trees; deeper subtrees are cut off. */
export const MAX_SIG_DEPTH = 12;

/** Signature limited to `depth` levels (default MAX_SIG_DEPTH). */
export function structureSignatureAtDepth(
  node: StructNode,
  depth: number = MAX_SIG_DEPTH,
): string {
  if (depth <= 0) return `${node.type}:${node.name}(…)`;
  const kids = node.children ?? [];
  const inner = kids
    .map((k) => structureSignatureAtDepth(k, depth - 1))
    .join(",");
  return `${node.type}:${node.name}(${inner})`;
}
