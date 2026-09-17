/**
 * Orthogonal routing for a swimlane activity diagram.
 *
 * It is a pure function of WHERE THE BOXES ARE — lane bands, step placements,
 * the edge list. dagre never appears here, which is what makes the live
 * re-route exact: the plugin runs this same function with the positions it
 * reads off the canvas and gets the geometry the layout pass would have
 * produced. (The userflow router had to store dagre's waypoints to manage the
 * same trick.)
 *
 * The routing problem a swimlane adds is CROSSING LANES: an arrow from the
 * customer's lane to the warehouse's lane has to travel across bands that are
 * full of other people's steps. Three devices handle it:
 *  - a **corridor** — the along-gap the layout leaves between two ranks is
 *    free of boxes by construction, so a cross-lane arrow does its sideways
 *    travel there, on a slot of its own so two arrows never share a line;
 *  - a **clearance test** — if the straight run is not blocked by a box, take
 *    it, because a straight arrow always reads better than an elbow;
 *  - an **outer gutter** — for the arrows that cannot be routed either way
 *    (rework going backwards, a skip that would cut through three ranks), go
 *    around the outside of every lane, where nothing can be in the way.
 */
import { Axis, clearLabelOverlaps, emitEdge, simplify, type Pt } from "../diagram/geometry.js";
import { edgeColor } from "../diagram/palette.js";
import { edgeIds } from "../diagram/graph.js";
import { decisionExits, routeThroughPorts, type Port } from "../diagram/connector.js";
import type { DrawEdge, FlowClass, Placement } from "../diagram/types.js";
import type { ActivityGraph, ActivityKind } from "./types.js";

/** Keep a corridor line this far off the box faces it runs between. */
const CORRIDOR_INSET = 6;
/** Where a gutter detour turns out of / back into the flow. Wide enough that
 *  the arrow head does not eat the whole entry segment. */
const GUTTER_TURN = 22;
/** A sidestep shorter than this reads as a wobble, not a route. */
const WOBBLE = 16;
/** How far outside the outermost lane the gutters run. */
const GUTTER = 34;
const GUTTER_STEP = 20;
/**
 * Ports stop this far short of a box's corners — but never eat more than a
 * quarter of the face from each side, or a 40px start pill would have a 12px
 * range for every arrow that touches it (and a 20px bar a negative one).
 */
const PORT_INSET = 14;
const inset = (len: number): number => Math.min(PORT_INSET, len / 4);
/** How far a self-loop bulges out of its own box. */
const SELF_OUT = 34;
/** Clearance a box claims either side of itself, for the straight-run test. */
const CLEAR_MARGIN = 8;
/** Two threaded lines this close would read as one line. */
const LANE_APART = 12;
/**
 * How far apart two lines are set when they have to leave (or arrive at) the
 * same face of a diamond. `spreadDecisions` moves what it can to the side
 * tips, but a return path keeps the tip ahead (its shape belongs to the
 * gutter, not to a connector) and a fourth branch has no tip left, so the rest
 * are offset along the diamond's edge instead of stacked on the tip.
 */
const TIP_STEP = 18;

/**
 * Where a line meets the step's outline at cross position `c`.
 *
 * For a rectangle that is the face itself. For a diamond it is a point on the
 * slanted edge, which is what keeps an offset exit ATTACHED to the shape: the
 * bounding box's end face is empty canvas everywhere except the tip, so a line
 * offset along it would start in mid-air.
 */
function faceAlong(step: StepPlace, c: number, ax: Axis, end: boolean): number {
  const tip = end ? ax.a1(step.at) : ax.a0(step.at);
  if (step.kind !== "decision") return tip;
  const half = ax.cLen(step.at) / 2;
  if (half <= 0) return tip;
  const off = Math.min(1, Math.abs(c - ax.cMid(step.at)) / half);
  const mid = ax.aMid(step.at);
  return mid + (tip - mid) * (1 - off);
}

export interface StepPlace {
  id: string;
  kind: ActivityKind;
  cls: FlowClass;
  lane: string;
  at: Placement;
  /**
   * ONE attach point per face, at its middle, instead of arrows spread along
   * it. Two shapes want this for different reasons: a circle or an ellipse
   * touches its bounding box at exactly that point and nowhere else (spread
   * across a 26px face, an arrow head lands on empty space and clips the
   * curve), and a use case ACTOR is a stick figure whose associations all meet
   * it at one place by convention — fanning them out draws lines that look
   * like extra limbs.
   */
  singlePort?: boolean;
  /**
   * Spread this shape's ports across only the middle FRACTION of each face
   * (1 = the whole face, the default). A stick figure wants a narrow band: its
   * lines have to leave the torso, not the head or the feet, but giving them
   * one single point makes several of them share a track for a hundred pixels
   * before they turn.
   */
  portBand?: number;
}

export interface LanePlace {
  id: string;
  at: Placement;
}

export interface EdgeInput {
  from: string;
  to: string;
  kind: "forward" | "return";
  /** Measured server-side: the plugin has no text metrics. */
  labelLines: string[];
  lw: number;
  lh: number;
  /**
   * Where along its face the arrow leaves / arrives, 0..1 (0.5 = the middle).
   * The router spreads ports evenly and has no idea which one reads best;
   * these say so explicitly, and unlike a hand edit they keep following the
   * boxes. Ignored on a diamond, whose only sensible attach point is its tip.
   */
  fromAt?: number;
  toAt?: number;
  /** A full connection point (face + position), which bypasses the routing. */
  fromPort?: Port;
  toPort?: Port;
}

export interface RouteInput {
  rankdir: "TB" | "LR";
  colorByTarget: boolean;
  lanes: LanePlace[];
  steps: StepPlace[];
  edges: EdgeInput[];
  /**
   * Extra rectangles a LABEL must not land on, beyond the boxes themselves —
   * a use case diagram's boundary caption, for instance, which is text the
   * router would otherwise happily bury a stereotype label under.
   */
  obstacles?: Placement[];
  /**
   * Send an arrow the long way around the outside when it cannot get through.
   * Right for a process — a rework path cutting back across three lanes is
   * unreadable — and WRONG for a use case diagram, where the lines are
   * associations: crossing another one is normal and expected there, while a
   * detour around the whole picture reads as a mistake. Default true.
   */
  gutter?: boolean;
}

export interface RoutedActivity {
  edges: DrawEdge[];
  /** Edge ids whose step is gone from the canvas. */
  dropped: string[];
  /**
   * What the router could not do the way it was asked — today, a line that had
   * to be drawn straight across because there was no gap to cross in and the
   * detour around the outside was turned off.
   */
  warnings: string[];
}

type Shape = "straight" | "direct" | "corridor" | "cross" | "gutter" | "sameRank" | "self" | "back";

interface Wire extends EdgeInput {
  id: string;
  /** How many edges share the face this one leaves from / arrives at. */
  outSlots: number;
  inSlots: number;
  from_: StepPlace;
  to_: StepPlace;
  rankFrom: number;
  rankTo: number;
  shape: Shape;
  /** Along-position of the corridor slot this wire crosses in. */
  corridor: number;
  /** Which gap it crosses in — chosen by `classify`, slotted by the next pass. */
  corridorRank: number;
  /** A "cross" wire's second gap, and the free lane it travels along between. */
  corridorRank2: number;
  corridor2: number;
  crossAt: number;
  /** Outer-gutter lane index (0 = innermost). */
  lane: number;
  portOut: number;
  portIn: number;
  /** True once a port wish has actually been applied to that end. */
  askedOut: boolean;
  askedIn: boolean;
  points: Pt[];
  labelAt: Pt | null;
}

/** 0..1, clamped; anything else means "no opinion". */
function ratio(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null;
}

export function routeActivity(input: RouteInput): RoutedActivity {
  const ax = new Axis(input.rankdir === "TB");
  const byId = new Map<string, StepPlace>();
  for (const s of input.steps) byId.set(s.id, s);

  const ids = edgeIds(input.edges);
  const dropped: string[] = [];
  const wires: Wire[] = [];
  input.edges.forEach((e, i) => {
    const from_ = byId.get(e.from);
    const to_ = byId.get(e.to);
    if (!from_ || !to_) {
      dropped.push(ids[i]!);
      return;
    }
    wires.push({
      ...e,
      id: ids[i]!,
      outSlots: 1,
      inSlots: 1,
      from_,
      to_,
      rankFrom: 0,
      rankTo: 0,
      shape: "straight",
      corridor: 0,
      corridorRank: 0,
      corridorRank2: 0,
      corridor2: 0,
      crossAt: 0,
      lane: 0,
      portOut: 0,
      portIn: 0,
      askedOut: false,
      askedIn: false,
      points: [],
      labelAt: null,
    });
  });
  if (!input.steps.length || !wires.length) return { edges: [], dropped, warnings: [] };

  const ranks = rankSteps(input.steps, ax);
  for (const w of wires) {
    w.rankFrom = ranks.of.get(w.from_.id)!;
    w.rankTo = ranks.of.get(w.to_.id)!;
  }

  spreadDecisions(wires, byId, ax);
  assignPorts(wires, ax);
  const warnings: string[] = [];
  classify(wires, input.steps, ranks, ax, input.gutter !== false, warnings);
  assignCorridors(wires, ranks);
  assignGutterLanes(wires, ax);
  buildPaths(wires, ranks, laneExtent(input, ax), ax);
  // Edges whose connection points were chosen by a person (or by the spec) are
  // re-routed through the generic connector: it can leave and arrive on any
  // face, which the lane-aware routing above cannot express.
  for (const w of wires) {
    if (w.from === w.to) continue;
    const routed = routeThroughPorts(w.points, { from: w.from_.at, to: w.to_.at }, w);
    if (routed) w.points = routed;
  }
  placeLabels(wires, ax);
  clearLabelOverlaps(wires, input.steps.map((s) => s.at).concat(input.obstacles ?? []));

  const out: DrawEdge[] = [];
  for (const w of wires) {
    const drawn = emitEdge({
      id: w.id,
      points: w.points,
      color: edgeColor({ back: w.shape === "back", kind: w.kind }, w.to_.cls, input.colorByTarget),
      dashed: w.kind === "return",
      label:
        w.labelAt && w.labelLines.length
          ? {
              at: w.labelAt,
              w: w.lw,
              h: w.lh,
              text: w.labelLines.join("\n"),
              muted: w.kind === "return" || w.shape === "back",
            }
          : null,
    });
    if (drawn) out.push(drawn);
  }
  return { edges: out, dropped, warnings };
}

// ----------------------------------------------------------------- ranks ----

interface Ranks {
  /** step id → rank index. */
  of: Map<string, number>;
  /** along extent per rank, in rank order. */
  span: Array<{ start: number; end: number }>;
}

/**
 * Steps are ranked by where they SIT, not by graph order: after a drag the
 * canvas is the truth. Centres within a pixel count as the same rank, which is
 * what the layout pass produces for every step in one column.
 */
function rankSteps(steps: StepPlace[], ax: Axis): Ranks {
  const keys = new Map<number, StepPlace[]>();
  for (const s of steps) {
    const k = Math.round(ax.aMid(s.at));
    const bucket = keys.get(k);
    if (bucket) bucket.push(s);
    else keys.set(k, [s]);
  }
  const sorted = Array.from(keys.keys()).sort((a, b) => a - b);
  const of = new Map<string, number>();
  const span: Array<{ start: number; end: number }> = [];
  sorted.forEach((k, index) => {
    let start = Infinity;
    let end = -Infinity;
    for (const s of keys.get(k)!) {
      of.set(s.id, index);
      start = Math.min(start, ax.a0(s.at));
      end = Math.max(end, ax.a1(s.at));
    }
    span.push({ start, end });
  });
  return { of, span };
}

function laneExtent(input: RouteInput, ax: Axis): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  const boxes = input.lanes.length ? input.lanes.map((l) => l.at) : input.steps.map((s) => s.at);
  for (const at of boxes) {
    min = Math.min(min, ax.c0(at));
    max = Math.max(max, ax.c1(at));
  }
  return { min, max };
}

/**
 * A diamond has one tip per side, so branches that all leave the same face are
 * drawn on top of each other. Spread them: the straightest keeps the tip
 * ahead, the others take the tip on the side their target lies.
 */
function spreadDecisions(wires: Wire[], byId: Map<string, StepPlace>, ax: Axis): void {
  const byFrom = new Map<string, Wire[]>();
  for (const w of wires) {
    if (w.from_.kind !== "decision" || w.from === w.to) continue;
    if (w.kind === "return" || w.rankTo <= w.rankFrom || w.fromPort) continue;
    const bucket = byFrom.get(w.from);
    if (bucket) bucket.push(w);
    else byFrom.set(w.from, [w]);
  }
  for (const [id, outs] of byFrom) {
    if (outs.length < 2) continue;
    const from = byId.get(id);
    if (!from) continue;
    const ports = decisionExits(from.at, outs.map((w) => w.to_.at), ax);
    outs.forEach((w, i) => {
      const port = ports[i];
      if (port) w.fromPort = port;
    });
  }
}

// ----------------------------------------------------------------- ports ----

/**
 * One port per edge on each face, so three arrows leaving a step do not stack
 * on one pixel. A diamond has a single tip per side, so its edges all meet at
 * the centre; a fork BAR spreads its branches across its length, which is the
 * whole point of drawing a bar.
 */
function assignPorts(wires: Wire[], ax: Axis): void {
  interface Slot {
    w: Wire;
    role: "out" | "in";
    sortAt: number;
  }
  /** The caller's port wish for this slot, if it had one. */
  const wish = (slot: Slot): number | null =>
    ratio(slot.role === "out" ? slot.w.fromAt : slot.w.toAt);
  /** Is this end of the wire routed through a full connection point? */
  const chosen = (slot: Slot): boolean =>
    slot.role === "out" ? !!slot.w.fromPort : !!slot.w.toPort;
  const faces = new Map<string, { start: Slot[]; end: Slot[]; low: Slot[]; high: Slot[] }>();
  const face = (id: string) => {
    let f = faces.get(id);
    if (!f) {
      f = { start: [], end: [], low: [], high: [] };
      faces.set(id, f);
    }
    return f;
  };
  const byId = new Map<string, StepPlace>();
  for (const w of wires) {
    byId.set(w.from_.id, w.from_);
    byId.set(w.to_.id, w.to_);
  }

  for (const w of wires) {
    const s = w.from_.at;
    const t = w.to_.at;
    if (w.from === w.to) {
      face(w.from).high.push({ w, role: "out", sortAt: ax.aMid(s) });
      face(w.to).high.push({ w, role: "in", sortAt: ax.aMid(s) + 1 });
      continue;
    }
    if (w.rankFrom === w.rankTo) {
      const towardsHigh = ax.cMid(t) > ax.cMid(s);
      face(w.from)[towardsHigh ? "high" : "low"].push({ w, role: "out", sortAt: ax.aMid(t) });
      face(w.to)[towardsHigh ? "low" : "high"].push({ w, role: "in", sortAt: ax.aMid(s) });
      continue;
    }
    face(w.from).end.push({ w, role: "out", sortAt: ax.cMid(t) });
    face(w.to).start.push({ w, role: "in", sortAt: ax.cMid(s) });
  }

  for (const [id, f] of faces) {
    const step = byId.get(id)!;
    // One attach point per face: a diamond has a single tip there, and so do
    // the shapes that asked for it.
    const pointy = step.kind === "decision" || step.singlePort === true;
    for (const key of ["start", "end"] as const) {
      // A wire already routed through a chosen connection point does not use
      // this face at all; counting it would push the wires that DO use it off
      // the tip for nothing.
      const slots = f[key].filter((slot) => !chosen(slot));
      if (!slots.length) continue;
      slots.sort((a, b) => a.sortAt - b.sortAt);
      const m = slots.length;
      slots.forEach((slot, k) => {
        // The band narrows what is ALREADY usable after the corner inset.
        // Applying it as extra padding overflowed a short face and collapsed
        // every port onto one point — the opposite of what it is for.
        const band = Math.min(1, Math.max(0.05, step.portBand ?? 1));
        const full = ax.cLen(step.at);
        const pad = inset(full);
        const span = Math.max(0, full - pad * 2);
        const usable = span * band;
        const start = ax.c0(step.at) + pad + (span - usable) / 2;
        const asked = pointy ? null : wish(slot);
        const along = asked ?? (m === 1 ? 0.5 : k / (m - 1));
        // A diamond's face is a single tip, so a second line on it is offset
        // sideways — far enough to read as two lines, never so far that the
        // exit slides off the shape. A round shape keeps ONE point: it touches
        // its box at the tip and nowhere else, so an offset there is off-shape.
        const step_ = Math.min(TIP_STEP, full / (m + 1));
        const pos = pointy
          ? step.kind === "decision"
            ? ax.cMid(step.at) + (k - (m - 1) / 2) * step_
            : ax.cMid(step.at)
          : asked !== null
            ? ax.c0(step.at) + pad + span * asked
            : start + usable * along;
        if (asked !== null) {
          if (slot.role === "out") slot.w.askedOut = true;
          else slot.w.askedIn = true;
        }
        if (slot.role === "out") {
          slot.w.portOut = pos;
          slot.w.outSlots = m;
        } else {
          slot.w.portIn = pos;
          slot.w.inSlots = m;
        }
      });
    }
    for (const key of ["low", "high"] as const) {
      // Same rule as the end faces above: a wire leaving through a chosen
      // connection point is not on this face, and counting it slid every
      // sibling off the middle. A self-loop is the exception — it ignores
      // ports and is always drawn off this face from its own slot.
      const slots = f[key].filter((slot) => !chosen(slot) || slot.w.from === slot.w.to);
      if (!slots.length) continue;
      slots.sort((a, b) => a.sortAt - b.sortAt);
      const m = slots.length;
      slots.forEach((slot, k) => {
        const asked = pointy ? null : wish(slot);
        const pos = pointy
          ? ax.aMid(step.at)
          : asked !== null
            ? ax.a0(step.at) + ax.aLen(step.at) * asked
            : ax.a0(step.at) + (ax.aLen(step.at) * (k + 1)) / (m + 1);
        if (slot.role === "out") slot.w.portOut = pos;
        else slot.w.portIn = pos;
      });
    }
  }
}

// ------------------------------------------------------------ classifying ----

function classify(
  wires: Wire[],
  steps: StepPlace[],
  ranks: Ranks,
  ax: Axis,
  gutterAllowed: boolean,
  warnings: string[],
): void {
  const clear = (cross: number, aFrom: number, aTo: number, skip: Wire): boolean => {
    const lo = Math.min(aFrom, aTo);
    const hi = Math.max(aFrom, aTo);
    if (hi - lo < 1) return true;
    for (const s of steps) {
      if (s.id === skip.from || s.id === skip.to) continue;
      const c0 = ax.c0(s.at) - CLEAR_MARGIN;
      const c1 = ax.c1(s.at) + CLEAR_MARGIN;
      if (cross < c0 || cross > c1) continue;
      if (ax.a1(s.at) > lo + 1 && ax.a0(s.at) < hi - 1) return false;
    }
    return true;
  };

  // Free lanes already handed out, so two threaded lines do not share a track.
  const taken: number[] = [];

  for (const w of wires) {
    if (w.from === w.to) {
      w.shape = "self";
      continue;
    }
    if (w.kind === "return" || w.rankTo < w.rankFrom) {
      w.shape = gutterAllowed ? "back" : "sameRank";
      continue;
    }
    if (w.rankFrom === w.rankTo) {
      w.shape = "sameRank";
      continue;
    }
    const aOut = ax.a1(w.from_.at);
    const aIn = ax.a0(w.to_.at);
    // A sidestep of a few pixels is a wobble, not a route. When only one arrow
    // uses the face there is no port to collide with, so pull it onto the other
    // end's port and draw one straight line — but never over a port the caller
    // asked for by name, which would silently ignore the instruction.
    const off = Math.abs(w.portOut - w.portIn);
    if (off > 0.5 && off < WOBBLE) {
      // A single-port shape's port is not negotiable — for a circle it is the
      // only point the shape actually touches — so pull the OTHER end onto it.
      // Doing it the usual way around slid the arrow head 11px off a 26px ring
      // and left it clipping the curve.
      const fixedOut = w.from_.singlePort === true;
      const fixedIn = w.to_.singlePort === true;
      if (fixedIn && !fixedOut && !w.askedOut) w.portOut = w.portIn;
      else if (fixedOut && !fixedIn && !w.askedIn) w.portIn = w.portOut;
      else if (fixedOut || fixedIn) {
        // Both ends are fixed (or the free end was asked for by name): there
        // is nothing to give, so let it elbow rather than miss a shape.
      } else if (w.outSlots === 1 && !w.askedOut) w.portOut = w.portIn;
      else if (w.inSlots === 1 && !w.askedIn) w.portIn = w.portOut;
    }
    if (Math.abs(w.portOut - w.portIn) < 0.5 && clear(w.portOut, aOut, aIn, w)) {
      w.shape = "straight";
      continue;
    }
    // Every gap between here and the target is a candidate corridor: each one
    // is free of boxes by construction, and which one to cross in decides how
    // far the arrow travels at the SOURCE's height and how far at the
    // TARGET's. Take the first where both of those runs are clear. Crossing in
    // the first gap and then running the whole way at the target's height —
    // the only thing the first version tried — sent a line straight through
    // the middle of an unrelated shape, which reads as a connection to it.
    let chosen: number | null = null;
    let last: number | null = null;
    for (let i = w.rankFrom; i < w.rankTo; i++) {
      const gap = corridorGap(ranks, i);
      if (!gap) continue;
      const mid = (gap.start + gap.end) / 2;
      last = i;
      if (clear(w.portOut, aOut, mid, w) && clear(w.portIn, mid, aIn, w)) {
        chosen = i;
        break;
      }
    }
    if (chosen !== null) {
      w.shape = "corridor";
      w.corridorRank = chosen;
      continue;
    }
    // Nothing gets through at either end's own height. Thread it instead: out
    // into the first gap, along a FREE LANE between two rows of boxes, into
    // the last gap, then in. The lane is the horizontal twin of a corridor,
    // and it is what stops a long line disappearing behind a shape it has
    // nothing to do with — which reads as a connection to that shape, because
    // the boxes are painted over the lines.
    // Only for a diagram that has said no to the gutter. In a SWIMLANE the
    // gutter is the deliberate answer — a skip threading between two steps
    // inside the bands is exactly what the lanes exist to prevent — so
    // nothing changes for the kinds that still want it.
    const first = gutterAllowed ? null : corridorGap(ranks, w.rankFrom);
    const final = gutterAllowed ? null : corridorGap(ranks, w.rankTo - 1);
    if (first && final) {
      const a1 = (first.start + first.end) / 2;
      const a2 = (final.start + final.end) / 2;
      const lane = freeLane(steps, ax, a1, a2, w, (w.portOut + w.portIn) / 2, clear, taken);
      if (lane !== null && clear(w.portOut, aOut, a1, w) && clear(w.portIn, a2, aIn, w)) {
        taken.push(lane);
        w.shape = "cross";
        w.corridorRank = w.rankFrom;
        w.corridorRank2 = w.rankTo - 1;
        w.crossAt = lane;
        continue;
      }
    }
    // A process goes around the outside rather than cut through; a diagram
    // that has forbidden that crosses in the last gap it can reach.
    if (!gutterAllowed && last !== null) {
      w.shape = "corridor";
      w.corridorRank = last;
      continue;
    }
    // No gap at all between the two ranks — the boxes overlap along the flow,
    // usually because one was dragged. Falling through to the gutter here
    // drew exactly the walk around the picture the caller turned off, so the
    // line goes across directly instead, and the reader is told it may pass
    // over a shape.
    if (!gutterAllowed) {
      w.shape = "direct";
      warnings.push(
        `${w.from} → ${w.to}: no gap between the two to route through, and the detour around the outside is off — drawn straight across, so it may pass over another shape. Move one of them apart along the flow.`,
      );
      continue;
    }
    w.shape = "gutter";
  }
}

/**
 * A cross-position between two rows of boxes that a run from `aFrom` to `aTo`
 * can travel along without touching any of them, nearest to `want`. Candidates
 * are the midpoints between vertically adjacent boxes, plus just outside the
 * outermost ones.
 */
function freeLane(
  steps: StepPlace[],
  ax: Axis,
  aFrom: number,
  aTo: number,
  skip: Wire,
  want: number,
  clear: (cross: number, aFrom: number, aTo: number, skip: Wire) => boolean,
  taken: number[],
): number | null {
  const edges: number[] = [];
  for (const s of steps) {
    edges.push(ax.c0(s.at) - CLEAR_MARGIN - 6, ax.c1(s.at) + CLEAR_MARGIN + 6);
  }
  edges.sort((a, b) => a - b);
  const candidates: number[] = [];
  for (let i = 0; i + 1 < edges.length; i++) candidates.push((edges[i]! + edges[i + 1]!) / 2);
  if (edges.length) {
    candidates.push(edges[0]! - 12, edges[edges.length - 1]! + 12);
  }
  candidates.sort((a, b) => Math.abs(a - want) - Math.abs(b - want));
  // Two passes: first insist on a lane nobody else is using, then settle for
  // any clear one rather than fail into a detour.
  for (const spread of [true, false]) {
    for (const c of candidates) {
      if (spread && taken.some((t) => Math.abs(t - c) < LANE_APART)) continue;
      if (clear(c, aFrom, aTo, skip)) return c;
    }
  }
  return null;
}

function corridorGap(ranks: Ranks, rankFrom: number): { start: number; end: number } | null {
  const here = ranks.span[rankFrom];
  const next = ranks.span[rankFrom + 1];
  if (!here || !next) return null;
  const start = here.end + CORRIDOR_INSET;
  const end = next.start - CORRIDOR_INSET;
  return end > start ? { start, end } : null;
}

/**
 * Every arrow crossing lanes in the same corridor gets its own slot across it,
 * so two handoffs between the same pair of ranks cannot be drawn on top of
 * each other. Order is by where they leave, which keeps the lines from
 * needlessly crossing inside the corridor.
 */
function assignCorridors(wires: Wire[], ranks: Ranks): void {
  // A wire occupies one gap, or two when it threads across the middle. Both
  // ends are slotted, or a threaded line lands on top of an ordinary one that
  // happens to cross in the same place.
  interface Use {
    w: Wire;
    second: boolean;
    at: number;
  }
  const byRank = new Map<number, Use[]>();
  const claim = (rank: number, use: Use): void => {
    const bucket = byRank.get(rank);
    if (bucket) bucket.push(use);
    else byRank.set(rank, [use]);
  };
  for (const w of wires) {
    // Slot within the gap `classify` chose, which is not always the one right
    // after the source: a long arrow crosses as late as it can get through.
    if (w.shape === "corridor") claim(w.corridorRank, { w, second: false, at: w.portOut });
    else if (w.shape === "cross") {
      claim(w.corridorRank, { w, second: false, at: w.portOut });
      claim(w.corridorRank2, { w, second: true, at: w.portIn });
    }
  }
  for (const [rank, group] of byRank) {
    const gap = corridorGap(ranks, rank)!;
    group.sort((a, b) => a.at - b.at);
    group.forEach((use, k) => {
      const at = gap.start + ((gap.end - gap.start) * (k + 1)) / (group.length + 1);
      if (use.second) use.w.corridor2 = at;
      else use.w.corridor = at;
    });
  }
}

/** The shortest detour takes the inner gutter lane, so long ones cannot cut it off. */
function assignGutterLanes(wires: Wire[], ax: Axis): void {
  for (const shape of ["back", "gutter"] as const) {
    const group = wires
      .filter((w) => w.shape === shape)
      .sort(
        (a, b) =>
          Math.abs(ax.aMid(a.from_.at) - ax.aMid(a.to_.at)) -
          Math.abs(ax.aMid(b.from_.at) - ax.aMid(b.to_.at)),
      );
    group.forEach((w, k) => {
      w.lane = k;
    });
  }
}

// ----------------------------------------------------------------- paths ----

function buildPaths(wires: Wire[], ranks: Ranks, lanes: { min: number; max: number }, ax: Axis): void {
  const groove = new Map<string, number>();
  const stagger = (key: string): number => {
    const k = groove.get(key) ?? 0;
    groove.set(key, k + 1);
    return k;
  };

  for (const w of wires) {
    const s = w.from_.at;
    const t = w.to_.at;
    const P: Pt[] = [];
    const push = (a: number, c: number): void => {
      P.push(ax.pt(a, c));
    };

    if (w.shape === "self") {
      const diamond = w.from_.kind === "decision";
      // A diamond's side is two slants meeting at a tip, not a flat face: the
      // loop's second end is kept close to the tip and brought in to meet the
      // slant, or it stops in empty canvas beside the shape.
      const spread = diamond ? Math.min(20, ax.aLen(s) / 4) : 20;
      const a1 = Math.min(w.portOut, w.portIn);
      const a2 = Math.max(w.portOut, w.portIn) + (w.portOut === w.portIn ? spread : 0);
      const outline = (a: number): number => {
        const halfA = ax.aLen(s) / 2;
        if (!diamond || halfA <= 0) return ax.c1(s);
        const off = Math.min(1, Math.abs(a - ax.aMid(s)) / halfA);
        return ax.cMid(s) + (ax.cLen(s) / 2) * (1 - off);
      };
      const cOut = ax.c1(s) + SELF_OUT;
      push(a1, outline(a1));
      push(a1, cOut);
      push(a2, cOut);
      push(a2, outline(a2));
      w.points = simplify(P);
      continue;
    }

    if (w.shape === "sameRank") {
      const towardsHigh = ax.cMid(t) > ax.cMid(s);
      const c1 = towardsHigh ? ax.c1(s) : ax.c0(s);
      const c2 = towardsHigh ? ax.c0(t) : ax.c1(t);
      push(w.portOut, c1);
      if (Math.abs(w.portOut - w.portIn) >= 1) {
        const mc = (c1 + c2) / 2;
        push(w.portOut, mc);
        push(w.portIn, mc);
      }
      push(w.portIn, c2);
      w.points = simplify(P);
      continue;
    }

    if (w.shape === "straight") {
      push(faceAlong(w.from_, w.portOut, ax, true), w.portOut);
      push(faceAlong(w.to_, w.portIn, ax, false), w.portIn);
      w.points = simplify(P);
      continue;
    }

    if (w.shape === "direct") {
      // A single elbow halfway between the two faces, so it stays orthogonal
      // when the ports are not level.
      const a1 = faceAlong(w.from_, w.portOut, ax, true);
      const a2 = faceAlong(w.to_, w.portIn, ax, false);
      const mid = (a1 + a2) / 2;
      push(a1, w.portOut);
      push(mid, w.portOut);
      push(mid, w.portIn);
      push(a2, w.portIn);
      w.points = simplify(P);
      continue;
    }

    if (w.shape === "corridor") {
      push(faceAlong(w.from_, w.portOut, ax, true), w.portOut);
      push(w.corridor, w.portOut);
      push(w.corridor, w.portIn);
      push(faceAlong(w.to_, w.portIn, ax, false), w.portIn);
      w.points = simplify(P);
      continue;
    }

    if (w.shape === "cross") {
      push(faceAlong(w.from_, w.portOut, ax, true), w.portOut);
      push(w.corridor, w.portOut);
      push(w.corridor, w.crossAt);
      push(w.corridor2, w.crossAt);
      push(w.corridor2, w.portIn);
      push(faceAlong(w.to_, w.portIn, ax, false), w.portIn);
      w.points = simplify(P);
      continue;
    }

    // Outside every lane: backwards rework below the first lane, a forward
    // skip that cannot get through above the last one.
    const back = w.shape === "back";
    const gc = back
      ? lanes.min - GUTTER - w.lane * GUTTER_STEP
      : lanes.max + GUTTER + w.lane * GUTTER_STEP;
    const rankOut = ranks.span[w.rankFrom]!;
    const rankIn = ranks.span[w.rankTo]!;
    const aOut = rankOut.end + GUTTER_TURN + stagger(`o${w.rankFrom}`) * 9;
    const aIn = rankIn.start - GUTTER_TURN - stagger(`i${w.rankTo}`) * 9;
    push(faceAlong(w.from_, w.portOut, ax, true), w.portOut);
    push(aOut, w.portOut);
    push(aOut, gc);
    push(aIn, gc);
    push(aIn, w.portIn);
    push(faceAlong(w.to_, w.portIn, ax, false), w.portIn);
    w.points = simplify(P);
  }
}

// ---------------------------------------------------------------- labels ----

/**
 * The label sits on the longest straight run of its own arrow — the pill is
 * opaque, so it masks the line rather than fighting it — and is nudged along
 * that run when it lands on a label that is already placed.
 */
function placeLabels(wires: Wire[], ax: Axis): void {
  const placed: Array<{ at: Pt; w: number; h: number }> = [];
  for (const w of wires) {
    if (!w.labelLines.length || w.points.length < 2) continue;
    let best: { at: Pt; len: number; along: boolean } | null = null;
    for (let i = 1; i < w.points.length; i++) {
      const p = w.points[i - 1]!;
      const q = w.points[i]!;
      const len = Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]);
      if (!best || len > best.len) {
        best = {
          at: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2],
          len,
          along: Math.abs(ax.ofA({ x: p[0], y: p[1] }) - ax.ofA({ x: q[0], y: q[1] })) > 0.5,
        };
      }
    }
    if (!best) continue;
    let at = best.at;
    for (let attempt = 0; attempt < 6; attempt++) {
      const hit = placed.find(
        (o) =>
          Math.abs(o.at[0] - at[0]) < (o.w + w.lw) / 2 + 6 &&
          Math.abs(o.at[1] - at[1]) < (o.h + w.lh) / 2 + 6,
      );
      if (!hit) break;
      const shift = best.along ? (w.lh + hit.h) / 2 + 8 : (w.lw + hit.w) / 2 + 8;
      // Nudge across the run, not along it: the label stays on its own arrow.
      at = best.along ? ax.pt(ax.ofA({ x: at[0], y: at[1] }), ax.ofC({ x: at[0], y: at[1] }) + shift)
                      : ax.pt(ax.ofA({ x: at[0], y: at[1] }) + shift, ax.ofC({ x: at[0], y: at[1] }));
    }
    w.labelAt = at;
    placed.push({ at, w: w.lw, h: w.lh });
  }
}

// ---------------------------------------------------------------- reflow ----

export interface ReflowedActivity extends RoutedActivity {
  /** Steps no longer where the layout pass put them. */
  moved: string[];
  /** Steps now sitting in a different lane than the graph says they belong to. */
  relaned: Array<{ id: string; from: string; to: string | null }>;
}

/**
 * Re-route a drawn activity from where its steps are NOW.
 *
 * The lanes are NOT re-flowed and the steps are not moved back: the canvas is
 * the truth. When a step has been dragged into another lane's band the graph
 * is not silently rewritten — the move is reported, so the caller can decide
 * whether the process really changed hands.
 */
export function reflowActivity(
  graph: ActivityGraph,
  placed: Map<string, Placement>,
  lanePlaced?: Map<string, Placement>,
): ReflowedActivity {
  const ax = new Axis(graph.rankdir === "TB");
  const steps: StepPlace[] = [];
  const moved: string[] = [];
  const relaned: ReflowedActivity["relaned"] = [];
  const lanes: LanePlace[] = graph.lanes.map((l) => ({
    id: l.id,
    at: lanePlaced?.get(l.id) ?? l.at,
  }));

  for (const n of graph.nodes) {
    const at = placed.get(n.id);
    if (!at) continue;
    steps.push({ id: n.id, kind: n.kind, cls: n.cls, lane: n.lane, at });
    if (!samePlace(n.at, at)) moved.push(n.id);
    // A diagram with no lanes has no lane to be moved out of.
    if (lanes.length) {
      const band = laneAt(lanes, at, ax);
      if (band !== n.lane) relaned.push({ id: n.id, from: n.lane, to: band });
    }
  }

  const routed = routeActivity({
    rankdir: graph.rankdir,
    colorByTarget: graph.colorByTarget,
    lanes,
    steps,
    edges: graph.edges,
  });
  return { ...routed, moved, relaned };
}

/** Which lane band holds the centre of this box? */
function laneAt(lanes: LanePlace[], at: Placement, ax: Axis): string | null {
  const c = ax.cMid(at);
  for (const l of lanes) {
    if (c >= ax.c0(l.at) && c <= ax.c1(l.at)) return l.id;
  }
  return null;
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
