/**
 * Layout + orthogonal routing for a userflow.
 *
 * dagre (the engine mermaid itself uses) places the ranks; everything after
 * that is the part mermaid does badly for a userflow: one PORT PER EDGE so
 * three arrows leaving a screen do not stack on one pixel, and return edges
 * ("cancel", "retry", "back") pulled out into side GUTTERS instead of crossing
 * back through the middle of the diagram.
 *
 * Coordinates are computed in (along, cross) space — `along` runs with the
 * rank direction, `cross` across it — so TB and LR share one implementation.
 */
import dagre from "@dagrejs/dagre";
import { headerHeight, lineHeight, splitLines, textWidth, wrapText } from "../diagram/metrics.js";
import { ARROW, Axis, r2 } from "../diagram/geometry.js";
import { DEFAULT_FONT, PALETTE } from "../diagram/palette.js";
import type { FlowClass } from "../diagram/types.js";
import {
  emitEdges,
  overridePorts,
  route,
  clearLabels,
  spreadDecisions,
  type RouteEdge,
  type RouteGraph,
  type RouteNode,
} from "./route.js";
import type { Port } from "../diagram/connector.js";
import type {
  DrawBox,
  DrawData,
  DrawDiamond,
  FlowEdgeSpec,
  FlowNodeSpec,
  UserflowOptions,
} from "./types.js";

const PAD = 40;
const HEADER = 96;
const FOOTER = 48;


/** A sized node: the shared routing shape plus what the drawing needs. */
interface Sized extends RouteNode {
  label: string;
  detail?: string;
  screenId?: string;
  slug?: string;
  /** "screenId · slug" — whichever of the two the caller gave. */
  ref: string;
  titleLines: string[];
  detailLines: string[];
  textW: number;
  textH: number;
}

/** A routed edge, plus the raw label the spec gave. */
interface Routed extends RouteEdge {
  label?: string;
}

// ---------------------------------------------------------------- sizing ----

function sizeNode(n: FlowNodeSpec): Sized {
  const kind = n.kind ?? "screen";
  const cls: FlowClass = n.cls ?? (kind === "decision" ? "decision" : "plain");
  const raw = splitLines(n.label);
  const head = raw.length ? raw[0]! : n.id;
  const rest = raw.slice(1);
  if (n.detail) for (const l of splitLines(n.detail)) rest.push(l);

  if (kind === "decision") {
    const lines: string[] = [];
    for (const l of [head].concat(rest)) for (const w of wrapText(l, 30)) lines.push(w);
    const ref = "";
    let textW = 0;
    for (const l of lines) textW = Math.max(textW, textWidth(l, 11));
    const textH = lines.length * lineHeight(11);
    const h = Math.max(64, 2 * textH + 40);
    const ratio = Math.max(0.35, 1 - textH / h);
    const w = Math.max(120, Math.ceil(textW / ratio) + 24);
    return { ...n, kind, cls, ref, titleLines: lines, detailLines: [], textW, textH, w, h, x: 0, y: 0 };
  }

  const titleLines = wrapText(head, 40);
  const detailLines: string[] = [];
  for (const l of rest) {
    if (l === n.slug || l === n.screenId) continue;
    for (const w of wrapText(l, 44)) detailLines.push(w);
  }
  // The reference line carries the screenId as well as the slug: an artboard is
  // named "1.2 · sign-in", so the box has to say the same thing or the reader
  // cannot pair them up.
  const ref = [n.screenId, n.slug].filter((v): v is string => !!v).join(" · ");
  let w = 90;
  for (const l of titleLines) w = Math.max(w, textWidth(l, 13));
  for (const l of detailLines) w = Math.max(w, textWidth(l, 12));
  if (ref) w = Math.max(w, textWidth(ref, 11));
  const h =
    12 +
    titleLines.length * lineHeight(13) +
    (ref ? lineHeight(11) : 0) +
    (detailLines.length ? 4 + detailLines.length * lineHeight(12) : 0) +
    // Figma renders each line ~1px taller than the metric table predicts, so a
    // flat 12px bottom pad measured 10px on a three-line box. 16 keeps every
    // box at or above the 12px minimum the layout audit asks for.
    16;
  return { ...n, kind, cls, ref, titleLines, detailLines, textW: w, textH: h, w: w + 32, h, x: 0, y: 0 };
}

/** A side (with an optional position along it) is a full connection point. */
function specPort(side: FlowEdgeSpec["fromSide"], at: number | undefined): Port | undefined {
  return side ? { side, at: typeof at === "number" ? at : 0.5 } : undefined;
}

function sizeEdge(e: FlowEdgeSpec, index: number): Routed {
  const labelLines = e.label ? wrapText(e.label, 34) : [];
  let lw = 0;
  for (const l of labelLines) lw = Math.max(lw, textWidth(l, 11));
  return {
    ...e,
    kind: e.kind ?? "forward",
    ...(specPort(e.fromSide, e.fromAt) ? { fromPort: specPort(e.fromSide, e.fromAt)! } : {}),
    ...(specPort(e.toSide, e.toAt) ? { toPort: specPort(e.toSide, e.toAt)! } : {}),
    labelLines,
    lw: labelLines.length ? lw + 16 : 0,
    lh: labelLines.length ? labelLines.length * lineHeight(11) + 8 : 0,
    name: `e${index}`,
    back: false,
    side: 1,
    lane: 0,
    points: [],
    labelAt: null,
    dagrePoints: null,
    dagreLabel: null,
    portOut: 0,
    portIn: 0,
  };
}

// ---------------------------------------------------------------- layout ----

function runDagre(
  nodes: Sized[],
  edges: Routed[],
  skip: Set<Routed>,
  rankdir: "TB" | "LR",
): void {
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir, nodesep: 36, ranksep: 52, edgesep: 16, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: n.w, height: n.h });
  for (const e of edges) {
    if (e.from === e.to || skip.has(e)) continue;
    g.setEdge(
      e.from,
      e.to,
      { width: e.lw + 12, height: e.lh + 12, labelpos: "c", minlen: 1 },
      e.name,
    );
  }
  dagre.layout(g);
  for (const n of nodes) {
    const p = g.node(n.id) as { x: number; y: number };
    n.x = p.x - n.w / 2;
    n.y = p.y - n.h / 2;
  }
  for (const e of edges) {
    e.dagrePoints = null;
    e.dagreLabel = null;
    if (e.from === e.to || skip.has(e)) continue;
    const ge = g.edge(e.from, e.to, e.name) as {
      points: Array<{ x: number; y: number }>;
      x: number;
      y: number;
    };
    if (!ge) continue;
    e.dagrePoints = ge.points;
    e.dagreLabel = { x: ge.x, y: ge.y };
  }
}

export interface LaidOut {
  nodes: Sized[];
  edges: Routed[];
  w: number;
  h: number;
  shiftX: number;
  shiftY: number;
}

export function layoutGraph(
  rawNodes: FlowNodeSpec[],
  rawEdges: FlowEdgeSpec[],
  rankdir: "TB" | "LR",
): LaidOut {
  const nodes = rawNodes.map(sizeNode);
  const edges = rawEdges.map(sizeEdge);
  const byId = new Map<string, Sized>();
  for (const n of nodes) byId.set(n.id, n);
  const ax = new Axis(rankdir === "TB");

  runDagre(nodes, edges, new Set(), rankdir);
  const pointsBackwards = (e: Routed): boolean => {
    if (e.from === e.to) return false;
    const s = byId.get(e.from)!;
    const t = byId.get(e.to)!;
    return ax.aMid(t) < ax.aMid(s) - 1;
  };
  // An edge lives in a gutter either because the caller SAID it is a return
  // path, or because the geometry made it one. Deciding this once — rather
  // than letting `kind:"return"` mean "dashed" and the geometry separately
  // mean "routed aside" — is what keeps the promise that a declared return
  // path stays out of the rank maths and out of the middle of the diagram.
  const gutter = new Set(edges.filter((e) => e.from !== e.to && (e.kind === "return" || pointsBackwards(e))));
  // Second pass without them: dagre no longer reserves rank space for arrows
  // that will live in the gutters, which narrows the diagram by roughly 40% on
  // a flow with many cancel/retry paths.
  if (gutter.size) runDagre(nodes, edges, gutter, rankdir);
  // Re-decide on the second pass's geometry, but an edge skipped from that
  // pass has no waypoints, so it MUST route through the gutter branch.
  for (const e of edges) {
    e.back = e.from !== e.to && (gutter.has(e) || pointsBackwards(e));
  }

  spreadDecisions(nodes, edges, byId, ax);
  route(nodes, edges, byId, ax);
  overridePorts(edges, byId);
  clearLabels(nodes, edges);
  return finish(nodes, edges);
}

// ------------------------------------------------------------ bounding box --// ------------------------------------------------------------ bounding box --

function finish(nodes: Sized[], edges: Routed[]): LaidOut {
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
  for (const n of nodes) acc(n.x, n.y, n.w, n.h);
  for (const e of edges) {
    for (const p of e.points) acc(p[0] - ARROW, p[1] - ARROW, ARROW * 2, ARROW * 2);
    if (e.labelAt) acc(e.labelAt[0] - e.lw / 2, e.labelAt[1] - e.lh / 2, e.lw, e.lh);
  }
  if (!nodes.length) {
    minX = 0;
    minY = 0;
    maxX = 0;
    maxY = 0;
  }
  return {
    nodes,
    edges,
    w: Math.ceil(maxX - minX),
    h: Math.ceil(maxY - minY),
    shiftX: -minX,
    shiftY: -minY,
  };
}

// ------------------------------------------------------------------ emit ----

export function emitDrawData(
  laid: LaidOut,
  meta: { title: string; subtitle: string; name: string; x: number; y: number; parentId?: string },
  options: UserflowOptions,
): DrawData {
  const ox = PAD + laid.shiftX;
  // Measured, not assumed: the subtitle is wrapped to the width it will really
  // be drawn at, so a long one pushes the flow down instead of being drawn on
  // top of the first screen. One line still lands on 96.
  const head = headerHeight(meta.subtitle, laid.w + PAD * 2);
  const oy = head + laid.shiftY;
  const boxes: DrawBox[] = [];
  const diamonds: DrawDiamond[] = [];
  const byId = new Map<string, Sized>();
  for (const n of laid.nodes) byId.set(n.id, n);
  const colorByTarget = options.colorByTarget !== false;

  for (const n of laid.nodes) {
    const pal = PALETTE[n.cls] ?? PALETTE.plain;
    const title = n.titleLines.join("\n");
    if (n.kind === "decision") {
      diamonds.push({
        id: n.id,
        name: boxName(n),
        x: r2(ox + n.x),
        y: r2(oy + n.y),
        w: n.w,
        h: n.h,
        fill: pal.fill,
        stroke: pal.stroke,
        text: title,
        textW: n.textW + 8,
        textH: n.textH,
      });
      continue;
    }
    boxes.push({
      id: n.id,
      name: boxName(n),
      x: r2(ox + n.x),
      y: r2(oy + n.y),
      w: n.w,
      h: n.h,
      fill: pal.fill,
      stroke: pal.stroke,
      title,
      ...(n.ref ? { ref: n.ref } : {}),
      ...(n.detailLines.length ? { detail: n.detailLines.join("\n") } : {}),
      ...(n.screenId ? { screenId: n.screenId } : {}),
    });
  }

  const drawEdges = emitEdges(laid.edges, byId, { ox, oy, colorByTarget });

  return {
    name: meta.name,
    title: meta.title,
    subtitle: meta.subtitle,
    x: meta.x,
    y: meta.y,
    w: laid.w + PAD * 2,
    h: laid.h + head + FOOTER,
    ...(meta.parentId ? { parentId: meta.parentId } : {}),
    boxes,
    diamonds,
    edges: drawEdges,
    graph: routeGraph(laid, options, colorByTarget, ox, oy),
    linkScreens: options.linkScreens === true,
    font: options.font && options.font.trim() ? options.font.trim() : DEFAULT_FONT,
  };
}

/**
 * Layer name: `flow:<id>` is the machine handle (it is how the created nodes
 * are matched back to graph ids), followed by the reference line so the layer
 * list reads like the canvas.
 */
function boxName(n: Sized): string {
  const label = n.ref || n.titleLines[0] || n.id;
  return `flow:${n.id} · ${label}`;
}

/**
 * What the drawn frame remembers about its own graph, so a drag can be
 * answered by re-routing instead of by redrawing the whole flow. Only the
 * fields routing needs are kept — positions and sizes are read back off the
 * canvas, because the canvas is where the user has been moving them.
 */
function routeGraph(
  laid: LaidOut,
  options: UserflowOptions,
  colorByTarget: boolean,
  ox: number,
  oy: number,
): RouteGraph {
  return {
    rankdir: options.rankdir === "LR" ? "LR" : "TB",
    colorByTarget,
    liveRoute: options.liveRoute !== false,
    // Everything below is in FRAME coordinates, the space a reflow works in:
    // the plugin reads the boxes off the canvas and never sees layout space.
    nodes: laid.nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      cls: n.cls,
      at: { x: r2(ox + n.x), y: r2(oy + n.y), w: n.w, h: n.h },
    })),
    edges: laid.edges.map((e) => ({
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
      ...(e.dagrePoints && e.dagrePoints.length
        ? { waypoints: e.dagrePoints.map((p) => ({ x: r2(ox + p.x), y: r2(oy + p.y) })) }
        : {}),
      ...(e.labelAt ? { labelAt: { x: r2(ox + e.labelAt[0]), y: r2(oy + e.labelAt[1]) } } : {}),
    })),
  };
}
