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
  const d: Dir = dir[0]! > 0.5 ? "+x" : dir[0]! < -0.5 ? "-x" : dir[1]! > 0.5 ? "+y" : "-y";
  const boxes = [localBox(from.box, f), localBox(to.box, f)];
  const shaped = join(a, b, d);
  // The shapes in join() are chosen from the two POINTS alone, and a point
  // says nothing about how big the box behind it is: a U-turn that steps
  // aside by a fixed amount runs straight through a tall target. Keep the
  // shape when it is clear — it is the shortest, and every drawn diagram
  // already relies on it — and look for one that goes round otherwise.
  const local = clearOf(simplify(shaped), boxes) ? shaped : (goAround(a, b, d, boxes) ?? shaped);
  return simplify(local.map(f.from));
}

type Dir = "+x" | "-x" | "+y" | "-y";

/** A box as extents in the local frame (corners rotated, then re-ordered). */
interface Extent {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function localBox(box: Placement, f: { to: (p: Pt) => Pt }): Extent {
  const p = f.to([box.x, box.y]);
  const q = f.to([box.x + box.w, box.y + box.h]);
  return {
    x0: Math.min(p[0], q[0]),
    y0: Math.min(p[1], q[1]),
    x1: Math.max(p[0], q[0]),
    y1: Math.max(p[1], q[1]),
  };
}

/**
 * Does no segment pass through the INSIDE of either box? Running along a face
 * is fine (the ports sit on faces, so the first and last segments start and
 * end on one), which is why the box is shrunk by half a pixel first.
 */
function clearOf(path: Pt[], boxes: Extent[]): boolean {
  for (let i = 1; i < path.length; i++) {
    const p = path[i - 1]!;
    const q = path[i]!;
    const x0 = Math.min(p[0], q[0]);
    const x1 = Math.max(p[0], q[0]);
    const y0 = Math.min(p[1], q[1]);
    const y1 = Math.max(p[1], q[1]);
    for (const b of boxes) {
      if (x0 < b.x1 - 0.5 && x1 > b.x0 + 0.5 && y0 < b.y1 - 0.5 && y1 > b.y0 + 0.5) return false;
    }
  }
  return true;
}

/** Does the line double straight back on itself anywhere? That reads as a spike, not a route. */
function turnsBack(path: Pt[]): boolean {
  for (let i = 2; i < path.length; i++) {
    const u: Pt = [path[i - 1]![0] - path[i - 2]![0], path[i - 1]![1] - path[i - 2]![1]];
    const v: Pt = [path[i]![0] - path[i - 1]![0], path[i]![1] - path[i - 1]![1]];
    if (u[0] * v[0] + u[1] * v[1] < 0) return true;
  }
  return false;
}

/**
 * The fallback when the point-only shape cuts through a box: try the
 * orthogonal paths with up to four turns whose legs run along lines that clear
 * both boxes, and keep the shortest one that touches neither (a turn costs a
 * little length, so a path does not zig-zag to save a pixel). The stubs shrink
 * to half the gap when the two boxes sit closer than a stub — otherwise the
 * very first segment would already be inside the other box, and nothing after
 * it could fix that.
 */
function goAround(a: Pt, b: Pt, dir: Dir, boxes: Extent[]): Pt[] | null {
  const into: Pt = dir === "+x" ? [1, 0] : dir === "-x" ? [-1, 0] : dir === "+y" ? [0, 1] : [0, -1];
  const stubOut = stubLength(a, [1, 0], boxes);
  const stubIn = stubLength(b, [-into[0], -into[1]], boxes);
  const s: Pt = [a[0] + stubOut, a[1]];
  const e: Pt = [b[0] - into[0] * stubIn, b[1] - into[1] * stubIn];

  // Lines a leg may run along: the two stub ends, and just outside every box
  // face, at the stub's distance.
  const xs = new Set<number>([s[0], e[0]]);
  const ys = new Set<number>([s[1], e[1]]);
  for (const box of boxes) {
    xs.add(box.x0 - STUB);
    xs.add(box.x1 + STUB);
    ys.add(box.y0 - STUB);
    ys.add(box.y1 + STUB);
  }

  const middles: Pt[][] = [[[e[0], s[1]]], [[s[0], e[1]]]];
  for (const x of xs) middles.push([[x, s[1]], [x, e[1]]]);
  for (const y of ys) middles.push([[s[0], y], [e[0], y]]);
  for (const x of xs) {
    for (const y of ys) {
      middles.push([[s[0], y], [x, y], [x, e[1]]]);
      middles.push([[x, s[1]], [x, y], [e[0], y]]);
    }
  }

  let best: { path: Pt[]; cost: number } | null = null;
  for (const mid of middles) {
    const path = simplify([a, s, ...mid, e, b]);
    if (turnsBack(path) || !clearOf(path, boxes)) continue;
    let cost = 0;
    for (let i = 1; i < path.length; i++) {
      cost += Math.abs(path[i]![0] - path[i - 1]![0]) + Math.abs(path[i]![1] - path[i - 1]![1]);
    }
    cost += (path.length - 2) * 8;
    if (!best || cost < best.cost) best = { path, cost };
  }
  return best ? best.path : null;
}

/** STUB, or half the room in front of the port when a box is closer than that. */
function stubLength(p: Pt, d: Pt, boxes: Extent[]): number {
  let len = STUB;
  for (const box of boxes) {
    // Distance to the first face of this box straight ahead, if the ray hits it.
    if (d[0] !== 0) {
      if (!(p[1] > box.y0 + 0.5 && p[1] < box.y1 - 0.5)) continue;
      const face = d[0] > 0 ? box.x0 : box.x1;
      const gap = (face - p[0]) * d[0];
      if (gap > 0.5 && gap < len * 2) len = Math.min(len, gap / 2);
    } else {
      if (!(p[0] > box.x0 + 0.5 && p[0] < box.x1 - 0.5)) continue;
      const face = d[1] > 0 ? box.y0 : box.y1;
      const gap = (face - p[1]) * d[1];
      if (gap > 0.5 && gap < len * 2) len = Math.min(len, gap / 2);
    }
  }
  return len;
}

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
  // The end nobody set is read back off the route. No distance limit: the
  // routers do not always end a line exactly on the perimeter (a start point
  // can sit inside the box it leaves), and refusing to read that end threw
  // away the port somebody DID set on the other one. The nearest face is the
  // face the router meant.
  const from = wish.fromPort ?? nearestPort(boxes.from, points[0]!, Infinity);
  const to = wish.toPort ?? nearestPort(boxes.to, points[points.length - 1]!, Infinity);
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
