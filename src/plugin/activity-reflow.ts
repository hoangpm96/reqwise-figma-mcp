/// <reference types="@figma/plugin-typings" />
/**
 * Re-attach a drawn activity diagram's arrows to its steps.
 *
 * Same job as the userflow reflow, one difference that matters: the activity
 * router needs no stored waypoints, because it never used dagre for geometry
 * in the first place. Running it again over the canvas positions reproduces
 * the layout exactly, so this pass is safe to run on every drag.
 *
 * The lanes are the other difference. A step dragged into another lane's band
 * is REPORTED, not rewritten: whether the process really changed hands is a
 * question for the person who wrote the spec.
 */
import { readDiagramData, ACTIVITY_MARKER } from "./diagram-mark.js";
import {
  applyEdge,
  scanBoxes,
  canvasChildren,
  edgeWasEdited,
  findShape,
  growToFit,
  hideEdge,
  hideLayer,
  edgeEnds,
  indexChildren,
  unhide,
  restoreAutoHidden,
} from "./diagram-apply.js";
import { adoptHandEdits, type PortWish } from "./diagram-adopt.js";
import { edgeIds } from "../shared/diagram/graph.js";
import { reflowActivity } from "../shared/activity/route.js";
import type { ActivityGraph, ActivityKind } from "../shared/activity/types.js";
import type { FlowClass, Placement } from "../shared/diagram/types.js";
import { SIDES, type Port, type Side } from "../shared/diagram/connector.js";

export interface ActivityReflowReport {
  frameId: string;
  name: string;
  kind: "activity";
  /** false = every step is still where the layout pass put it. */
  changed: boolean;
  routed: number;
  hidden: number;
  missing: string[];
  /** Arrows somebody moved by hand — left exactly as they left them. */
  pinned: string[];
  goneBoxes: string[];
  /** Steps now sitting in a lane other than the one the process assigns them. */
  relaned: Array<{ id: string; from: string; to: string | null }>;
}

export function activityGraphOf(node: BaseNode): ActivityGraph | null {
  const mark = readDiagramData(node, ACTIVITY_MARKER);
  return mark ? normalizeGraph(mark.graph) : null;
}

/** Every activity frame on the page that remembers its graph. */
export function activityFrames(page: PageNode): FrameNode[] {
  const out: FrameNode[] = [];
  for (const child of canvasChildren(page)) {
    if (child.type === "FRAME" && activityGraphOf(child)) out.push(child);
  }
  return out;
}

export async function reflowActivityFrame(
  frame: FrameNode,
  opts?: { grow?: boolean; onlyIfMoved?: boolean; force?: boolean; deleted?: boolean },
): Promise<ActivityReflowReport | null> {
  const graph = activityGraphOf(frame);
  if (!graph) return null;

  const byName = indexChildren(frame);
  const scan = scanBoxes(frame, graph.nodes, "step:", opts?.deleted === true);
  const { placed, goneBoxes, shapes } = scan;

  // Not one box found, though the graph names some: this frame is being
  // written, not emptied. Routing on from here would hide every line and
  // nothing would ever bring them back — see scanBoxes.
  if (scan.midWrite) {
    return {
      frameId: frame.id,
      name: frame.name,
      kind: "activity",
      changed: false,
      routed: 0,
      hidden: 0,
      missing: [],
      pinned: [],
      goneBoxes: [],
      relaned: [],
    };
  }

  // Lane bands are frames the user can resize too, so they are read back from
  // the canvas as well — a widened lane must not shift the arrows off it.
  const lanePlaced = new Map<string, Placement>();
  for (const lane of graph.lanes) {
    const band = byName.get(`lane:${lane.id}`);
    if (band) lanePlaced.set(lane.id, { x: band.x, y: band.y, w: band.width, h: band.height });
  }

  // "From scratch" includes forgetting the connection points somebody dragged.
  if (opts?.force === true && clearHandPorts(graph)) saveGraph(frame, graph);

  let { edges, dropped, moved, relaned } = reflowActivity(graph, placed, lanePlaced);

  // An arrow somebody dragged is read as a connection point, written into the
  // graph and re-routed through it; an edit that says nothing about attachment
  // is left alone.
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
    edges = reflowActivity(graph, placed, lanePlaced).edges;
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
      kind: "activity",
      changed: false,
      routed: 0,
      hidden: 0,
      missing: [],
      pinned: [],
      goneBoxes,
      relaned,
    };
  }

  let routed = 0;
  const missing: string[] = [];
  const pinned: string[] = [];
  for (const e of edges) {
    // An adopted edit is already IN the model, so redrawing the layer is the
    // same instruction, drawn properly.
    const force = opts?.force === true || adopted.ports.has(e.id);
    const applied = await applyEdge(byName, e, { force });
    if (applied === "moved") routed++;
    else if (applied === "pinned") pinned.push(e.id);
    else missing.push(e.id);
  }

  let hidden = 0;
  for (const id of dropped) hidden += hideEdge(byName, id, edgeEnds(id));

  // A decision's question and a bar's caption are SIBLINGS of their shape
  // (a polygon cannot hold a child, a 10px bar cannot show text), so dragging
  // the shape leaves them behind. Re-centre them — and when the shape itself
  // is gone, hide the caption rather than leave it floating where it stood.
  for (const n of graph.nodes) {
    const shape = shapes.get(n.id);
    if (!shape) {
      hidden += hideLayer(byName, `text:${n.id}`, { all: [n.id] });
      continue;
    }
    const text = byName.get(`text:${n.id}`);
    if (!text) continue;
    if (n.kind === "decision") {
      text.x = Math.round(shape.x + shape.width / 2 - text.width / 2);
      text.y = Math.round(shape.y + shape.height / 2 - text.height / 2);
    } else {
      text.x = Math.round(shape.x + shape.width + 10);
      text.y = Math.round(shape.y - 4);
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
    kind: "activity",
    changed,
    routed,
    hidden,
    missing,
    pinned,
    goneBoxes,
    relaned,
  };
}

// ------------------------------------------------------------- validation ----

const KINDS: ActivityKind[] = [
  "action",
  "decision",
  "start",
  "end",
  "fork",
  "join",
  "event",
  "external",
];
const CLASSES: FlowClass[] = ["happy", "error", "edge", "plain", "decision"];

/**
 * The graph comes back out of plugin data, which any build may have written,
 * so it is treated as untrusted input: anything malformed makes the frame
 * un-reflowable rather than throwing inside a document-change callback.
 */
function normalizeGraph(raw: unknown): ActivityGraph | null {
  if (!raw || typeof raw !== "object") return null;
  const g = raw as Record<string, unknown>;
  if (!Array.isArray(g.nodes) || !Array.isArray(g.edges) || !Array.isArray(g.lanes)) return null;

  const lanes: ActivityGraph["lanes"] = [];
  for (const item of g.lanes) {
    if (!item || typeof item !== "object") continue;
    const l = item as Record<string, unknown>;
    const at = placement(l.at);
    if (typeof l.id !== "string" || !l.id || !at) continue;
    lanes.push({ id: l.id, at });
  }

  const nodes: ActivityGraph["nodes"] = [];
  for (const item of g.nodes) {
    if (!item || typeof item !== "object") continue;
    const n = item as Record<string, unknown>;
    const at = placement(n.at);
    if (typeof n.id !== "string" || !n.id || !at) continue;
    nodes.push({
      id: n.id,
      kind: KINDS.indexOf(n.kind as ActivityKind) >= 0 ? (n.kind as ActivityKind) : "action",
      cls: CLASSES.indexOf(n.cls as FlowClass) >= 0 ? (n.cls as FlowClass) : "plain",
      lane: typeof n.lane === "string" ? n.lane : "",
      at,
    });
  }
  if (!nodes.length) return null;

  const edges: ActivityGraph["edges"] = [];
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
    kind: "activity",
    rankdir: g.rankdir === "TB" ? "TB" : "LR",
    colorByTarget: g.colorByTarget !== false,
    liveRoute: g.liveRoute !== false,
    lanes,
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


/** Split a drawn edge id back into the two step ids it was made from. */
function idsOf(id: string): { from: string; to: string } {
  const bare = id.replace(/#\d+$/, "");
  const at = bare.indexOf("->");
  return at < 0 ? { from: bare, to: bare } : { from: bare.slice(0, at), to: bare.slice(at + 2) };
}

/** Write the adopted connection points onto the graph's own edges. */
function applyPortWishes(graph: ActivityGraph, ports: Map<string, PortWish>): void {
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
function clearHandPorts(graph: ActivityGraph): boolean {
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
function saveGraph(frame: FrameNode, graph: ActivityGraph): void {
  const mark = readDiagramData(frame, ACTIVITY_MARKER) ?? {};
  try {
    frame.setPluginData(ACTIVITY_MARKER, JSON.stringify({ ...mark, graph }));
  } catch {
    // Nothing to do but carry on: the arrow is still re-routed for this pass.
  }
}
