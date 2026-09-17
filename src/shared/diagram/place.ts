/**
 * Where a NEW diagram frame is allowed to land.
 *
 * Every kind defaults to `x: 0, y: 0`, and a real Figma page almost always has
 * something at its origin — so the first diagram drawn into somebody's working
 * file landed squarely on top of their screens. Nothing was destroyed (a frame
 * is a sibling, not a paint bucket), but the artwork underneath was hidden,
 * which is indistinguishable from destroyed until you drag the diagram off it.
 *
 * The rule is deliberately dull, because the caller has to be able to predict
 * it: keep the x you asked for, and slide DOWN until the box is clear. That
 * turns a page into a column of diagrams under the existing work rather than a
 * pile on top of it, and re-running the same draw twice puts the second one
 * under the first instead of over it.
 *
 * It is pure and lives here, not in the plugin, for the usual reason: the
 * plugin only draws. It is also what makes the behaviour testable without a
 * canvas.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Only for the message — which node was in the way. */
  name?: string;
}

/**
 * The breathing room kept between a diagram and anything already on the page.
 * Wide enough that the two read as separate objects rather than as one badly
 * aligned group.
 */
export const PLACE_GUTTER = 120;

export interface FreeSpot {
  x: number;
  y: number;
  /** True when the wanted spot was taken and this is somewhere else. */
  moved?: boolean;
  /** What was in the way, for the warning. Only set when `moved`. */
  blockedBy?: string;
}

function hits(a: Rect, b: Rect, gutter: number): boolean {
  return (
    a.x < b.x + b.w + gutter &&
    a.x + a.w + gutter > b.x &&
    a.y < b.y + b.h + gutter &&
    a.y + a.h + gutter > b.y
  );
}

/**
 * The first clear spot at or below `want`, keeping its x.
 *
 * Each pass drops below the lowest box it collided with, so it converges in as
 * many passes as there are stacked obstacles rather than crawling pixel by
 * pixel. A zero-area obstacle is ignored — a collapsed node is not something a
 * reader can see being covered.
 */
export function findFreeSpot(occupied: Rect[], want: Rect, gutter = PLACE_GUTTER): FreeSpot {
  const real = occupied.filter((r) => r.w > 0 && r.h > 0);
  let y = want.y;
  let blockedBy: string | undefined;
  // One pass per obstacle is the worst case: every pass clears at least the
  // lowest box it hit, and a box cleared cannot be hit again.
  for (let guard = 0; guard <= real.length; guard++) {
    const box = { ...want, y };
    const blocking = real.filter((r) => hits(r, box, gutter));
    if (!blocking.length) {
      return y === want.y ? { x: want.x, y } : { x: want.x, y, moved: true, ...(blockedBy ? { blockedBy } : {}) };
    }
    // Name the FIRST thing that was in the way, not the last: that is the one
    // the caller was about to cover, and the one they will recognise.
    if (blockedBy === undefined) blockedBy = blocking[0]!.name ?? "an existing layer";
    y = Math.max(...blocking.map((r) => r.y + r.h)) + gutter;
  }
  return { x: want.x, y, moved: true, ...(blockedBy ? { blockedBy } : {}) };
}
