/// <reference types="@figma/plugin-typings" />
/**
 * Re-attach a drawn ERD's relationship lines to its tables.
 *
 * Same shape as the other two reflows, with one thing of its own: a line
 * attaches to the COLUMN that implements the relationship, and the column is
 * remembered by NAME. So a table can be moved, resized, or have its rows read
 * back at a different height, and the line still finds the right row.
 */
import { readDiagramData, ERD_MARKER } from "./diagram-mark.js";
import {
  applyEdge,
  scanBoxes,
  applyMarkers,
  canvasChildren,
  edgeWasEdited,
  findShape,
  growToFit,
  hideEdge,
  hideLayer,
  indexChildren,
  restoreAutoHidden,
} from "./diagram-apply.js";
import { adoptHandEdits, type PortWish } from "./diagram-adopt.js";
import { reflowErd } from "../shared/erd/route.js";
import type { Cardinality, ErdGraph } from "../shared/erd/types.js";
import type { Placement } from "../shared/diagram/types.js";
import { SIDES, type Port, type Side } from "../shared/diagram/connector.js";

export interface ErdReflowReport {
  frameId: string;
  name: string;
  kind: "erd";
  changed: boolean;
  routed: number;
  hidden: number;
  missing: string[];
  pinned: string[];
  /** Tables the model names but the canvas no longer has. */
  goneBoxes: string[];
}

export function erdGraphOf(node: BaseNode): ErdGraph | null {
  const mark = readDiagramData(node, ERD_MARKER);
  return mark ? normalizeGraph(mark.graph) : null;
}

export function erdFrames(page: PageNode): FrameNode[] {
  const out: FrameNode[] = [];
  for (const child of canvasChildren(page)) {
    if (child.type === "FRAME" && erdGraphOf(child)) out.push(child);
  }
  return out;
}

export async function reflowErdFrame(
  frame: FrameNode,
  opts?: { grow?: boolean; onlyIfMoved?: boolean; force?: boolean; deleted?: boolean },
): Promise<ErdReflowReport | null> {
  const graph = erdGraphOf(frame);
  if (!graph) return null;

  if (opts?.force === true && clearHandPorts(graph)) saveGraph(frame, graph);

  const byName = indexChildren(frame);
  const scan = scanBoxes(frame, graph.entities, "entity:", opts?.deleted === true);
  const { placed, goneBoxes } = scan;

  // Not one box found, though the graph names some: this frame is being
  // written, not emptied. Routing on from here would hide every line and
  // nothing would ever bring them back — see scanBoxes.
  if (scan.midWrite) {
    return {
      frameId: frame.id,
      name: frame.name,
      kind: "erd",
      changed: false,
      routed: 0,
      hidden: 0,
      missing: [],
      pinned: [],
      goneBoxes: [],
    };
  }

  let { edges, markers, dropped, moved } = reflowErd(graph, placed);

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
    const again = reflowErd(graph, placed);
    edges = again.edges;
    markers = again.markers;
  }

  const changed = moved.length > 0 || dropped.length > 0 || adopted.ports.size > 0;
  if (opts?.onlyIfMoved && !changed) {
    // An undone delete brings its box back where it was, so nothing reads as
    // moved — but the lines hidden when it went are still hidden. See
    // restoreAutoHidden.
    if (!goneBoxes.length) restoreAutoHidden(byName);
    return {
      frameId: frame.id,
      name: frame.name,
      kind: "erd",
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
    // An ERD line ends in a crow's foot, drawn beside it — not in an arrow cap.
    const applied = await applyEdge(byName, e, { force, arrow: false });
    if (applied === "moved") routed++;
    else if (applied === "pinned") pinned.push(e.id);
    else missing.push(e.id);
  }
  await applyMarkers(byName, markers);

  let hidden = 0;
  for (const id of dropped) {
    hidden += hideEdge(byName, id);
    // The crow's foot and its optionality circle are siblings of the line —
    // hideLayer stamps the hide so an undone delete brings them back too.
    for (const end of ["from", "to"]) {
      hidden += hideLayer(byName, `mark ${id}:${end}`);
      hidden += hideLayer(byName, `mark-o ${id}:${end}`);
    }
  }

  if (opts?.grow !== false) growToFit(frame);

  return {
    frameId: frame.id,
    name: frame.name,
    kind: "erd",
    changed,
    routed,
    hidden,
    missing,
    pinned,
    goneBoxes,
  };
}

function idsOf(id: string): { from: string; to: string } {
  const bare = id.replace(/#\d+$/, "");
  const at = bare.indexOf("->");
  return at < 0 ? { from: bare, to: bare } : { from: bare.slice(0, at), to: bare.slice(at + 2) };
}

function applyPortWishes(graph: ErdGraph, ports: Map<string, PortWish>): void {
  // Wishes are keyed by the DRAWN layer's edge id, and the ERD numbers its own
  // duplicates — the first repeated pair is plain "a->b", then "a->b#2" — NOT
  // the generic edgeIds "a->b#1". Using edgeIds here left the first duplicate
  // relation's dragged port unadopted: the wish sat under "a->b" while the
  // lookup asked for "a->b#1".
  const seen = new Map<string, number>();
  for (const r of graph.relations) {
    const pair = `${r.from}->${r.to}`;
    const n = (seen.get(pair) ?? 0) + 1;
    seen.set(pair, n);
    const wish = ports.get(n > 1 ? `${pair}#${n}` : pair);
    if (!wish) continue;
    if (wish.fromPort) r.fromPort = wish.fromPort;
    if (wish.toPort) r.toPort = wish.toPort;
    r.portsByHand = true;
  }
}

function clearHandPorts(graph: ErdGraph): boolean {
  let cleared = false;
  for (const r of graph.relations) {
    if (!r.portsByHand) continue;
    delete r.fromPort;
    delete r.toPort;
    delete r.portsByHand;
    cleared = true;
  }
  return cleared;
}

function saveGraph(frame: FrameNode, graph: ErdGraph): void {
  const mark = readDiagramData(frame, ERD_MARKER) ?? {};
  try {
    frame.setPluginData(ERD_MARKER, JSON.stringify({ ...mark, graph }));
  } catch {
    // The re-route still happened for this pass.
  }
}

// ------------------------------------------------------------- validation ----

const CARDS: Cardinality[] = ["one", "many", "zero-one", "zero-many", "one-many"];

function normalizeGraph(raw: unknown): ErdGraph | null {
  if (!raw || typeof raw !== "object") return null;
  const g = raw as Record<string, unknown>;
  if (!Array.isArray(g.entities) || !Array.isArray(g.relations)) return null;

  const entities: ErdGraph["entities"] = [];
  for (const item of g.entities) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    const at = placement(e.at);
    if (typeof e.id !== "string" || !e.id || !at) continue;
    const rows: ErdGraph["entities"][number]["rows"] = [];
    if (Array.isArray(e.rows)) {
      for (const r of e.rows) {
        if (!r || typeof r !== "object") continue;
        const row = r as Record<string, unknown>;
        if (typeof row.name !== "string" || typeof row.y !== "number") continue;
        rows.push({ name: row.name, y: row.y, h: typeof row.h === "number" ? row.h : 24 });
      }
    }
    entities.push({
      id: e.id,
      at,
      headerH: typeof e.headerH === "number" ? e.headerH : 38,
      rows,
    });
  }
  if (!entities.length) return null;

  const relations: ErdGraph["relations"] = [];
  for (const item of g.relations) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.from !== "string" || typeof r.to !== "string") continue;
    const lines = Array.isArray(r.labelLines)
      ? (r.labelLines.filter((l) => typeof l === "string") as string[])
      : [];
    relations.push({
      from: r.from,
      to: r.to,
      fromCard: CARDS.indexOf(r.fromCard as Cardinality) >= 0 ? (r.fromCard as Cardinality) : "one",
      toCard: CARDS.indexOf(r.toCard as Cardinality) >= 0 ? (r.toCard as Cardinality) : "many",
      ...(typeof r.fromField === "string" ? { fromField: r.fromField } : {}),
      ...(typeof r.toField === "string" ? { toField: r.toField } : {}),
      identifying: r.identifying === true,
      labelLines: lines,
      lw: typeof r.lw === "number" ? r.lw : 0,
      lh: typeof r.lh === "number" ? r.lh : 0,
      ...(port(r.fromPort) ? { fromPort: port(r.fromPort)! } : {}),
      ...(port(r.toPort) ? { toPort: port(r.toPort)! } : {}),
      ...(r.portsByHand === true ? { portsByHand: true } : {}),
    });
  }

  return {
    kind: "erd",
    rankdir: g.rankdir === "TB" ? "TB" : "LR",
    liveRoute: g.liveRoute !== false,
    entities,
    relations,
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
