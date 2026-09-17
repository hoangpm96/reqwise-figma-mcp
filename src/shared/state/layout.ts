/**
 * Layout for a state machine.
 *
 * dagre decides the ORDER (which state comes before which); the rest is rank
 * slots along the flow, which is what leaves a box-free corridor between ranks
 * for the router. The router itself is the activity one — it is a pure
 * function of where the boxes are, and with no lanes to answer to it is simply
 * the orthogonal graph router this repo already has. Sharing it is why a state
 * diagram gets self-transitions, diamond branch spreading, hand-dragged
 * connection points and outer-gutter rework paths for free.
 *
 * The sizing is NOT shared, because a UML state is not an activity step: the
 * name sits in its own compartment above a rule, and `entry / do / exit` sit
 * below it. That separator is what makes a reader read "state" and not "step".
 */
import dagre from "@dagrejs/dagre";
import { ARROW, Axis, r2, type Pt } from "../diagram/geometry.js";
import { headerHeight, lineHeight, splitLines, textWidth, wrapText } from "../diagram/metrics.js";
import { INK, PALETTE } from "../diagram/palette.js";
import { routeActivity, type StepPlace } from "../activity/route.js";
import type { DrawEdge, FlowClass, Placement } from "../diagram/types.js";
import type {
  DrawState,
  StateDraw,
  StateGraph,
  StateKind,
  StateNodeSpec,
  StateOptions,
  TransitionSpec,
} from "./types.js";

const PAD = 40;
const HEADER = 96;
/** Along gap between ranks — this is the router's corridor. */
const RANK_GAP = 96;
/** The starting dot, and the outer ring of a final state. */
const DOT = 20;
const RING = 26;
const RING_INNER = 13;
/** Clear space a crossing label wants either side of itself in that gap. */
const LABEL_ROOM = 30;
/** Along thickness of a fork/join bar, and its cross length. */
const BAR_THICK = 10;
const BAR_LONG = 150;
/** Inside a state box. */
const BOX_PAD_X = 16;
const BOX_PAD_Y = 12;
const BOX_MIN_W = 148;

interface Sized {
  id: string;
  kind: StateKind;
  cls: FlowClass;
  titleLines: string[];
  bodyLines: string[];
  /** Length with the flow, and across it. */
  aLen: number;
  cLen: number;
  /**
   * The same two lengths with the caption drawn OUTSIDE the shape included,
   * grown evenly about the shape's centre so the shape stays where dagre
   * centred it. See footprint.
   */
  footA: number;
  footC: number;
  /** Filled in by placement. */
  at: Placement;
  /** dagre's cross position — only used to ORDER the states. */
  order: number;
  rank: number;
}

/** A state before the layout knows how much room its caption takes. */
type Shape = Omit<Sized, "footA" | "footC">;

export interface StateLayout {
  states: DrawState[];
  edges: DrawEdge[];
  graph: StateGraph;
  w: number;
  h: number;
  finals: number;
  selfTransitions: number;
}

export function layoutState(
  nodes: StateNodeSpec[],
  transitions: TransitionSpec[],
  options: StateOptions,
  subtitle = "",
): StateLayout {
  const rankdir = options.rankdir === "TB" ? "TB" : "LR";
  const ax = new Axis(rankdir === "TB");
  const sized = nodes.map((n) => footprint(sizeState(n, ax), ax));

  rankWithDagre(sized, transitions, ax, rankdir);

  // ---- ranks, in flow order ----
  const rankKeys = Array.from(new Set(sized.map((s) => s.rank))).sort((a, b) => a - b);
  const rankIndex = new Map<number, number>();
  rankKeys.forEach((k, i) => rankIndex.set(k, i));
  for (const s of sized) s.rank = rankIndex.get(s.rank)!;

  // The gap between two ranks is decided by the LABELS that cross it. A
  // transition label is a whole sentence here (`event [guard] / action`), and
  // a fixed 96px corridor leaves it nowhere to sit but on top of a state —
  // which is exactly what the first live run drew.
  const byId = new Map(sized.map((s) => [s.id, s]));
  const gaps = new Array(Math.max(0, rankKeys.length - 1)).fill(RANK_GAP);
  for (const t of transitions) {
    const a = byId.get(t.from);
    const b = byId.get(t.to);
    if (!a || !b || a === b) continue;
    const lo = Math.min(a.rank, b.rank);
    if (Math.abs(a.rank - b.rank) !== 1 || lo >= gaps.length) continue;
    const m = measureLabel(transitionLabel(t));
    if (!m.labelLines.length) continue;
    gaps[lo] = Math.max(gaps[lo], (ax.vertical ? m.lh : m.lw) + LABEL_ROOM);
  }

  const rankSpan: Array<{ start: number; aLen: number }> = [];
  let cursorA = 0;
  for (let rank = 0; rank < rankKeys.length; rank++) {
    let aLen = 0;
    for (const s of sized) if (s.rank === rank) aLen = Math.max(aLen, s.footA);
    rankSpan.push({ start: cursorA, aLen });
    cursorA += aLen + (gaps[rank] ?? RANK_GAP);
  }

  // Keep dagre's cross coordinates: it balances a state between the ones that
  // lead into it and the ones it leads to, which with no lanes is exactly the
  // judgement wanted. Only the along positions come from the rank slots, so
  // the corridors between ranks survive for the router.
  for (const s of sized) {
    const span = rankSpan[s.rank]!;
    s.at = ax.box(span.start + (span.aLen - s.aLen) / 2, s.order - s.cLen / 2, s.aLen, s.cLen);
  }
  let minC = Infinity;
  for (const s of sized) minC = Math.min(minC, ax.c0(s.at));
  if (Number.isFinite(minC) && minC !== 0) {
    for (const s of sized) s.at = ax.box(ax.a0(s.at), ax.c0(s.at) - minC, s.aLen, s.cLen);
  }

  // ---- route on those placements ----
  const places: StepPlace[] = sized.map((s) => ({
    id: s.id,
    // The router speaks the activity vocabulary; only three of its kinds
    // change how an arrow leaves a shape, and those three are the same idea
    // here (a diamond exits by its tips, a bar spreads along its length).
    kind: routerKind(s.kind),
    cls: s.cls,
    lane: "",
    at: s.at,
    ...(isRound(s.kind) ? { singlePort: true } : {}),
  }));
  const wires = transitions.map((t) => ({
    from: t.from,
    to: t.to,
    kind: (t.kind === "return" ? "return" : "forward") as "forward" | "return",
    ...measureLabel(transitionLabel(t)),
    ...(typeof t.fromAt === "number" ? { fromAt: t.fromAt } : {}),
    ...(typeof t.toAt === "number" ? { toAt: t.toAt } : {}),
    ...(t.fromSide ? { fromPort: { side: t.fromSide, at: t.fromAt ?? 0.5 } } : {}),
    ...(t.toSide ? { toPort: { side: t.toSide, at: t.toAt ?? 0.5 } } : {}),
  }));
  // A dot's, a ring's or a bar's name is drawn OUTSIDE its shape, where the
  // router cannot see it. Three final states stacked in one rank put three
  // captions right where the arrows into them fan out, and every label pill
  // landed on one — so the captions go to the router as label obstacles.
  const outsides = sized
    .map((s) => outsideAt(s, ax))
    .filter((at): at is Placement => at !== null);
  const routed = routeActivity({
    rankdir,
    colorByTarget: options.colorByTarget !== false,
    lanes: [],
    steps: places,
    edges: wires,
    obstacles: outsides,
  });

  // ---- shift everything into the frame, under the title block ----
  // The captions are part of the diagram's extent too: leaving them out ran
  // the last state's caption off the frame.
  const shift = boundsShift(places.map((p) => p.at).concat(outsides), routed.edges, subtitle);
  const move = (at: Placement): Placement => ({
    x: r2(at.x + shift.dx),
    y: r2(at.y + shift.dy),
    w: at.w,
    h: at.h,
  });
  const movePt = (p: Pt): Pt => [r2(p[0] + shift.dx), r2(p[1] + shift.dy)];

  const drawStates = sized.map((s) => drawState(s, move, ax));
  const drawEdges: DrawEdge[] = routed.edges.map((e) => ({
    ...e,
    points: e.points.map(movePt),
    ...(e.label
      ? { label: { ...e.label, x: r2(e.label.x + shift.dx), y: r2(e.label.y + shift.dy) } }
      : {}),
  }));

  const graph: StateGraph = {
    kind: "state",
    rankdir,
    colorByTarget: options.colorByTarget !== false,
    liveRoute: options.liveRoute !== false,
    nodes: drawStates.map((d, i) => ({
      id: d.id,
      kind: d.kind,
      cls: sized[i]!.cls,
      at: d.at,
    })),
    edges: wires,
  };

  return {
    states: drawStates,
    edges: drawEdges,
    graph,
    w: Math.ceil(shift.maxX + shift.dx + PAD),
    h: Math.ceil(shift.maxY + shift.dy + PAD),
    finals: sized.filter((s) => s.kind === "final").length,
    selfTransitions: transitions.filter((t) => t.from === t.to).length,
  };
}

/**
 * `event [guard] / action` — the UML sentence, in that order. A reader who
 * knows the notation gets the trigger, the condition and the side effect from
 * the shape of the label alone.
 */
export function transitionLabel(t: TransitionSpec): string {
  const event = (t.event ?? "").trim();
  const guard = (t.guard ?? "").trim();
  const action = (t.action ?? "").trim();
  let head = event;
  if (guard) head = head ? `${head} [${guard}]` : `[${guard}]`;
  if (!action) return head;
  return head ? `${head} / ${action}` : `/ ${action}`;
}

/** Drawn as a circle: the starting dot and a final ring. */
function isRound(kind: StateKind): boolean {
  return kind === "initial" || kind === "final";
}

function routerKind(kind: StateKind): StepPlace["kind"] {
  if (kind === "choice") return "decision";
  if (kind === "fork" || kind === "join") return kind;
  if (kind === "initial") return "start";
  if (kind === "final") return "end";
  return "action";
}

// ---------------------------------------------------------------- sizing ----

function sizeState(n: StateNodeSpec, ax: Axis): Shape {
  const kind = n.kind ?? "state";
  const cls: FlowClass = n.cls ?? (kind === "choice" ? "decision" : "plain");
  const label = (n.label ?? "").trim();
  const base = {
    id: n.id,
    kind,
    cls,
    at: { x: 0, y: 0, w: 0, h: 0 },
    order: 0,
    rank: 0,
  };

  if (kind === "initial" || kind === "final") {
    // A dot has no room for text: the name, when there is one, is drawn
    // beside it (see drawState) and does not change the footprint.
    const size = kind === "initial" ? DOT : RING;
    return {
      ...base,
      titleLines: label ? [label] : [],
      bodyLines: [],
      aLen: size,
      cLen: size,
    };
  }

  if (kind === "fork" || kind === "join") {
    return {
      ...base,
      titleLines: label ? [label] : [],
      bodyLines: [],
      aLen: BAR_THICK,
      cLen: BAR_LONG,
    };
  }

  if (kind === "choice") {
    const lines: string[] = [];
    for (const l of splitLines(label || n.id)) for (const w of wrapText(l, 30)) lines.push(w);
    let textW = 0;
    for (const l of lines) textW = Math.max(textW, textWidth(l, 11));
    const textH = lines.length * lineHeight(11);
    const h = Math.max(64, 2 * textH + 40);
    const ratio = Math.max(0.35, 1 - textH / h);
    const w = Math.max(130, Math.ceil(textW / ratio) + 24);
    return {
      ...base,
      titleLines: lines,
      bodyLines: [],
      aLen: ax.vertical ? h : w,
      cLen: ax.vertical ? w : h,
    };
  }

  const titleLines = wrapText(label || n.id, 24);
  const bodyLines = stateBody(n);
  let w = BOX_MIN_W;
  for (const l of titleLines) w = Math.max(w, textWidth(l, 13) + BOX_PAD_X * 2);
  for (const l of bodyLines) w = Math.max(w, textWidth(l, 11) + BOX_PAD_X * 2);
  const h =
    BOX_PAD_Y +
    titleLines.length * lineHeight(13) +
    (bodyLines.length ? RULE_GAP * 2 + 1 + bodyLines.length * lineHeight(11) : 0) +
    BOX_PAD_Y;
  return {
    ...base,
    titleLines,
    bodyLines,
    aLen: ax.vertical ? h : w,
    cLen: ax.vertical ? w : h,
  };
}

/**
 * How much room a state needs, caption included.
 *
 * sizeState gives the SHAPE, and a ring's name was said not to change the
 * footprint — which is true for the ring and false for the diagram. In TB the
 * name sits beside the ring, across the flow, and dagre spaced stacked final
 * states by the ring alone: each caption ran over the next ring. In LR it sits
 * under the ring and wider than it, reaching into the corridor the labels of
 * the arrows into that rank need. Both are the caption being left out of the
 * space the layout hands out.
 *
 * Grown evenly on both sides of the shape, not just on the caption's side:
 * dagre centres the box it is given, and the shape has to stay at that centre
 * or the straight arrow into it gains a jog.
 */
function footprint(s: Shape, ax: Axis): Sized {
  const out = outsideAt({ ...s, at: ax.box(0, 0, s.aLen, s.cLen) }, ax);
  if (!out) return { ...s, footA: s.aLen, footC: s.cLen };
  const reach = (lo: number, hi: number, len: number): number =>
    2 * Math.max(len / 2, len / 2 - lo, hi - len / 2);
  return {
    ...s,
    footA: reach(ax.a0(out), ax.a1(out), s.aLen),
    footC: reach(ax.c0(out), ax.c1(out), s.cLen),
  };
}

/** Space above and below the separator rule inside a state box. */
const RULE_GAP = 8;

/**
 * The activity compartment, one line each, in UML's order. `detail` follows as
 * a plain line: it is the caller's note about the state, not a behaviour.
 */
export function stateBody(n: StateNodeSpec): string[] {
  const out: string[] = [];
  const push = (prefix: string, raw?: string): void => {
    const v = (raw ?? "").trim();
    if (!v) return;
    for (const line of splitLines(v)) {
      for (const w of wrapText(prefix ? `${prefix} / ${line}` : line, 30)) out.push(w);
      prefix = "";
    }
  };
  push("entry", n.entry);
  push("do", n.do);
  push("exit", n.exit);
  push("", n.detail);
  return out;
}

// ----------------------------------------------------------------- ranks ----

/**
 * dagre for the rank order only. A state machine is full of cycles — that is
 * what makes it a machine — and dagre breaks them itself; what it must NOT see
 * is a self-transition or an explicit way-back, which would stretch every rank
 * the arrow flies over for no reading benefit.
 */
function rankWithDagre(
  sized: Sized[],
  transitions: TransitionSpec[],
  ax: Axis,
  rankdir: "TB" | "LR",
): void {
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir, nodesep: 34, ranksep: RANK_GAP, edgesep: 12, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));
  const ids = new Set(sized.map((s) => s.id));
  for (const s of sized) {
    const box = ax.box(0, 0, s.footA, s.footC);
    g.setNode(s.id, { width: box.w, height: box.h });
  }
  let key = 0;
  for (const t of transitions) {
    if (t.from === t.to || t.kind === "return") continue;
    if (!ids.has(t.from) || !ids.has(t.to)) continue;
    g.setEdge(t.from, t.to, { minlen: 1 }, `e${key++}`);
  }
  dagre.layout(g);
  for (const s of sized) {
    const p = g.node(s.id) as { x: number; y: number } | undefined;
    s.rank = p ? Math.round(ax.ofA(p)) : 0;
    s.order = p ? ax.ofC(p) : 0;
  }
}

// ------------------------------------------------------------------ emit ----

function boundsShift(
  states: Placement[],
  edges: DrawEdge[],
  subtitle: string,
): { dx: number; dy: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const acc = (x: number, y: number, w = 0, h = 0): void => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  };
  for (const at of states) acc(at.x, at.y, at.w, at.h);
  for (const e of edges) {
    for (const p of e.points) acc(p[0] - ARROW, p[1] - ARROW, ARROW * 2, ARROW * 2);
    if (e.label) acc(e.label.x, e.label.y, e.label.w, e.label.h);
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 0;
    maxY = 0;
  }
  // The frame's width is known here — it is the content plus its two
  // margins — so the title block can be MEASURED against the width its
  // subtitle will really be wrapped to, instead of assuming one line. See
  // headerHeight: one line still lands on 96, so nothing already drawn moves.
  const w = Math.ceil(maxX + (PAD - minX) + PAD);
  return { dx: PAD - minX, dy: headerHeight(subtitle, w) - minY, maxX, maxY };
}

function drawState(s: Sized, move: (at: Placement) => Placement, ax: Axis): DrawState {
  const at = move(s.at);
  const pal = PALETTE[s.cls] ?? PALETTE.plain;
  const title = s.titleLines.join("\n");
  const common = {
    id: s.id,
    name: `state:${s.id} · ${s.titleLines[0] ?? s.id}`,
    kind: s.kind,
    at,
    title,
    body: s.bodyLines,
  };

  const out = outsideAt(s, ax);
  const outside = out ? { outside: { at: move(out), align: outsideAlign(s, ax) } } : {};

  if (s.kind === "initial") {
    return { ...common, fill: INK, stroke: INK, strokeWeight: 0, radius: at.w / 2, ...outside };
  }

  if (s.kind === "final") {
    const pad = (at.w - RING_INNER) / 2;
    return {
      ...common,
      fill: "#ffffff",
      stroke: s.cls === "plain" ? INK : pal.stroke,
      strokeWeight: 1.5,
      radius: at.w / 2,
      inner: { x: r2(at.x + pad), y: r2(at.y + pad), w: RING_INNER, h: RING_INNER },
      ...outside,
    };
  }

  if (s.kind === "fork" || s.kind === "join") {
    return {
      ...common,
      fill: INK,
      stroke: INK,
      strokeWeight: 0,
      radius: 3,
      ...outside,
    };
  }

  if (s.kind === "choice") {
    return {
      ...common,
      fill: pal.fill,
      stroke: pal.stroke,
      strokeWeight: 1.5,
      radius: 0,
      ...outside,
    };
  }

  const ruleY = s.bodyLines.length
    ? r2(BOX_PAD_Y + s.titleLines.length * lineHeight(13) + RULE_GAP)
    : undefined;
  return {
    ...common,
    fill: pal.fill,
    stroke: pal.stroke,
    strokeWeight: 1.5,
    radius: 12,
    ...(ruleY !== undefined ? { ruleY } : {}),
  };
}

/**
 * Where the text that a shape cannot hold goes, in PRE-shift coordinates so
 * the frame can be sized around it. A diamond's question sits in the middle of
 * it; a dot's or a bar's name sits beside it, across the flow, where no
 * transition is running.
 */
function outsideAt(s: Shape, ax: Axis): Placement | null {
  if (!s.titleLines.length) return null;
  const at = s.at;
  const h = s.titleLines.length * lineHeight(11);
  if (s.kind === "choice") {
    return { x: r2(at.x + 12), y: r2(at.y + at.h / 2 - h / 2), w: at.w - 24, h };
  }
  if (s.kind === "state") return null;
  const w = Math.max(...s.titleLines.map((l) => textWidth(l, 11))) + 8;
  return ax.vertical
    ? { x: r2(at.x + at.w + 10), y: r2(at.y + at.h / 2 - h / 2), w, h }
    : { x: r2(at.x + at.w / 2 - w / 2), y: r2(at.y + at.h + 8), w, h };
}

function outsideAlign(s: Sized, ax: Axis): "CENTER" | "LEFT" {
  if (s.kind === "choice") return "CENTER";
  return ax.vertical ? "LEFT" : "CENTER";
}

function measureLabel(label: string): { labelLines: string[]; lw: number; lh: number } {
  const lines: string[] = [];
  for (const l of splitLines(label)) for (const w of wrapText(l, 30)) lines.push(w);
  if (!lines.length) return { labelLines: [], lw: 0, lh: 0 };
  let w = 0;
  for (const l of lines) w = Math.max(w, textWidth(l, 11));
  return { labelLines: lines, lw: Math.ceil(w) + 18, lh: lines.length * lineHeight(11) + 8 };
}

export function emitStateDraw(
  laid: StateLayout,
  meta: { name: string; title: string; subtitle: string; x: number; y: number; parentId?: string },
  options: StateOptions,
): StateDraw {
  return {
    name: meta.name,
    title: meta.title,
    subtitle: meta.subtitle,
    x: meta.x,
    y: meta.y,
    w: laid.w,
    h: laid.h,
    ...(meta.parentId ? { parentId: meta.parentId } : {}),
    states: laid.states,
    edges: laid.edges,
    font: options.font || "Inter",
    graph: laid.graph,
  };
}

// ---------------------------------------------------------------- reflow ----

export interface ReflowedState {
  edges: DrawEdge[];
  /** Transition ids whose state is gone from the canvas. */
  dropped: string[];
  /** States no longer where the layout pass put them. */
  moved: string[];
}

/**
 * Re-route a drawn machine from where its states are NOW. The states are not
 * moved back: the canvas is the truth, and the router is the same pure
 * function of box positions that the layout pass used.
 */
export function reflowState(graph: StateGraph, placed: Map<string, Placement>): ReflowedState {
  const steps: StepPlace[] = [];
  const moved: string[] = [];
  for (const n of graph.nodes) {
    const at = placed.get(n.id);
    if (!at) continue;
    steps.push({
      id: n.id,
      kind: routerKind(n.kind),
      cls: n.cls,
      lane: "",
      at,
      ...(isRound(n.kind) ? { singlePort: true } : {}),
    });
    if (!samePlace(n.at, at)) moved.push(n.id);
  }
  const routed = routeActivity({
    rankdir: graph.rankdir,
    colorByTarget: graph.colorByTarget,
    lanes: [],
    steps,
    edges: graph.edges,
  });
  return { edges: routed.edges, dropped: routed.dropped, moved };
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
