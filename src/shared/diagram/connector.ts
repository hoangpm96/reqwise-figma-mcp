/**
 * The orthogonal connector: a line between two chosen points on two boxes.
 *
 * The routers in userflow/ and activity/ pick their own connection points from
 * the geometry, and their paths are shaped by what they know (rank corridors,
 * lane gutters). This module handles the other case — somebody has SAID where
 * the line should attach, by dragging its end in Figma or by passing a port on
 * the edge — and the line has to leave that face, arrive at that face, and
 * still be a sane orthogonal path in between. That is the draw.io behaviour:
 * move the arrow head, the line reconnects.
 *
 * Every case is solved in a local frame rotated so the exit direction is +x,
 * which cuts the case table to a quarter of its size.
 */
import type { Placement } from "./types.js";
import { simplify, type Axis, type Pt } from "./geometry.js";

export type Side = "top" | "right" | "bottom" | "left";

/** A connection point: which face, and how far along it (0..1). */
export interface Port {
  side: Side;
  at: number;
}

/** How far a line runs straight out of a face before it may turn. */
const STUB = 22;
/** Sideways room a U-turn detour takes when there is no straight way round. */
const DETOUR = 44;

export const SIDES: Side[] = ["top", "right", "bottom", "left"];

/** The point on the box where a port sits. `at` runs left→right / top→bottom. */
export function portPoint(box: Placement, port: Port): Pt {
  const at = clamp01(port.at);
  switch (port.side) {
    case "top":
      return [box.x + box.w * at, box.y];
    case "bottom":
      return [box.x + box.w * at, box.y + box.h];
    case "left":
      return [box.x, box.y + box.h * at];
    default:
      return [box.x + box.w, box.y + box.h * at];
  }
}

/** Unit vector pointing OUT of that face. */
export function outward(side: Side): Pt {
  switch (side) {
    case "top":
      return [0, -1];
    case "bottom":
      return [0, 1];
    case "left":
      return [-1, 0];
    default:
      return [1, 0];
  }
}

/**
 * An orthogonal path from one port to the other: it leaves perpendicular to
 * the source's face and arrives perpendicular to the target's, which is what
 * makes an arrow look attached rather than dropped nearby.
 */
export function connectPorts(
  from: { box: Placement; port: Port },
  to: { box: Placement; port: Port },
): Pt[] {
  const p0 = portPoint(from.box, from.port);
  const p1 = portPoint(to.box, to.port);
  const d0 = outward(from.port.side);
  // Travel direction INTO the target is the opposite of its outward normal.
  const d1: Pt = [-outward(to.port.side)[0], -outward(to.port.side)[1]];

  const f = frameFor(d0);
  const a = f.to(p0);
  const b = f.to(p1);
  const dir = f.to(d1);
  const local = join(a, b, dir[0]! > 0.5 ? "+x" : dir[0]! < -0.5 ? "-x" : dir[1]! > 0.5 ? "+y" : "-y");
  return simplify(local.map(f.from));
}

type Dir = "+x" | "-x" | "+y" | "-y";

/**
 * Join two points in a frame where the line MUST leave `a` heading +x and
 * arrive at `b` heading `dir`. Each branch prefers the shortest shape that
 * satisfies both directions and falls back to a detour when the geometry
 * leaves no room for it.
 */
function join(a: Pt, b: Pt, dir: Dir): Pt[] {
  const [ax, ay] = a;
  const [bx, by] = b;
  const out = ax + STUB;
  const path: Pt[] = [a, [out, ay]];

  if (dir === "+x") {
    const back = bx - STUB;
    if (Math.abs(by - ay) < 0.5 && back >= out) return [a, b];
    if (back > out) {
      const mid = (out + back) / 2;
      path.push([mid, ay], [mid, by], [back, by]);
    } else {
      // The target is behind us: go out, step aside, come back past it.
      const aside = by + (by >= ay ? DETOUR : -DETOUR);
      path.push([out, aside], [back - DETOUR, aside], [back - DETOUR, by], [back, by]);
    }
    return path.concat([b]);
  }

  if (dir === "-x") {
    // Arriving leftwards: reach a point clear of the target's face, then come
    // back into it.
    const gate = bx + STUB;
    if (Math.abs(by - ay) < 1 || gate < out) {
      // Either dead level with the target, or the gate is behind the stub we
      // just came out on. Both would draw the return leg back along the line
      // we arrived on, so step aside first and cross over there.
      const aside = ay + DETOUR;
      path.push([out, aside], [gate, aside], [gate, by]);
    } else {
      path.push([gate, ay], [gate, by]);
    }
    return path.concat([b]);
  }

  // Arriving vertically: the corner has to be beyond the target's face.
  const down = dir === "+y";
  const before = down ? by - STUB : by + STUB;
  const clear = down ? before >= ay : before <= ay;
  if (bx >= out && clear) {
    path.push([bx, ay], [bx, before]);
    return path.concat([b]);
  }
  // No room for the corner: run out, cross over BEYOND the target's face, and
  // come down (or up) into it. Crossing back at our own level would retrace
  // the stub we just left.
  path.push([out, before], [bx, before]);
  return path.concat([b]);
}

/** Rotation that puts `d0` on +x, and its inverse. */
function frameFor(d0: Pt): { to: (p: Pt) => Pt; from: (p: Pt) => Pt } {
  if (d0[0] > 0.5) return { to: (p) => [p[0], p[1]], from: (p) => [p[0], p[1]] };
  if (d0[0] < -0.5) return { to: (p) => [-p[0], -p[1]], from: (p) => [-p[0], -p[1]] };
  if (d0[1] > 0.5) return { to: (p) => [p[1], -p[0]], from: (p) => [-p[1], p[0]] };
  return { to: (p) => [-p[1], p[0]], from: (p) => [p[1], -p[0]] };
}

/**
 * Which port does this point mean? Used to read a hand-dragged arrow end back
 * as an instruction: the nearest face wins, and how far along it the point sits
 * becomes the port's `at`. Returns null when the point is nowhere near the box,
 * because then it is not an attachment — it is a line somebody parked.
 */
export function nearestPort(box: Placement, p: Pt, tolerance: number): Port | null {
  let best: { side: Side; at: number; dist: number } | null = null;
  for (const side of SIDES) {
    const along = side === "top" || side === "bottom" ? box.w : box.h;
    if (along <= 0) continue;
    const at = clamp01(
      side === "top" || side === "bottom" ? (p[0] - box.x) / box.w : (p[1] - box.y) / box.h,
    );
    const on = portPoint(box, { side, at });
    const dist = Math.hypot(on[0] - p[0], on[1] - p[1]);
    if (!best || dist < best.dist) best = { side, at, dist };
  }
  if (!best || best.dist > tolerance) return null;
  return { side: best.side, at: best.at };
}

/** Same connection point, to within a pixel of the face it sits on. */
export function samePort(a: Port | undefined, b: Port | undefined, box: Placement): boolean {
  if (!a || !b) return !a === !b;
  if (a.side !== b.side) return false;
  const along = a.side === "top" || a.side === "bottom" ? box.w : box.h;
  return Math.abs(a.at - b.at) * along < 1;
}

function clamp01(v: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5;
}

/**
 * Re-route one edge through the connection points somebody chose.
 *
 * Only the ends they SET are honoured; the other end keeps the point the
 * router picked, read back off the route itself (which is on the box's
 * perimeter, so the face it used is recoverable). Returns null when there is
 * nothing to override, so the automatic routing — corridors, gutters, all of
 * it — is left completely alone for every other edge.
 */
export function routeThroughPorts(
  points: Pt[],
  boxes: { from: Placement; to: Placement },
  wish: { fromPort?: Port; toPort?: Port },
): Pt[] | null {
  if (!wish.fromPort && !wish.toPort) return null;
  if (points.length < 2) return null;
  const from = wish.fromPort ?? nearestPort(boxes.from, points[0]!, 6);
  const to = wish.toPort ?? nearestPort(boxes.to, points[points.length - 1]!, 6);
  if (!from || !to) return null;
  return connectPorts({ box: boxes.from, port: from }, { box: boxes.to, port: to });
}

// ------------------------------------------------------- decision branches ----

/**
 * A diamond has ONE tip per side, so every branch the router sends out of the
 * same face leaves from the same point — two arrows drawn on top of each other
 * for as long as they run together, with their labels landing in the same
 * place. Real flowcharts answer this by using different tips, and so does this:
 * the branch that carries on straight keeps the tip ahead, and the others take
 * the side tip on the side their target actually lies.
 *
 * Returns one entry per branch: a port to attach to, or null to leave it on
 * the natural exit.
 */
export function decisionExits(
  from: Placement,
  targets: Placement[],
  ax: Axis,
): Array<Port | null> {
  const out: Array<Port | null> = targets.map(() => null);
  if (targets.length < 2) return out;

  const ahead: Side = ax.vertical ? "bottom" : "right";
  const low: Side = ax.vertical ? "left" : "top";
  const high: Side = ax.vertical ? "right" : "bottom";

  const order = targets
    .map((t, i) => ({ i, cross: ax.cMid(t) - ax.cMid(from) }))
    .sort((a, b) => Math.abs(a.cross) - Math.abs(b.cross));

  const used = new Set<Side>([ahead]);
  order.forEach((branch, rank) => {
    // The straightest branch keeps the tip ahead — that is the one a reader
    // follows as "the flow continues".
    if (rank === 0) return;
    const side = branch.cross >= 0 ? high : low;
    if (used.has(side)) return;
    used.add(side);
    out[branch.i] = { side, at: 0.5 };
  });
  return out;
}
