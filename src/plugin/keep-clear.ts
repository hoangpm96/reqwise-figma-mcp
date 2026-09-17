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
 * the rest try that same offset first, the members placed before it are moved
 * by that offset too, and nodes of the same group never count as obstacles to
 * each other (their relative layout is the caller's design).
 *
 * `allowOverlap: true` opts out — an annotation deliberately laid over a screen.
 */

interface Group {
  dy: number;
  ids: Set<string>;
  /**
   * Members that landed where they were asked, before any member had to move.
   * Held so the first collision can take them along — they are the row's
   * left half, and a row must not come out on two levels.
   */
  before: SceneNode[];
}

const groups = new Map<string, Group>();
const MAX_GROUPS = 32;

function groupFor(key: unknown): Group | undefined {
  if (typeof key !== "string" || !key) return undefined;
  let g = groups.get(key);
  if (!g) {
    g = { dy: 0, ids: new Set(), before: [] };
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
  if (!hit) {
    if (group && group.dy === 0) group.before.push(self);
    return;
  }

  const spot = findFreeSpot(occupied, want, PLACE_GUTTER);
  self.y = spot.y;
  // The first member that has to move sets the group's offset, whichever
  // member that is. This used to require being the group's first member
  // (ids.size === 1, and ids is filled above), so when the first screen of a
  // row happened to land clear, no later one could ever set it: each collider
  // found its own spot and the row came out as a staircase. A member that sat
  // clear before this point used to stay where it was, so a row whose middle
  // screen collided came out on two levels: the left half at the asked y,
  // the rest below. They are known, so they move by the same offset — unless
  // that would put one of them on something, in which case it stays put
  // rather than trade one overlap for another.
  let carried = 0;
  if (group && group.dy === 0) {
    group.dy = spot.y - want.y;
    for (const m of group.before) {
      if (m.removed || m.parent !== parent) continue;
      const box = m as SceneNode & LayoutMixin;
      const at = { x: box.x, y: box.y + group.dy, w: box.width, h: box.height };
      if (occupied.some((r) => boxesOverlap(at, r))) continue;
      box.y = at.y;
      carried++;
    }
    group.before = [];
  }
  ctx.warn(
    `New ${node.type} "${node.name || "(unnamed)"}" overlapped existing "${hit.name}" at (${Math.round(want.x)},${Math.round(want.y)}), so it was moved to (${Math.round(spot.x)},${Math.round(spot.y)}) instead — clear of existing work${carried ? `, and the ${carried} earlier layer${carried === 1 ? "" : "s"} of the same call moved with it so the row stays a row` : ""}. Pick a free x/y, or pass allowOverlap:true to lay it on top on purpose.`,
  );
}
