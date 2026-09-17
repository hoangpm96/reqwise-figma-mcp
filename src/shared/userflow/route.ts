/**
 * Orthogonal routing: the half of the layout that does NOT need dagre.
 *
 * It is split out because it runs in two places. The server runs it after
 * dagre has placed the ranks (src/shared/userflow/layout.ts), and the PLUGIN
 * runs it again — with the node positions read straight off the canvas —
 * every time somebody drags or resizes a box. That second path is what makes
 * the arrows behave like FigJam connectors instead of like the loose vectors
 * they really are: Figma Design has no connector primitive (createConnector is
 * FigJam-only), so "the line follows the box" has to be re-computed, and the
 * routing code is the part that must be shared to keep both passes identical.
 *
 * Nothing here imports dagre, so the plugin bundle stays free of it.
 *
 * Coordinates are computed in (along, cross) space — `along` runs with the
 * rank direction, `cross` across it — so TB and LR share one implementation.
 */
import type { FlowKind } from "./types.js";
import type { DrawEdge, FlowClass, Placement } from "../diagram/types.js";
import { Axis, clearLabelOverlaps, emitEdge, simplify, type Pt } from "../diagram/geometry.js";
import { edgeColor } from "../diagram/palette.js";
import { edgeIds } from "../diagram/graph.js";
import { decisionExits, routeThroughPorts, type Port } from "../diagram/connector.js";

const GUTTER_STEP = 20;
const GROOVE = 14;
const GROOVE_STEP = 9;
/**
 * How far apart two lines are set when they have to leave (or arrive at) the
 * same face of a diamond. `spreadDecisions` moves what it can to the side
 * tips, but a return path keeps the tip ahead (its geometry is the gutter's,
 * not a connector's) and a fourth branch has no tip left, so the rest are
 * offset along the diamond's edge instead of stacked on the tip.
 */
const TIP_STEP = 18;

/** A placed node, as routing sees it: a box with a kind. */
export interface RouteNode {
  id: string;
  kind: FlowKind;
  cls: FlowClass;
  w: number;
  h: number;
  x: number;
  y: number;
}

/**
 * An edge being routed. `lw`/`lh`/`labelLines` are the label's MEASURED size:
 * text metrics live on the server, so the plugin gets them precomputed and
 * never has to re-measure.
 */
export interface RouteEdge {
  from: string;
  to: string;
  kind: "forward" | "return";
  labelLines: string[];
  lw: number;
  lh: number;
  /** Unique per edge — the multigraph key, and the drawn layer's handle. */
  name: string;
  back: boolean;
  side: 1 | -1;
  lane: number;
  points: Pt[];
  labelAt: Pt | null;
  dagrePoints: Array<{ x: number; y: number }> | null;
  dagreLabel: { x: number; y: number } | null;
  portOut: number;
  portIn: number;
  /** The caller's connection-point wish, 0..1 along the natural face. */
  fromAt?: number;
  toAt?: number;
  /** A full connection point (face + position), which bypasses the routing. */
  fromPort?: Port;
  toPort?: Port;
}

/**
 * Edges whose connection points were chosen by a person (or by the spec) are
 * re-routed through the generic connector: it leaves the face they picked and
 * arrives at the face they picked, which the rank-aware routing above cannot
 * express. Everything else is untouched.
 */
export function overridePorts(edges: RouteEdge[], byId: Map<string, RouteNode>): void {
  for (const e of edges) {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (!from || !to || e.from === e.to) continue;
    const routed = routeThroughPorts(e.points, { from, to }, e);
    if (!routed) continue;
    e.points = routed;
    // The label was placed against the path this call just REPLACED. Left
    // alone it marks a line that is no longer there — which is how a branch
    // label ends up in open canvas 115px from the arrow it names.
    if (e.labelAt) e.labelAt = nearestOnPath(e.labelAt, routed);
  }
}

/**
 * Move labels off what they are sitting on. Runs AFTER `overridePorts`, never
 * inside `route`: clearing overlaps against paths that are about to be redrawn
 * decides the question twice and keeps the wrong answer.
 */
export function clearLabels(nodes: RouteNode[], edges: RouteEdge[]): void {
  clearLabelOverlaps(edges, nodes);
}

/** 0..1, clamped; anything else means "no opinion". */
function ratio(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null;
}

/**
 * Before routing: a decision's branches are spread across its tips, so two
 * arrows do not leave the same point and run together.
 */
export function spreadDecisions(
  nodes: RouteNode[],
  edges: RouteEdge[],
  byId: Map<string, RouteNode>,
  ax: Axis,
): void {
  for (const n of nodes) {
    if (n.kind !== "decision") continue;
    const outs = edges.filter(
      (e) => e.from === n.id && e.to !== n.id && !e.back && e.kind !== "return" && !e.fromPort,
    );
    const targets = outs.map((e) => byId.get(e.to)).filter((t): t is RouteNode => !!t);
    if (targets.length !== outs.length || targets.length < 2) continue;
    // A branch that goes to the same rank is already routed across a face; only
    // the ones heading onwards compete for the tip ahead.
    const forward = outs.filter((e) => ax.aMid(byId.get(e.to)!) > ax.aMid(n) + 1);
    if (forward.length < 2) continue;
    const ports = decisionExits(n, forward.map((e) => byId.get(e.to)!), ax);
    forward.forEach((e, i) => {
      const port = ports[i];
      if (port) e.fromPort = port;
    });
  }
}

/**
 * Where a line meets the node's outline at cross position `c`.
 *
 * For a box that is the face itself. For a diamond it is a point on the
 * slanted edge, which is what keeps an offset exit ATTACHED to the shape: the
 * bounding box's bottom edge is empty canvas everywhere except the tip, so a
 * line offset along it would start in mid-air.
 */
function faceAlong(n: RouteNode, c: number, ax: Axis, end: boolean): number {
  const tip = end ? ax.a1(n) : ax.a0(n);
  if (n.kind !== "decision") return tip;
  const half = ax.cLen(n) / 2;
  if (half <= 0) return tip;
  const off = Math.min(1, Math.abs(c - ax.cMid(n)) / half);
  const mid = ax.aMid(n);
  return mid + (tip - mid) * (1 - off);
}

export function route(
  nodes: RouteNode[],
  edges: RouteEdge[],
  byId: Map<string, RouteNode>,
  ax: Axis,
): void {
  const rankKey = (n: RouteNode): number => Math.round(ax.aMid(n));
  const ranks = new Map<number, { start: number; end: number }>();
  for (const n of nodes) {
    const k = rankKey(n);
    const r = ranks.get(k) ?? { start: Infinity, end: -Infinity };
    r.start = Math.min(r.start, ax.a0(n));
    r.end = Math.max(r.end, ax.a1(n));
    ranks.set(k, r);
  }
  const rankStart = (n: RouteNode): number => ranks.get(rankKey(n))!.start;
  const rankEnd = (n: RouteNode): number => ranks.get(rankKey(n))!.end;

  let crossMin = Infinity;
  let crossMax = -Infinity;
  for (const n of nodes) {
    crossMin = Math.min(crossMin, ax.c0(n));
    crossMax = Math.max(crossMax, ax.c1(n));
  }
  const crossCenter = (crossMin + crossMax) / 2;

  // ---- one port slot per edge on each face ----
  interface Slot {
    e: RouteEdge;
    key: "out" | "in" | "selfOut" | "selfIn";
    at: number;
  }
  /** The caller's port wish for this slot, if it had one. */
  const wish = (slot: Slot): number | null =>
    ratio(slot.key === "out" || slot.key === "selfOut" ? slot.e.fromAt : slot.e.toAt);
  /** Is this end of the edge routed through a full connection point? */
  const chosen = (slot: Slot): boolean =>
    slot.key === "out" || slot.key === "selfOut" ? !!slot.e.fromPort : !!slot.e.toPort;
  const faces = new Map<string, { start: Slot[]; end: Slot[]; low: Slot[]; high: Slot[] }>();
  const face = (id: string) => {
    let f = faces.get(id);
    if (!f) {
      f = { start: [], end: [], low: [], high: [] };
      faces.set(id, f);
    }
    return f;
  };
  const sameRank = (s: RouteNode, t: RouteNode): boolean => Math.abs(ax.aMid(t) - ax.aMid(s)) <= 1;

  for (const e of edges) {
    const s = byId.get(e.from)!;
    const t = byId.get(e.to)!;
    if (e.from === e.to) {
      face(e.from).high.push({ e, key: "selfOut", at: ax.aMid(s) });
      face(e.to).high.push({ e, key: "selfIn", at: ax.aMid(s) + 1 });
      continue;
    }
    if (sameRank(s, t)) {
      const towardsHigh = ax.cMid(t) > ax.cMid(s);
      face(e.from)[towardsHigh ? "high" : "low"].push({ e, key: "out", at: ax.aMid(t) });
      face(e.to)[towardsHigh ? "low" : "high"].push({ e, key: "in", at: ax.aMid(s) });
      continue;
    }
    if (e.back) {
      e.side = (ax.cMid(s) + ax.cMid(t)) / 2 >= crossCenter ? 1 : -1;
      face(e.from).end.push({ e, key: "out", at: e.side * 1e9 });
      face(e.to).start.push({ e, key: "in", at: e.side * 1e9 });
      continue;
    }
    const mids = (e.dagrePoints ?? []).slice(1, -1);
    face(e.from).end.push({
      e,
      key: "out",
      at: mids.length ? ax.ofC(mids[0]!) : ax.cMid(t),
    });
    face(e.to).start.push({
      e,
      key: "in",
      at: mids.length ? ax.ofC(mids[mids.length - 1]!) : ax.cMid(s),
    });
  }

  for (const [id, f] of faces) {
    const n = byId.get(id)!;
    // Rank-facing sides: spread the ports across the box width. A diamond has
    // one tip per side, so every edge meets at its centre.
    for (const side of ["start", "end"] as const) {
      // An edge already routed through a chosen connection point does not use
      // this face at all; counting it would push the edges that DO use it off
      // the tip for nothing.
      const list = f[side].filter((slot) => !chosen(slot));
      if (!list.length) continue;
      list.sort((a, b) => a.at - b.at);
      const m = list.length;
      list.forEach((slot, k) => {
        const asked = n.kind === "decision" ? null : wish(slot);
        const along = asked ?? (m === 1 ? 0.5 : k / (m - 1));
        // Never eat more than a quarter of the face from each side, or a short
        // box ends up with its ports outside itself.
        const pad = Math.min(14, ax.cLen(n) / 4);
        // A diamond's face is a single tip, so a second line on it is offset
        // sideways — far enough to read as two lines, and never so far that
        // the exit slides off the shape.
        const step = Math.min(TIP_STEP, ax.cLen(n) / (m + 1));
        const pos =
          n.kind === "decision"
            ? ax.cMid(n) + (k - (m - 1) / 2) * step
            : ax.c0(n) + pad + (ax.cLen(n) - pad * 2) * along;
        if (slot.key === "out") slot.e.portOut = pos;
        else slot.e.portIn = pos;
      });
    }
    for (const side of ["low", "high"] as const) {
      const list = f[side];
      if (!list.length) continue;
      list.sort((a, b) => a.at - b.at);
      const m = list.length;
      list.forEach((slot, k) => {
        const asked = n.kind === "decision" ? null : wish(slot);
        const pos =
          n.kind === "decision"
            ? ax.aMid(n)
            : asked !== null
              ? ax.a0(n) + ax.aLen(n) * asked
              : ax.a0(n) + (ax.aLen(n) * (k + 1)) / (m + 1);
        if (slot.key === "out" || slot.key === "selfOut") slot.e.portOut = pos;
        else slot.e.portIn = pos;
      });
    }
  }

  // ---- gutter lanes: the shortest hop takes the inner lane ----
  const gutterBase = new Map<number, number>();
  for (const side of [1, -1] as const) {
    const lane = edges
      .filter((e) => e.back && e.side === side)
      .sort(
        (a, b) =>
          Math.abs(ax.aMid(byId.get(a.from)!) - ax.aMid(byId.get(a.to)!)) -
          Math.abs(ax.aMid(byId.get(b.from)!) - ax.aMid(byId.get(b.to)!)),
      );
    lane.forEach((e, k) => {
      e.lane = k;
    });
    let widest = 0;
    for (const e of lane) widest = Math.max(widest, (ax.vertical ? e.lw : e.lh) / 2);
    gutterBase.set(side, 28 + widest);
  }

  // How far a label sticks out ACROSS the flow: its width in TB, its height in
  // LR. Used for gutter clearance and for parking a self-loop's label.
  const crossHalf = (e: RouteEdge): number => (ax.vertical ? e.lw : e.lh) / 2;

  const grooveUse = new Map<string, number>();
  const stagger = (key: string): number => {
    const k = grooveUse.get(key) ?? 0;
    grooveUse.set(key, k + 1);
    return k;
  };

  for (const e of edges) {
    const s = byId.get(e.from)!;
    const t = byId.get(e.to)!;
    const P: Pt[] = [];
    const push = (a: number, c: number): void => {
      P.push(ax.pt(a, c));
    };

    if (e.from === e.to) {
      const a1 = Math.min(e.portOut, e.portIn);
      const a2 = Math.max(e.portOut, e.portIn) + (e.portOut === e.portIn ? 20 : 0);
      const cOut = ax.c1(s) + 36;
      push(a1, ax.c1(s));
      push(a1, cOut);
      push(a2, cOut);
      push(a2, ax.c1(s));
      e.points = P;
      e.labelAt = ax.pt((a1 + a2) / 2, cOut + 8 + crossHalf(e));
    } else if (sameRank(s, t)) {
      const towardsHigh = ax.cMid(t) > ax.cMid(s);
      const c1 = towardsHigh ? ax.c1(s) : ax.c0(s);
      const c2 = towardsHigh ? ax.c0(t) : ax.c1(t);
      const a0 = e.portOut;
      const a1 = e.portIn;
      push(a0, c1);
      if (Math.abs(a0 - a1) >= 1) {
        const mc = (c1 + c2) / 2;
        push(a0, mc);
        push(a1, mc);
      }
      push(a1, c2);
      e.points = P;
      e.labelAt = e.labelLines.length ? ax.pt((a0 + a1) / 2, (c1 + c2) / 2) : null;
    } else if (e.back) {
      const base = gutterBase.get(e.side) ?? 28;
      const gc =
        e.side > 0
          ? crossMax + base + e.lane * GUTTER_STEP
          : crossMin - base - e.lane * GUTTER_STEP;
      const aOut = rankEnd(s) + GROOVE + stagger(`e${rankKey(s)}`) * GROOVE_STEP;
      const aIn = rankStart(t) - GROOVE - stagger(`s${rankKey(t)}`) * GROOVE_STEP;
      push(faceAlong(s, e.portOut, ax, true), e.portOut);
      push(aOut, e.portOut);
      push(aOut, gc);
      push(aIn, gc);
      push(aIn, e.portIn);
      push(faceAlong(t, e.portIn, ax, false), e.portIn);
      e.points = P;
      e.labelAt = e.labelLines.length ? ax.pt((aOut + aIn) / 2, gc) : null;
    } else {
      const mids = (e.dagrePoints ?? []).slice(1, -1).map((p) => ({
        a: ax.ofA(p),
        c: ax.ofC(p),
      }));
      let a = faceAlong(s, e.portOut, ax, true);
      let c = e.portOut;
      push(a, c);
      const way = mids.concat([{ a: faceAlong(t, e.portIn, ax, false), c: e.portIn }]);
      for (let i = 0; i < way.length; i++) {
        const w = way[i]!;
        const final = i === way.length - 1;
        // A sub-16px sidestep reads as a wobble, not a route: keep it straight.
        if (!final && Math.abs(w.c - c) < 16) w.c = c;
        if (Math.abs(w.c - c) > 0.5) {
          const ma = (a + w.a) / 2;
          push(ma, c);
          push(ma, w.c);
          a = ma;
          c = w.c;
        }
        push(w.a, c);
        a = w.a;
      }
      e.points = P;
      e.labelAt = null;
      if (e.labelLines.length) {
        const dl = e.dagreLabel;
        const guess: Pt = dl ? [dl.x, dl.y] : ax.pt((ax.a1(s) + ax.a0(t)) / 2, e.portOut);
        e.labelAt = snapToSegment(guess, e.points, ax);
      }
    }
    e.points = simplify(e.points);
  }

  stackGutterLabels(edges, ax);
}

/**
 * Pull a dagre label point onto the drawn path.
 *
 * An along-run is preferred — that is where a label reads best, beside the
 * stretch the arrow travels — but the fallback is the nearest point on ANY
 * segment, never the guess itself. Dagre's label point belongs to dagre's
 * routing, not to the path actually drawn: returning it put "locked_failed"
 * 115px from the line it names, in open canvas, and nothing downstream moved
 * it back because nothing was in its way there.
 */
function snapToSegment(guess: Pt, points: Pt[], ax: Axis): Pt {
  let best: Pt = nearestOnPath(guess, points);
  let bestDist = Infinity;
  const [ga, gc] = [ax.ofA({ x: guess[0], y: guess[1] }), ax.ofC({ x: guess[0], y: guess[1] })];
  for (let i = 1; i < points.length; i++) {
    const p0 = points[i - 1]!;
    const p1 = points[i]!;
    const a0 = ax.ofA({ x: p0[0], y: p0[1] });
    const a1 = ax.ofA({ x: p1[0], y: p1[1] });
    const c0 = ax.ofC({ x: p0[0], y: p0[1] });
    if (Math.abs(ax.ofC({ x: p1[0], y: p1[1] }) - c0) > 0.5) continue; // not an along-run
    const lo = Math.min(a0, a1);
    const hi = Math.max(a0, a1);
    if (ga < lo - 1 || ga > hi + 1) continue;
    const d = Math.abs(c0 - gc);
    if (d < bestDist) {
      bestDist = d;
      best = ax.pt(Math.min(hi, Math.max(lo, ga)), c0);
    }
  }
  return best;
}

/** The closest point to `p` anywhere on the polyline. */
function nearestOnPath(p: Pt, points: Pt[]): Pt {
  let best: Pt = points[0] ?? p;
  let bestDist = Infinity;
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1]!;
    const [x1, y1] = points[i]!;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((p[0] - x0) * dx + (p[1] - y0) * dy) / len2)) : 0;
    const at: Pt = [x0 + dx * t, y0 + dy * t];
    const d = Math.hypot(at[0] - p[0], at[1] - p[1]);
    if (d < bestDist) {
      bestDist = d;
      best = at;
    }
  }
  return best;
}

/** Gutter labels landing on each other: push the outer lanes further down. */
function stackGutterLabels(edges: RouteEdge[], ax: Axis): void {
  for (const side of [1, -1] as const) {
    const list = edges
      .filter((e) => e.back && e.side === side && e.labelAt)
      .sort((a, b) => a.lane - b.lane);
    for (let i = 0; i < list.length; i++) {
      for (let j = 0; j < i; j++) {
        const a = list[i]!;
        const b = list[j]!;
        const overlapX = Math.abs(a.labelAt![0] - b.labelAt![0]) < (a.lw + b.lw) / 2 + 6;
        const overlapY = Math.abs(a.labelAt![1] - b.labelAt![1]) < (a.lh + b.lh) / 2 + 6;
        if (overlapX && overlapY) {
          const shift = (a.lh + b.lh) / 2 + 8;
          a.labelAt = ax.pt(
            ax.ofA({ x: b.labelAt![0], y: b.labelAt![1] }) + shift,
            ax.ofC({ x: a.labelAt![0], y: a.labelAt![1] }),
          );
        }
      }
    }
  }
}



// ------------------------------------------------------------ back edges ----

/** Does the edge run against the rank direction? Then it belongs in a gutter. */
export function pointsBackwards(
  e: RouteEdge,
  byId: Map<string, RouteNode>,
  ax: Axis,
): boolean {
  if (e.from === e.to) return false;
  const s = byId.get(e.from);
  const t = byId.get(e.to);
  if (!s || !t) return false;
  return ax.aMid(t) < ax.aMid(s) - 1;
}

/**
 * An edge lives in a gutter either because the caller SAID it is a return
 * path, or because the geometry made it one. The server decides this against
 * dagre's ranks; a reflow decides it again against wherever the boxes ended up
 * after a drag, which is why the rule lives here and not in the layout pass.
 */
export function markBackEdges(
  edges: RouteEdge[],
  byId: Map<string, RouteNode>,
  ax: Axis,
): void {
  for (const e of edges) {
    e.back = e.from !== e.to && (e.kind === "return" || pointsBackwards(e, byId, ax));
  }
}

// ------------------------------------------------------------------ emit ----



/**
 * Routed edges → draw data, shifted into the frame's coordinate space. Shared
 * by the layout pass (which shifts by the diagram's padding) and by a reflow
 * (which reads canvas coordinates, already frame-relative, so ox/oy are 0).
 */
export function emitEdges(
  edges: RouteEdge[],
  byId: Map<string, RouteNode>,
  o: { ox?: number; oy?: number; colorByTarget?: boolean; ids?: string[] },
): DrawEdge[] {
  const ox = o.ox ?? 0;
  const oy = o.oy ?? 0;
  const colorByTarget = o.colorByTarget !== false;
  const ids = o.ids ?? edgeIds(edges);
  const out: DrawEdge[] = [];
  edges.forEach((e, i) => {
    const shifted: Pt[] = e.points.map((p) => [ox + p[0], oy + p[1]] as Pt);
    const drawn = emitEdge({
      id: ids[i] ?? `${e.from}->${e.to}`,
      points: shifted,
      color: edgeColor(e, byId.get(e.to)?.cls, colorByTarget),
      dashed: e.kind === "return" || e.back,
      label:
        e.labelAt && e.labelLines.length
          ? {
              at: [ox + e.labelAt[0], oy + e.labelAt[1]],
              w: e.lw,
              h: e.lh,
              text: e.labelLines.join("\n"),
              muted: e.kind === "return" || e.back,
            }
          : null,
    });
    if (drawn) out.push(drawn);
  });
  return out;
}

// ---------------------------------------------------------------- reflow ----

/** The graph a drawn userflow frame remembers, so it can be re-routed later. */
export interface RouteGraph {
  rankdir: "TB" | "LR";
  colorByTarget: boolean;
  /** false = this frame opted out of live re-routing. */
  liveRoute: boolean;
  nodes: Array<{
    id: string;
    kind: FlowKind;
    cls: FlowClass;
    /** Where the layout pass PUT this box. Never updated: it is the reference
     *  a reflow compares against to tell what the user has moved. */
    at?: Placement;
  }>;
  edges: Array<{
    from: string;
    to: string;
    kind: "forward" | "return";
    labelLines: string[];
    lw: number;
    lh: number;
    /** The caller's connection-point wish, 0..1 along the natural face. */
    fromAt?: number;
    toAt?: number;
    /**
     * A full connection point — which face, and where along it. Set by the
     * spec, or adopted from an arrow somebody dragged onto another face; it
     * takes the edge out of the automatic routing and through the generic
     * connector instead.
     */
    fromPort?: Port;
    toPort?: Port;
    /** True when those ports came from a drag, not from the spec. */
    portsByHand?: boolean;
    /** dagre's waypoints for this edge, in frame coordinates. Replayed while
     *  both its boxes are untouched, so a drag somewhere else in the diagram
     *  cannot degrade an arrow that had no reason to change. */
    waypoints?: Array<{ x: number; y: number }>;
    /** Where the layout pass put this edge's label, in frame coordinates. */
    labelAt?: { x: number; y: number };
  }>;
}

export interface Reflowed {
  edges: DrawEdge[];
  /** Edge ids whose endpoint box is gone from the canvas. */
  dropped: string[];
  /** Boxes that are no longer where the layout pass put them. */
  moved: string[];
}

/**
 * Re-route a drawn userflow from where its boxes actually are now.
 *
 * dagre is deliberately NOT re-run: the boxes are where the user put them, and
 * a reflow that moved them would undo the drag it is reacting to. Without
 * dagre's waypoints a rank-crossing edge routes as a plain elbow (out, sidestep
 * halfway, in) — the same shape FigJam's ELBOWED connector draws.
 */
export function reflowUserflow(graph: RouteGraph, placed: Map<string, Placement>): Reflowed {
  const nodes: RouteNode[] = [];
  const byId = new Map<string, RouteNode>();
  const moved = new Set<string>();
  for (const n of graph.nodes) {
    const box = placed.get(n.id);
    if (!box) continue;
    const node: RouteNode = { id: n.id, kind: n.kind, cls: n.cls, ...box };
    nodes.push(node);
    byId.set(n.id, node);
    // No stored placement (a frame drawn before this was recorded) means the
    // box has to be treated as moved — the honest answer when we cannot tell.
    if (!n.at || !samePlace(n.at, box)) moved.add(n.id);
  }

  const ids = edgeIds(graph.edges);
  const keep: RouteEdge[] = [];
  const keptIds: string[] = [];
  const dropped: string[] = [];
  graph.edges.forEach((e, i) => {
    const id = ids[i]!;
    if (!byId.has(e.from) || !byId.has(e.to)) {
      dropped.push(id);
      return;
    }
    const settled = !moved.has(e.from) && !moved.has(e.to);
    keep.push({
      from: e.from,
      to: e.to,
      kind: e.kind,
      labelLines: e.labelLines,
      lw: e.lw,
      lh: e.lh,
      ...(typeof e.fromAt === "number" ? { fromAt: e.fromAt } : {}),
      ...(typeof e.toAt === "number" ? { toAt: e.toAt } : {}),
      ...(e.fromPort ? { fromPort: e.fromPort } : {}),
      ...(e.toPort ? { toPort: e.toPort } : {}),
      name: `e${i}`,
      back: false,
      side: 1,
      lane: 0,
      points: [],
      labelAt: null,
      dagrePoints: settled && e.waypoints && e.waypoints.length ? e.waypoints : null,
      dagreLabel: settled && e.labelAt ? e.labelAt : null,
      portOut: 0,
      portIn: 0,
    });
    keptIds.push(id);
  });

  const report = { dropped, moved: Array.from(moved) };
  if (!nodes.length || !keep.length) return { edges: [], ...report };

  const ax = new Axis(graph.rankdir !== "LR");
  markBackEdges(keep, byId, ax);
  spreadDecisions(nodes, keep, byId, ax);
  route(nodes, keep, byId, ax);
  overridePorts(keep, byId);
  clearLabels(nodes, keep);
  return {
    edges: emitEdges(keep, byId, { colorByTarget: graph.colorByTarget, ids: keptIds }),
    ...report,
  };
}

/** Same box, to within the quarter-pixel grid the layout rounds to. */
function samePlace(a: Placement, b: Placement): boolean {
  return (
    Math.abs(a.x - b.x) < 0.5 &&
    Math.abs(a.y - b.y) < 0.5 &&
    Math.abs(a.w - b.w) < 0.5 &&
    Math.abs(a.h - b.h) < 0.5
  );
}
