/// <reference types="@figma/plugin-typings" />
/**
 * Re-attach a drawn userflow's arrows to its boxes.
 *
 * Figma Design has no connector primitive — `figma.createConnector()` is
 * FigJam-only — so an arrow drawn here is an ordinary vector that knows
 * nothing about the boxes it points at. This module closes that gap: it reads
 * where the boxes are NOW, re-runs the shared orthogonal router, and rewrites
 * the geometry of the arrows that are already on the canvas. Same layers, same
 * z-order, same layer names; only the path moves.
 *
 * It is deliberately synchronous. The live watcher calls it from inside a
 * `nodechange` callback, where Figma does not report the plugin's own writes
 * back to it — that is what keeps a re-route from triggering another one.
 */
import { FLOW_MARKER, readMarkData } from "./flow-mark.js";
import { adoptHandEdits, type PortWish } from "./diagram-adopt.js";
import { edgeIds } from "../shared/diagram/graph.js";
import {
  applyEdge,
  canvasChildren,
  edgeWasEdited,
  findShape,
  scanBoxes,
  growToFit,
  hideEdge,
  hideLayer,
  indexChildren,
  unhide,
  restoreAutoHidden,
  edgeEnds,
} from "./diagram-apply.js";
import { reflowUserflow, type RouteGraph } from "../shared/userflow/route.js";
import type { Placement } from "../shared/diagram/types.js";
import type { FlowKind } from "../shared/userflow/types.js";
import type { FlowClass } from "../shared/diagram/types.js";
import { SIDES, type Port, type Side } from "../shared/diagram/connector.js";

export interface ReflowReport {
  frameId: string;
  name: string;
  kind: "userflow";
  /** false = every box is still where the layout pass put it. */
  changed: boolean;
  /** Arrows whose path was rewritten. */
  routed: number;
  /** Arrows hidden because a box they touch is no longer on the canvas. */
  hidden: number;
  /** Edge ids the frame remembers but has no layer for. */
  missing: string[];
  /** Arrows somebody moved by hand — left exactly as they left them. */
  pinned: string[];
  /** Boxes the stored graph names but the canvas no longer has. */
  goneBoxes: string[];
}

/** Does this node carry a userflow marker with a graph we can re-route? */
export function userflowGraphOf(node: BaseNode): RouteGraph | null {
  const mark = readMarkData(node);
  return mark ? normalizeGraph(mark.graph) : null;
}

/**
 * Walk up from a changed node to the userflow frame that owns it. A box is a
 * direct child of the frame, and a text inside a box is one level deeper, so
 * three hops is more than enough — and bounded, because this runs on every
 * batch of document changes.
 */
export function owningUserflow(node: BaseNode | null): FrameNode | null {
  let cur: BaseNode | null = node;
  for (let hop = 0; cur && hop < 4; hop++) {
    if (cur.type === "FRAME" && userflowGraphOf(cur)) return cur as FrameNode;
    cur = cur.parent;
  }
  return null;
}

/** Every userflow frame on the page that remembers its graph. */
export function userflowFrames(page: PageNode): FrameNode[] {
  const out: FrameNode[] = [];
  for (const child of canvasChildren(page)) {
    if (child.type === "FRAME" && userflowGraphOf(child)) out.push(child);
  }
  return out;
}

/**
 * Re-route one frame. Returns null when the frame carries no graph (drawn by
 * an older build, or not a userflow at all).
 */
export async function reflowFrame(
  frame: FrameNode,
  opts?: { grow?: boolean; onlyIfMoved?: boolean; force?: boolean; deleted?: boolean },
): Promise<ReflowReport | null> {
  const graph = userflowGraphOf(frame);
  if (!graph) return null;

  const byName = indexChildren(frame);

  const scan = scanBoxes(frame, graph.nodes, "flow:", opts?.deleted === true);
  const { placed, goneBoxes, shapes: boxes } = scan;

  // Not one box found, though the graph names some: this frame is being
  // written, not emptied. Routing on from here would hide every line and
  // nothing would ever bring them back — see scanBoxes.
  if (scan.midWrite) {
    return {
      frameId: frame.id,
      name: frame.name,
      kind: "userflow",
      changed: false,
      routed: 0,
      hidden: 0,
      missing: [],
      pinned: [],
      goneBoxes: [],
    };
  }

  // "From scratch" includes forgetting the connection points somebody dragged.
  if (opts?.force === true && clearHandPorts(graph)) saveGraph(frame, graph);

  let { edges, dropped, moved } = reflowUserflow(graph, placed);

  // An arrow somebody dragged is read as a connection point, written into the
  // graph, and re-routed through it — the draw.io behaviour. Anything that
  // cannot be read that way is left exactly as they left it.
  const adopted = adoptHandEdits({
    byName,
    edges: edges.map((e) => ({ id: e.id, from: idsOf(e.id).from, to: idsOf(e.id).to })),
    boxes: placed,
    expected: new Map(edges.map((e) => [e.id, e.points])),
    edited: (id) => edgeWasEdited(byName, id),
  });
  if (adopted.ports.size) {
    applyPortWishes(graph, adopted.ports);
    saveGraph(frame, graph);
    edges = reflowUserflow(graph, placed).edges;
  }

  const changed = moved.length > 0 || dropped.length > 0 || adopted.ports.size > 0;

  // Nothing has been moved since the flow was drawn, so there is nothing to
  // answer. This is what stops the DRAW pass's own document changes from
  // immediately re-routing (and coarsening) a diagram that dagre just laid out.
  if (opts?.onlyIfMoved && !changed) {
    // An undone delete brings its box back where it was, so nothing reads as
    // moved — but the lines hidden when it went are still hidden. See
    // restoreAutoHidden, which brings back each layer whose own boxes are
    // back even while some other box is still missing.
    restoreAutoHidden(byName, scan);
    return {
      frameId: frame.id,
      name: frame.name,
      kind: "userflow",
      changed: false,
      routed: 0,
      hidden: 0,
      missing: [],
      pinned: [],
      goneBoxes,
    };
  }

  let routed = 0;
  const missing: string[] = [];
  const pinned: string[] = [];
  for (const e of edges) {
    // An adopted edit is already IN the model, so overwriting the layer is
    // exactly right — it is the same instruction, drawn properly.
    const force = opts?.force === true || adopted.ports.has(e.id);
    const applied = await applyEdge(byName, e, { force });
    if (applied === "moved") routed++;
    else if (applied === "pinned") pinned.push(e.id);
    else missing.push(e.id);
  }

  let hidden = 0;
  for (const id of dropped) hidden += hideEdge(byName, id, edgeEnds(id));

  // A decision's text is a SIBLING of the diamond (a polygon cannot hold a
  // child), so dragging the diamond leaves its question behind — and deleting
  // the diamond must hide it rather than leave it floating where it stood.
  for (const n of graph.nodes) {
    if (n.kind !== "decision") continue;
    const diamond = boxes.get(n.id);
    if (!diamond) {
      hidden += hideLayer(byName, `q ${n.id}`, { all: [n.id] });
      continue;
    }
    const text = byName.get(`q ${n.id}`);
    if (!text) continue;
    text.x = Math.round(diamond.x + diamond.width / 2 - text.width / 2);
    text.y = Math.round(diamond.y + diamond.height / 2 - text.height / 2);
    unhide(text);
  }

  // A layer hidden for a box that is back, but which the pass above did not
  // touch (a hand-moved arrow is left alone, so applyEdge never un-hides it),
  // and the stamp of a layer somebody showed by hand. Layers hidden above
  // wait for a box that is still gone, so nothing flips back.
  restoreAutoHidden(byName, scan);

  if (opts?.grow !== false) growToFit(frame);

  return {
    frameId: frame.id,
    name: frame.name,
    kind: "userflow",
    changed,
    routed,
    hidden,
    missing,
    pinned,
    goneBoxes,
  };
}







// ------------------------------------------------------------- validation ----

const KINDS: FlowKind[] = ["screen", "state", "decision", "external", "terminal"];
const CLASSES: FlowClass[] = ["happy", "error", "edge", "plain", "decision"];

/**
 * The graph comes back out of plugin data, which any build (or any other
 * plugin) may have written, so it is treated as untrusted input: anything
 * malformed makes the frame simply un-reflowable rather than throwing inside a
 * document-change callback.
 */
function normalizeGraph(raw: unknown): RouteGraph | null {
  if (!raw || typeof raw !== "object") return null;
  const g = raw as Record<string, unknown>;
  if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) return null;

  const nodes: RouteGraph["nodes"] = [];
  for (const item of g.nodes) {
    if (!item || typeof item !== "object") continue;
    const n = item as Record<string, unknown>;
    if (typeof n.id !== "string" || !n.id) continue;
    nodes.push({
      id: n.id,
      kind: KINDS.indexOf(n.kind as FlowKind) >= 0 ? (n.kind as FlowKind) : "screen",
      cls: CLASSES.indexOf(n.cls as FlowClass) >= 0 ? (n.cls as FlowClass) : "plain",
      ...(placement(n.at) ? { at: placement(n.at)! } : {}),
    });
  }
  if (!nodes.length) return null;

  const edges: RouteGraph["edges"] = [];
  for (const item of g.edges) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    if (typeof e.from !== "string" || typeof e.to !== "string") continue;
    const lines = Array.isArray(e.labelLines) ? e.labelLines.filter((l) => typeof l === "string") : [];
    edges.push({
      from: e.from,
      to: e.to,
      kind: e.kind === "return" ? "return" : "forward",
      labelLines: lines as string[],
      lw: typeof e.lw === "number" ? e.lw : 0,
      lh: typeof e.lh === "number" ? e.lh : 0,
      ...(typeof e.fromAt === "number" ? { fromAt: e.fromAt } : {}),
      ...(typeof e.toAt === "number" ? { toAt: e.toAt } : {}),
      ...(port(e.fromPort) ? { fromPort: port(e.fromPort)! } : {}),
      ...(port(e.toPort) ? { toPort: port(e.toPort)! } : {}),
      ...(e.portsByHand === true ? { portsByHand: true } : {}),
      ...(points(e.waypoints).length ? { waypoints: points(e.waypoints) } : {}),
      ...(point(e.labelAt) ? { labelAt: point(e.labelAt)! } : {}),
    });
  }

  return {
    rankdir: g.rankdir === "LR" ? "LR" : "TB",
    colorByTarget: g.colorByTarget !== false,
    liveRoute: g.liveRoute !== false,
    nodes,
    edges,
  };
}

/** A stored connection point, validated: an unknown side means no opinion. */
function port(raw: unknown): Port | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (SIDES.indexOf(p.side as Side) < 0) return null;
  return { side: p.side as Side, at: typeof p.at === "number" ? p.at : 0.5 };
}

function placement(raw: unknown): Placement | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (
    typeof p.x !== "number" ||
    typeof p.y !== "number" ||
    typeof p.w !== "number" ||
    typeof p.h !== "number"
  ) {
    return null;
  }
  return { x: p.x, y: p.y, w: p.w, h: p.h };
}

function point(raw: unknown): { x: number; y: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.x !== "number" || typeof p.y !== "number") return null;
  return { x: p.x, y: p.y };
}

function points(raw: unknown): Array<{ x: number; y: number }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ x: number; y: number }> = [];
  for (const item of raw) {
    const p = point(item);
    if (p) out.push(p);
  }
  return out;
}


/** Split a drawn edge id back into the two node ids it was made from. */
function idsOf(id: string): { from: string; to: string } {
  const bare = id.replace(/#\d+$/, "");
  const at = bare.indexOf("->");
  return at < 0 ? { from: bare, to: bare } : { from: bare.slice(0, at), to: bare.slice(at + 2) };
}

/** Write the adopted connection points onto the graph's own edges. */
function applyPortWishes(graph: RouteGraph, ports: Map<string, PortWish>): void {
  const ids = edgeIds(graph.edges);
  graph.edges.forEach((e, i) => {
    const wish = ports.get(ids[i]!);
    if (!wish) return;
    if (wish.fromPort) e.fromPort = wish.fromPort;
    if (wish.toPort) e.toPort = wish.toPort;
    // Flagged so a force-reflow can put the arrow back under automatic
    // routing without also throwing away a port the SPEC asked for.
    e.portsByHand = true;
  });
}

/** Forget the connection points that came from dragging, not from the spec. */
function clearHandPorts(graph: RouteGraph): boolean {
  let cleared = false;
  for (const e of graph.edges) {
    if (!e.portsByHand) continue;
    delete e.fromPort;
    delete e.toPort;
    delete e.portsByHand;
    cleared = true;
  }
  return cleared;
}

/**
 * Persist the graph after adopting an edit, so the connection point survives
 * the plugin closing. The rest of the marker is left exactly as it was.
 */
function saveGraph(frame: FrameNode, graph: RouteGraph): void {
  const mark = readMarkData(frame) ?? {};
  try {
    frame.setPluginData(FLOW_MARKER, JSON.stringify({ ...mark, graph }));
  } catch {
    // Nothing to do but carry on: the arrow is still re-routed for this pass.
  }
}
