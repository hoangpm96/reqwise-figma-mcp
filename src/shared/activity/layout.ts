/**
 * Lane-constrained layout for a swimlane activity diagram.
 *
 * dagre decides the ORDER of the steps (which comes before which) and nothing
 * else: the cross axis belongs to the lanes, because a step drawn outside its
 * own lane is simply wrong, however good the graph layout was. So dagre's
 * rank positions are kept, its cross positions are thrown away, and each rank
 * packs its steps inside the band of the lane that performs them.
 *
 * The along-gap between two ranks is deliberately generous: it is the corridor
 * the router uses to move an arrow across lanes without cutting through
 * anybody's step (see ./route.ts).
 */
import dagre from "@dagrejs/dagre";
import { ARROW, Axis, r2, type Pt } from "../diagram/geometry.js";
import { headerHeight, lineHeight, splitLines, textWidth, wrapText } from "../diagram/metrics.js";
import { DEFAULT_FONT, INK, PALETTE } from "../diagram/palette.js";
import type { DrawEdge, FlowClass, Placement } from "../diagram/types.js";
import { routeActivity, type StepPlace } from "./route.js";
import type {
  ActivityDraw,
  ActivityGraph,
  ActivityKind,
  ActivityNodeSpec,
  ActivityOptions,
  ActivityEdgeSpec,
  DrawLane,
  DrawStep,
  LaneSpec,
} from "./types.js";

const PAD = 40;
const HEADER = 96;
/**
 * Thickness of the lane label strip at the along-start of every band. Wide
 * enough for the lane name to read HORIZONTALLY: rotating the label would mean
 * betting on Figma's rotation pivot, and a wide strip costs one column of
 * pixels instead of a whole class of transform bugs.
 */
const LANE_HEADER_LR = 96;
const LANE_HEADER_TB = 48;
/** Cross padding inside a band. */
const LANE_PAD = 22;
const LANE_MIN = 104;
/** Cross gap between two steps that share a rank AND a lane. */
const STEP_GAP = 22;
/** Along gap between ranks — this is the router's corridor. */
const RANK_GAP = 96;
/** Along thickness of a fork/join bar, and its default cross length. */
const BAR_THICK = 10;
const BAR_LONG = 150;

const LANE_FILL = ["#ffffff", "#fafbfd"];
const LANE_HEADER_FILL = "#eef2f7";
const LANE_STROKE = "#dfe4ea";

interface Sized {
  id: string;
  kind: ActivityKind;
  cls: FlowClass;
  lane: string;
  titleLines: string[];
  detailLines: string[];
  /** Length with the flow, and across it. */
  aLen: number;
  cLen: number;
  textW: number;
  textH: number;
  /** Filled in by placement. */
  at: Placement;
  /** dagre's cross position — only used to ORDER steps inside a lane. */
  order: number;
  rank: number;
}

export interface ActivityLayout {
  lanes: DrawLane[];
  steps: DrawStep[];
  edges: DrawEdge[];
  graph: ActivityGraph;
  w: number;
  h: number;
  handoffs: number;
  returnEdges: number;
}

export function layoutActivity(
  laneSpecs: LaneSpec[],
  nodes: ActivityNodeSpec[],
  edges: ActivityEdgeSpec[],
  options: ActivityOptions,
  subtitle = "",
): ActivityLayout {
  const rankdir = options.rankdir === "TB" ? "TB" : "LR";
  const ax = new Axis(rankdir === "TB");
  // No lanes declared = a plain activity diagram: same notation (start/end,
  // decisions, fork/join, rework paths), no bands, and dagre's cross positions
  // are kept because nothing is constraining them any more.
  const laneless = laneSpecs.length === 0;
  const LANE_HEADER = laneless ? 0 : ax.vertical ? LANE_HEADER_TB : LANE_HEADER_LR;
  const sized = nodes.map((n) => sizeStep(n, ax));
  const byId = new Map<string, Sized>();
  for (const s of sized) byId.set(s.id, s);

  rankWithDagre(sized, edges, ax, rankdir);

  // ---- ranks, in flow order ----
  const rankKeys = Array.from(new Set(sized.map((s) => s.rank))).sort((a, b) => a - b);
  const rankIndex = new Map<number, number>();
  rankKeys.forEach((k, i) => rankIndex.set(k, i));
  for (const s of sized) s.rank = rankIndex.get(s.rank)!;
  const rankCount = rankKeys.length;

  const inRank = (rank: number, lane: string): Sized[] =>
    sized
      .filter((s) => s.rank === rank && s.lane === lane)
      .sort((a, b) => a.order - b.order);

  // ---- lane thickness: the widest a lane ever has to be ----
  const laneThickness = new Map<string, number>();
  for (const lane of laneSpecs) {
    let widest = 0;
    for (let rank = 0; rank < rankCount; rank++) {
      const group = inRank(rank, lane.id);
      if (!group.length) continue;
      let sum = STEP_GAP * (group.length - 1);
      for (const s of group) sum += s.cLen;
      widest = Math.max(widest, sum);
    }
    laneThickness.set(lane.id, Math.max(LANE_MIN, widest + LANE_PAD * 2));
  }

  // ---- band cross positions, in declared order ----
  const bands = new Map<string, { c0: number; cLen: number }>();
  let cursorC = 0;
  for (const lane of laneSpecs) {
    const cLen = laneThickness.get(lane.id)!;
    bands.set(lane.id, { c0: cursorC, cLen });
    cursorC += cLen;
  }
  const bandTotal = cursorC;

  // ---- rank along positions ----
  const rankSpan: Array<{ start: number; aLen: number }> = [];
  let cursorA = LANE_HEADER + LANE_PAD;
  for (let rank = 0; rank < rankCount; rank++) {
    let aLen = 0;
    for (const s of sized) if (s.rank === rank) aLen = Math.max(aLen, s.aLen);
    rankSpan.push({ start: cursorA, aLen });
    cursorA += aLen + RANK_GAP;
  }
  const alongTotal = Math.max(LANE_HEADER + LANE_PAD * 2, cursorA - RANK_GAP + LANE_PAD);

  // ---- place every step ----
  if (laneless) placeByRankOrder(sized, rankSpan, ax);
  for (const lane of laneSpecs) {
    const band = bands.get(lane.id)!;
    for (let rank = 0; rank < rankCount; rank++) {
      const group = inRank(rank, lane.id);
      if (!group.length) continue;
      let total = STEP_GAP * (group.length - 1);
      for (const s of group) total += s.cLen;
      let c = band.c0 + (band.cLen - total) / 2;
      const span = rankSpan[rank]!;
      for (const s of group) {
        const a = span.start + (span.aLen - s.aLen) / 2;
        s.at = ax.box(a, c, s.aLen, s.cLen);
        c += s.cLen + STEP_GAP;
      }
    }
  }

  // ---- route on those placements ----
  const places: StepPlace[] = sized.map((s) => ({
    id: s.id,
    kind: s.kind,
    cls: s.cls,
    lane: s.lane,
    at: s.at,
  }));
  const lanePlaces = laneSpecs.map((lane) => {
    const band = bands.get(lane.id)!;
    return { id: lane.id, at: ax.box(0, band.c0, alongTotal, band.cLen) };
  });
  void bandTotal;
  const wires = edges.map((e) => ({
    from: e.from,
    to: e.to,
    kind: (e.kind === "return" ? "return" : "forward") as "forward" | "return",
    ...measureLabel(e.label),
    ...(typeof e.fromAt === "number" ? { fromAt: e.fromAt } : {}),
    ...(typeof e.toAt === "number" ? { toAt: e.toAt } : {}),
    ...(e.fromSide ? { fromPort: { side: e.fromSide, at: e.fromAt ?? 0.5 } } : {}),
    ...(e.toSide ? { toPort: { side: e.toSide, at: e.toAt ?? 0.5 } } : {}),
  }));
  const routed = routeActivity({
    rankdir,
    colorByTarget: options.colorByTarget !== false,
    lanes: lanePlaces,
    steps: places,
    edges: wires,
  });

  // ---- shift everything into the frame, under the title block ----
  const shift = boundsShift(lanePlaces.map((l) => l.at), places.map((p) => p.at), routed.edges, subtitle);
  const move = (at: Placement): Placement => ({
    x: r2(at.x + shift.dx),
    y: r2(at.y + shift.dy),
    w: at.w,
    h: at.h,
  });
  const movePt = (p: Pt): Pt => [r2(p[0] + shift.dx), r2(p[1] + shift.dy)];

  const drawLanes: DrawLane[] = laneSpecs.map((lane, i) => {
    const band = bands.get(lane.id)!;
    return {
      id: lane.id,
      label: lane.label,
      ...(lane.detail ? { detail: lane.detail } : {}),
      at: move(ax.box(0, band.c0, alongTotal, band.cLen)),
      header: move(ax.box(0, band.c0, LANE_HEADER, band.cLen)),
      fill: LANE_FILL[i % LANE_FILL.length]!,
      headerFill: LANE_HEADER_FILL,
      stroke: LANE_STROKE,
    };
  });

  const drawSteps: DrawStep[] = sized.map((s) => drawStep(s, move, ax));
  const drawEdges: DrawEdge[] = routed.edges.map((e) => ({
    ...e,
    points: e.points.map(movePt),
    ...(e.label
      ? { label: { ...e.label, x: r2(e.label.x + shift.dx), y: r2(e.label.y + shift.dy) } }
      : {}),
  }));

  const graph: ActivityGraph = {
    kind: "activity",
    rankdir,
    colorByTarget: options.colorByTarget !== false,
    liveRoute: options.liveRoute !== false,
    lanes: drawLanes.map((l) => ({ id: l.id, at: l.at })),
    nodes: drawSteps.map((step, i) => ({
      id: step.id,
      kind: step.kind,
      cls: sized[i]!.cls,
      lane: sized[i]!.lane,
      at: step.at,
    })),
    edges: wires,
  };

  const handoffs = edges.filter((e) => {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    return a && b && a.lane !== b.lane;
  }).length;

  return {
    lanes: drawLanes,
    steps: drawSteps,
    edges: drawEdges,
    graph,
    w: Math.ceil(shift.maxX + shift.dx + PAD),
    h: Math.ceil(shift.maxY + shift.dy + PAD),
    handoffs,
    returnEdges: wires.filter((w) => w.kind === "return").length,
  };
}

/**
 * Placement with no lanes to answer to: keep dagre's cross coordinates (it
 * balances a step between its parents and its children, which is exactly the
 * judgement a lane normally overrules) and only take the along positions from
 * the rank slots, so the corridors between ranks still exist for the router.
 */
function placeByRankOrder(sized: Sized[], rankSpan: Array<{ start: number; aLen: number }>, ax: Axis): void {
  for (const s of sized) {
    const span = rankSpan[s.rank]!;
    const a = span.start + (span.aLen - s.aLen) / 2;
    s.at = ax.box(a, s.order - s.cLen / 2, s.aLen, s.cLen);
  }
  // dagre centres its layout on zero; shift the diagram back into the frame.
  let min = Infinity;
  for (const s of sized) min = Math.min(min, ax.c0(s.at));
  if (!Number.isFinite(min) || min === 0) return;
  for (const s of sized) {
    s.at = ax.box(ax.a0(s.at), ax.c0(s.at) - min, s.aLen, s.cLen);
  }
}

// ---------------------------------------------------------------- sizing ----

function sizeStep(n: ActivityNodeSpec, ax: Axis): Sized {
  const kind = n.kind ?? "action";
  const cls: FlowClass = n.cls ?? (kind === "decision" ? "decision" : "plain");
  const raw = splitLines(n.label);
  const head = raw.length ? raw[0]! : n.id;
  const rest = raw.slice(1);
  if (n.detail) for (const l of splitLines(n.detail)) rest.push(l);

  const base = {
    id: n.id,
    kind,
    cls,
    // checkActivity has already resolved this: a real lane id, the "(no lane)"
    // band, or "" for a diagram with no lanes at all.
    lane: n.lane ?? "",
    at: { x: 0, y: 0, w: 0, h: 0 },
    order: 0,
    rank: 0,
  };

  if (kind === "fork" || kind === "join") {
    const label = [head].concat(rest).join(" ");
    const textW = label ? textWidth(label, 11) : 0;
    return {
      ...base,
      titleLines: label ? [label] : [],
      detailLines: [],
      aLen: BAR_THICK,
      cLen: BAR_LONG,
      textW,
      textH: label ? lineHeight(11) : 0,
    };
  }

  if (kind === "decision") {
    const lines: string[] = [];
    for (const l of [head].concat(rest)) for (const w of wrapText(l, 30)) lines.push(w);
    let textW = 0;
    for (const l of lines) textW = Math.max(textW, textWidth(l, 11));
    const textH = lines.length * lineHeight(11);
    const h = Math.max(64, 2 * textH + 40);
    const ratio = Math.max(0.35, 1 - textH / h);
    const w = Math.max(130, Math.ceil(textW / ratio) + 24);
    return {
      ...base,
      titleLines: lines,
      detailLines: [],
      aLen: ax.vertical ? h : w,
      cLen: ax.vertical ? w : h,
      textW: textW + 8,
      textH,
    };
  }

  if (kind === "start" || kind === "end") {
    const line = head;
    const w = Math.max(96, textWidth(line, 12) + 40);
    const h = 40;
    return {
      ...base,
      titleLines: [line],
      detailLines: [],
      aLen: ax.vertical ? h : w,
      cLen: ax.vertical ? w : h,
      textW: w,
      textH: h,
    };
  }

  const titleLines = wrapText(head, 26);
  const detailLines: string[] = [];
  for (const l of rest) for (const w of wrapText(l, 30)) detailLines.push(w);
  let w = 132;
  for (const l of titleLines) w = Math.max(w, textWidth(l, 13));
  for (const l of detailLines) w = Math.max(w, textWidth(l, 12));
  const h =
    12 +
    titleLines.length * lineHeight(13) +
    (detailLines.length ? 4 + detailLines.length * lineHeight(12) : 0) +
    16;
  const box = { w: w + 32, h };
  return {
    ...base,
    titleLines,
    detailLines,
    aLen: ax.vertical ? box.h : box.w,
    cLen: ax.vertical ? box.w : box.h,
    textW: box.w,
    textH: box.h,
  };
}

// ----------------------------------------------------------------- ranks ----

/**
 * dagre for the rank order only. Return edges are left out of the graph: a
 * rework arrow that jumps back six steps must not stretch the ranks it flies
 * over, exactly as in the userflow layout.
 */
function rankWithDagre(
  sized: Sized[],
  edges: ActivityEdgeSpec[],
  ax: Axis,
  rankdir: "TB" | "LR",
): void {
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir, nodesep: 28, ranksep: RANK_GAP, edgesep: 12, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));
  const ids = new Set(sized.map((s) => s.id));
  for (const s of sized) {
    const box = ax.box(0, 0, s.aLen, s.cLen);
    g.setNode(s.id, { width: box.w, height: box.h });
  }
  let key = 0;
  for (const e of edges) {
    if (e.from === e.to || e.kind === "return") continue;
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    g.setEdge(e.from, e.to, { minlen: 1 }, `e${key++}`);
  }
  dagre.layout(g);
  for (const s of sized) {
    const p = g.node(s.id) as { x: number; y: number } | undefined;
    // A step with no edges at all still has to land somewhere: rank 0.
    s.rank = p ? Math.round(ax.ofA(p)) : 0;
    s.order = p ? ax.ofC(p) : 0;
  }
}

// ------------------------------------------------------------------ emit ----

function boundsShift(
  lanes: Placement[],
  steps: Placement[],
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
  for (const at of lanes.concat(steps)) acc(at.x, at.y, at.w, at.h);
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
  const dx = PAD - minX;
  // Measured, not assumed — the frame's width is the content plus its two
  // margins, so the subtitle can be wrapped to the width it is really drawn
  // at. One line still lands on 96; a longer one pushes the lanes down.
  const dy = headerHeight(subtitle, Math.ceil(maxX + dx + PAD)) - minY;
  return { dx, dy, maxX, maxY };
}

/** Beside the bar's first end, off its cross side: past the arrows that leave it. */
function forkLabelBox(s: Sized, ax: Axis): Placement {
  const [x, y] = ax.pt(ax.a0(s.at) - 4, ax.c1(s.at) + 10);
  return { x, y, w: s.textW, h: s.textH + 8 };
}

function drawStep(s: Sized, move: (at: Placement) => Placement, ax: Axis): DrawStep {
  const at = move(s.at);
  const pal = PALETTE[s.cls] ?? PALETTE.plain;
  const title = s.titleLines.join("\n");
  const common = {
    id: s.id,
    name: `step:${s.id} · ${s.titleLines[0] ?? s.id}`,
    kind: s.kind,
    at,
    title,
    invert: false,
    dashed: false,
    strokeWeight: 1.5,
  };

  if (s.kind === "fork" || s.kind === "join") {
    return {
      ...common,
      title: "",
      fill: INK,
      stroke: INK,
      radius: 4,
      ...(s.titleLines.length
        ? {
            outside: {
              // The label is text, so its width is the text's width in BOTH
              // rank directions. Building it with ax.box would swap w and h in
              // LR and hand the plugin a 23-wide, 91-tall box for one line.
              at: move(forkLabelBox(s, ax)),
              align: "LEFT" as const,
              text: title,
            },
          }
        : {}),
    };
  }

  if (s.kind === "decision") {
    return {
      ...common,
      fill: pal.fill,
      stroke: pal.stroke,
      radius: 0,
      outside: {
        at: move({
          x: s.at.x + s.at.w / 2 - s.textW / 2,
          y: s.at.y + s.at.h / 2 - s.textH / 2,
          w: s.textW,
          h: s.textH,
        }),
        align: "CENTER" as const,
      },
    };
  }

  if (s.kind === "start" || s.kind === "end") {
    const start = s.kind === "start";
    return {
      ...common,
      fill: start ? INK : "#ffffff",
      stroke: INK,
      strokeWeight: start ? 1.5 : 2.5,
      radius: Math.min(at.w, at.h) / 2,
      invert: start,
    };
  }

  return {
    ...common,
    fill: pal.fill,
    stroke: pal.stroke,
    radius: s.kind === "event" ? 18 : 10,
    dashed: s.kind === "external",
    ...(s.detailLines.length ? { detail: s.detailLines.join("\n") } : {}),
  };
}

function measureLabel(label?: string): { labelLines: string[]; lw: number; lh: number } {
  const lines = label ? wrapText(label, 30) : [];
  let lw = 0;
  for (const l of lines) lw = Math.max(lw, textWidth(l, 11));
  return {
    labelLines: lines,
    lw: lines.length ? lw + 16 : 0,
    lh: lines.length ? lines.length * lineHeight(11) + 8 : 0,
  };
}

export function emitActivityDraw(
  laid: ActivityLayout,
  meta: { title: string; subtitle: string; name: string; x: number; y: number; parentId?: string },
  options: ActivityOptions,
): ActivityDraw {
  return {
    name: meta.name,
    title: meta.title,
    subtitle: meta.subtitle,
    x: meta.x,
    y: meta.y,
    w: laid.w,
    h: laid.h,
    ...(meta.parentId ? { parentId: meta.parentId } : {}),
    lanes: laid.lanes,
    steps: laid.steps,
    edges: laid.edges,
    font: options.font && options.font.trim() ? options.font.trim() : DEFAULT_FONT,
    graph: laid.graph,
  };
}
