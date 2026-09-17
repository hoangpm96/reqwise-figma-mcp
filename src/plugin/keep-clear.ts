import type { HandlerContext } from "./context.js";
import { findFreeSpot, PLACE_GUTTER, type Rect } from "../shared/diagram/place.js";
import { boxesOverlap } from "./layout-math.js";

/**
 * A node that lands straight on a page (or a section) must not cover what is
 * already there.
 *
 * This used to be a warning, and only when the caller passed no x/y. Agents
 * read past warnings, and the overlaps users actually found came from explicit
 * coordinates guessed without looking at the canvas — so the node is now MOVED:
 * keep its x, slide down until it is clear, say where it went. The same rule
 * diagrams already follow (see shared/diagram/place.ts), so every tool puts
 * new work in the same predictable place.
 *
 * Detection is a real overlap, not a gutter: a screen drawn 40px beside the
 * previous one is a row, not a collision. Only once something is covered does
 * the new spot keep the full gutter away from it.
 *
 * `placeGroup` keeps one figma_write call's layout intact. Six screens drawn
 * as a row must move as a row: the first one that has to move sets the offset,
 * the rest try that same offset first, and nodes of the same group never count
 * as obstacles to each other (their relative layout is the caller's design).
 *
 * `allowOverlap: true` opts out — an annotation deliberately laid over a screen.
 */

interface Group {
  dy: number;
  ids: Set<string>;
}

const groups = new Map<string, Group>();
const MAX_GROUPS = 32;

function groupFor(key: unknown): Group | undefined {
  if (typeof key !== "string" || !key) return undefined;
  let g = groups.get(key);
  if (!g) {
    g = { dy: 0, ids: new Set() };
    groups.set(key, g);
    // A Map iterates in insertion order: the first key is the oldest run.
    if (groups.size > MAX_GROUPS) groups.delete(groups.keys().next().value as string);
  }
  return g;
}

/** Test seam: forget every group. */
export function resetKeepClearGroups(): void {
  groups.clear();
}

function isCanvas(parent: BaseNode | null): boolean {
  return !!parent && (parent.type === "PAGE" || parent.type === "SECTION");
}

export function keepClearOnCanvas(node: SceneNode, p: Record<string, unknown>, ctx: HandlerContext): void {
  if (p.allowOverlap === true) return;
  const parent = node.parent;
  if (!isCanvas(parent)) return;
  if (!("x" in node) || !("width" in node)) return;
  const self = node as SceneNode & LayoutMixin;
  if (!(self.width > 0) || !(self.height > 0)) return;

  const group = groupFor(p.placeGroup);
  const occupied: Rect[] = [];
  for (const sib of (parent as ChildrenMixin).children as readonly SceneNode[]) {
    if (sib.id === node.id || sib.visible === false) continue;
    if (group?.ids.has(sib.id)) continue;
    if (!("x" in sib) || !("width" in sib)) continue;
    const s = sib as SceneNode & LayoutMixin;
    if (!(s.width > 0) || !(s.height > 0)) continue;
    occupied.push({ x: s.x, y: s.y, w: s.width, h: s.height, name: s.name });
  }
  group?.ids.add(node.id);

  const want = { x: self.x, y: self.y, w: self.width, h: self.height };
  const covers = (y: number) => occupied.find((r) => boxesOverlap({ ...want, y }, r));

  // The group already moved: follow it, so a row stays a row.
  if (group && group.dy !== 0 && !covers(want.y + group.dy)) {
    self.y = want.y + group.dy;
    return;
  }
  const hit = covers(want.y);
  if (!hit) return;

  const spot = findFreeSpot(occupied, want, PLACE_GUTTER);
  self.y = spot.y;
  // Only the first mover sets the group's offset; members already placed at
  // their own spot cannot follow a later one.
  if (group && group.dy === 0 && group.ids.size === 1) group.dy = spot.y - want.y;
  ctx.warn(
    `New ${node.type} "${node.name || "(unnamed)"}" overlapped existing "${hit.name}" at (${Math.round(want.x)},${Math.round(want.y)}), so it was moved to (${Math.round(spot.x)},${Math.round(spot.y)}) instead — clear of existing work. Pick a free x/y, or pass allowOverlap:true to lay it on top on purpose.`,
  );
}
