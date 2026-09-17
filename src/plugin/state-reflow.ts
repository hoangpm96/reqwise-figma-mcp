/// <reference types="@figma/plugin-typings" />
/**
 * Re-attach a drawn state machine's transitions to its states.
 *
 * Same shape as the activity reflow, minus the lanes: the router is the same
 * pure function of box positions, so running it again over the canvas
 * reproduces the layout exactly and the pass is safe on every drag. Dragging a
 * transition's END is adopted as a connection point and written back into the
 * graph, so a hand-tidied arrow keeps following its states.
 */
import { readDiagramData, STATE_MARKER } from "./diagram-mark.js";
import {
  applyEdge,
  scanBoxes,
  canvasChildren,
  edgeWasEdited,
  findShape,
  growToFit,
  hideEdge,
  hideLayer,
  indexChildren,
  unhide,
  restoreAutoHidden,
  edgeEnds,
} from "./diagram-apply.js";
import { adoptHandEdits, type PortWish } from "./diagram-adopt.js";
import { edgeIds } from "../shared/diagram/graph.js";
import { reflowState } from "../shared/state/layout.js";
import type { StateGraph, StateKind } from "../shared/state/types.js";
import type { FlowClass, Placement } from "../shared/diagram/types.js";
import { SIDES, type Port, type Side } from "../shared/diagram/connector.js";

export interface StateReflowReport {
  frameId: string;
  name: string;
  kind: "state";
  /** false = every state is still where the layout pass put it. */
  changed: boolean;
  routed: number;
  hidden: number;
  missing: string[];
  /** Arrows somebody moved by hand — left exactly as they left them. */
  pinned: string[];
  goneBoxes: string[];
}

export function stateGraphOf(node: BaseNode): StateGraph | null {
  const mark = readDiagramData(node, STATE_MARKER);
  return mark ? normalizeGraph(mark.graph) : null;
}

export function stateFrames(page: PageNode): FrameNode[] {
  const out: FrameNode[] = [];
  for (const child of canvasChildren(page)) {
    if (child.type === "FRAME" && stateGraphOf(child)) out.push(child);
  }
  return out;
}

export async function reflowStateFrame(
  frame: FrameNode,
  opts?: { grow?: boolean; onlyIfMoved?: boolean; force?: boolean; deleted?: boolean },
): Promise<StateReflowReport | null> {
  const graph = stateGraphOf(frame);
  if (!graph) return null;

  const byName = indexChildren(frame);
  const scan = scanBoxes(frame, graph.nodes, "state:", opts?.deleted === true);
  const { placed, goneBoxes, shapes } = scan;

  // Not one box found, though the graph names some: this frame is being
  // written, not emptied. Routing on from here would hide every line and
  // nothing would ever bring them back — see scanBoxes.
  if (scan.midWrite) {
    return {
      frameId: frame.id,
      name: frame.name,
      kind: "state",
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

  let { edges, dropped, moved } = reflowState(graph, placed);

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
    edges = reflowState(graph, placed).edges;
  }

  const changed = moved.length > 0 || dropped.length > 0 || adopted.ports.size > 0;
  if (opts?.onlyIfMoved && !changed) {
    // An undone delete brings its box back where it was, so nothing reads as
    // moved — but the lines hidden when it went are still hidden. See
    // restoreAutoHidden, which brings back each layer whose own boxes are
    // back even while some other box is still missing.
    restoreAutoHidden(byName, scan);
    return {
      frameId: frame.id,
      name: frame.name,
      kind: "state",
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
    const force = opts?.force === true || adopted.ports.has(e.id);
    const applied = await applyEdge(byName, e, { force });
    if (applied === "moved") routed++;
    else if (applied === "pinned") pinned.push(e.id);
    else missing.push(e.id);
  }

  let hidden = 0;
  for (const id of dropped) hidden += hideEdge(byName, id, edgeEnds(id));

  // A dot's name, a diamond's question and a bar's caption are SIBLINGS of
  // their shape (an ellipse and a polygon cannot hold a child), and so is the
  // filled centre of a final ring — dragging the shape leaves them behind,
  // and deleting it must hide them rather than leave them afloat.
  for (const n of graph.nodes) {
    const shape = shapes.get(n.id);
    if (!shape) {
      hidden += hideLayer(byName, `ring:${n.id}`, { all: [n.id] });
      hidden += hideLayer(byName, `text:${n.id}`, { all: [n.id] });
      continue;
    }
    const ring = byName.get(`ring:${n.id}`);
    if (ring) {
      ring.x = Math.round(shape.x + (shape.width - ring.width) / 2);
      ring.y = Math.round(shape.y + (shape.height - ring.height) / 2);
      unhide(ring);
    }
    const text = byName.get(`text:${n.id}`);
    if (!text) continue;
    if (n.kind === "choice") {
      text.x = Math.round(shape.x + shape.width / 2 - text.width / 2);
      text.y = Math.round(shape.y + shape.height / 2 - text.height / 2);
    } else if (graph.rankdir === "TB") {
      text.x = Math.round(shape.x + shape.width + 10);
      text.y = Math.round(shape.y + shape.height / 2 - text.height / 2);
    } else {
      text.x = Math.round(shape.x + shape.width / 2 - text.width / 2);
      text.y = Math.round(shape.y + shape.height + 8);
    }
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
    kind: "state",
    changed,
    routed,
    hidden,
    missing,
    pinned,
    goneBoxes,
  };
}

// ------------------------------------------------------------- validation ----

const KINDS: StateKind[] = ["state", "initial", "final", "choice", "fork", "join"];
const CLASSES: FlowClass[] = ["happy", "error", "edge", "plain", "decision"];

/**
 * The graph comes back out of plugin data, which any build may have written,
 * so it is treated as untrusted input: anything malformed makes the frame
 * un-reflowable rather than throwing inside a document-change callback.
 */
function normalizeGraph(raw: unknown): StateGraph | null {
  if (!raw || typeof raw !== "object") return null;
  const g = raw as Record<string, unknown>;
  if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) return null;

  const nodes: StateGraph["nodes"] = [];
  for (const item of g.nodes) {
    if (!item || typeof item !== "object") continue;
    const n = item as Record<string, unknown>;
    const at = placement(n.at);
    if (typeof n.id !== "string" || !n.id || !at) continue;
    nodes.push({
      id: n.id,
      kind: KINDS.indexOf(n.kind as StateKind) >= 0 ? (n.kind as StateKind) : "state",
      cls: CLASSES.indexOf(n.cls as FlowClass) >= 0 ? (n.cls as FlowClass) : "plain",
      at,
    });
  }
  if (!nodes.length) return null;

  const edges: StateGraph["edges"] = [];
  for (const item of g.edges) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    if (typeof e.from !== "string" || typeof e.to !== "string") continue;
    const lines = Array.isArray(e.labelLines)
      ? (e.labelLines.filter((l) => typeof l === "string") as string[])
      : [];
    edges.push({
      from: e.from,
      to: e.to,
      kind: e.kind === "return" ? "return" : "forward",
      labelLines: lines,
      lw: typeof e.lw === "number" ? e.lw : 0,
      lh: typeof e.lh === "number" ? e.lh : 0,
      ...(typeof e.fromAt === "number" ? { fromAt: e.fromAt } : {}),
      ...(typeof e.toAt === "number" ? { toAt: e.toAt } : {}),
      ...(port(e.fromPort) ? { fromPort: port(e.fromPort)! } : {}),
      ...(port(e.toPort) ? { toPort: port(e.toPort)! } : {}),
      ...(e.portsByHand === true ? { portsByHand: true } : {}),
    });
  }

  return {
    kind: "state",
    rankdir: g.rankdir === "TB" ? "TB" : "LR",
    colorByTarget: g.colorByTarget !== false,
    liveRoute: g.liveRoute !== false,
    nodes,
    edges,
  };
}

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

/** Split a drawn edge id back into the two state ids it was made from. */
function idsOf(id: string): { from: string; to: string } {
  const bare = id.replace(/#\d+$/, "");
  const at = bare.indexOf("->");
  return at < 0 ? { from: bare, to: bare } : { from: bare.slice(0, at), to: bare.slice(at + 2) };
}

/** Write the adopted connection points onto the graph's own edges. */
function applyPortWishes(graph: StateGraph, ports: Map<string, PortWish>): void {
  const ids = edgeIds(graph.edges);
  graph.edges.forEach((e, i) => {
    const wish = ports.get(ids[i]!);
    if (!wish) return;
    if (wish.fromPort) e.fromPort = wish.fromPort;
    if (wish.toPort) e.toPort = wish.toPort;
    e.portsByHand = true;
  });
}

/** Forget the connection points that came from dragging, not from the spec. */
function clearHandPorts(graph: StateGraph): boolean {
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

/** Persist the graph so an adopted connection point outlives the session. */
function saveGraph(frame: FrameNode, graph: StateGraph): void {
  const mark = readDiagramData(frame, STATE_MARKER) ?? {};
  try {
    frame.setPluginData(STATE_MARKER, JSON.stringify({ ...mark, graph }));
  } catch {
    // Nothing to do but carry on: the arrow is still re-routed for this pass.
  }
}
