/**
 * Routing for an entity-relationship diagram, and the crow's-foot notation.
 *
 * Split out for the same reason as the other diagrams: the PLUGIN runs it again
 * with the table positions read off the canvas, so a drag re-routes the lines
 * without a redraw. It is a pure function of where the tables are and which
 * column each relationship names.
 */
import { clearLabelOverlaps, r2, type Pt } from "../diagram/geometry.js";
import { connectPorts, type Port, type Side } from "../diagram/connector.js";
import type { DrawEdge, Placement } from "../diagram/types.js";
import type { Cardinality, DrawMarker, ErdGraph } from "./types.js";

const LINE = "#000f22";

/** A table as routing sees it: a box with rows you can attach to. */
export interface Anchored {
  id: string;
  at: Placement;
  headerH: number;
  rows: Array<{ name: string; y: number; h: number }>;
}

export interface Wire {
  id: string;
  from: string;
  to: string;
  fromCard: Cardinality;
  toCard: Cardinality;
  fromField?: string;
  toField?: string;
  identifying: boolean;
  labelLines: string[];
  lw: number;
  lh: number;
  fromPort?: Port;
  toPort?: Port;
  points: Pt[];
  labelAt: Pt | null;
}

// --------------------------------------------------------------- routing ----

/**
 * Each relationship attaches to the COLUMN that implements it. The faces are
 * chosen from where the two tables actually sit, and if that route would cut
 * through a third table the other pairing is tried before settling.
 */
export function route(wires: Wire[], byId: Map<string, Anchored>, all: Anchored[]): void {
  for (const w of wires) {
    const from = byId.get(w.from)!;
    const to = byId.get(w.to)!;
    const horizontal = pickPairing(from.at, to.at);
    const options: Array<[Side, Side]> = horizontal
      ? [sidesFor(from.at, to.at, true), sidesFor(from.at, to.at, false)]
      : [sidesFor(from.at, to.at, false), sidesFor(from.at, to.at, true)];

    // A port the caller SET (or dragged into place) is kept as it is; the rest
    // is chosen here and deliberately NOT written back, so a later re-route is
    // free to pick again when the tables have moved.
    let best: Pt[] | null = null;
    for (const [fs, ts] of options) {
      const fromPort = w.fromPort ?? { side: fs, at: rowAt(from, w.fromField, fs) };
      const toPort = w.toPort ?? { side: ts, at: rowAt(to, w.toField, ts) };
      const pts = connectPorts({ box: from.at, port: fromPort }, { box: to.at, port: toPort });
      if (!best) best = pts;
      if (clear(pts, all, [w.from, w.to])) {
        best = pts;
        break;
      }
    }
    w.points = best ?? [];
  }
}

/** True when the two boxes are further apart across than down. */
function pickPairing(a: Placement, b: Placement): boolean {
  return Math.abs(b.x + b.w / 2 - (a.x + a.w / 2)) >= Math.abs(b.y + b.h / 2 - (a.y + a.h / 2));
}

function sidesFor(a: Placement, b: Placement, horizontal: boolean): [Side, Side] {
  if (horizontal) {
    return b.x + b.w / 2 >= a.x + a.w / 2 ? ["right", "left"] : ["left", "right"];
  }
  return b.y + b.h / 2 >= a.y + a.h / 2 ? ["bottom", "top"] : ["top", "bottom"];
}

/**
 * Where along a face the line attaches: the row that implements the
 * relationship, when there is one and the face runs down the side of the box.
 */
function rowAt(entity: Anchored, field: string | undefined, side: Side): number {
  if (!field || side === "top" || side === "bottom") return 0.5;
  const row = entity.rows.find((r) => r.name === field);
  if (!row) return 0.5;
  const centre = row.y + row.h / 2;
  return Math.min(0.95, Math.max(0.05, centre / entity.at.h));
}

/** Does this path stay out of every table it does not belong to? */
function clear(points: Pt[], all: Anchored[], skip: string[]): boolean {
  for (const s of all) {
    if (skip.indexOf(s.id) >= 0) continue;
    const b = { x: s.at.x - 4, y: s.at.y - 4, w: s.at.w + 8, h: s.at.h + 8 };
    for (let i = 1; i < points.length; i++) {
      const p = points[i - 1]!;
      const q = points[i]!;
      const x0 = Math.min(p[0], q[0]);
      const x1 = Math.max(p[0], q[0]);
      const y0 = Math.min(p[1], q[1]);
      const y1 = Math.max(p[1], q[1]);
      if (x0 < b.x + b.w && x1 > b.x && y0 < b.y + b.h && y1 > b.y) return false;
    }
  }
  return true;
}

export function placeLabels(wires: Wire[]): void {
  for (const w of wires) {
    if (!w.labelLines.length || w.points.length < 2) continue;
    let best: { at: Pt; len: number } | null = null;
    for (let i = 1; i < w.points.length; i++) {
      const p = w.points[i - 1]!;
      const q = w.points[i]!;
      const len = Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]);
      if (!best || len > best.len) {
        best = { at: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], len };
      }
    }
    if (best) w.labelAt = best.at;
  }
}

// --------------------------------------------------------------- markers ----

const FOOT = 13;
const TICK = 6.5;
const CIRCLE_R = 4;

export function many(c: Cardinality): boolean {
  return c === "many" || c === "zero-many" || c === "one-many";
}

/**
 * The crow's foot at one end: `end` is the point on the table's edge and
 * `inner` the next point along the line, which gives the direction the
 * notation is drawn back along.
 */
function crowsFoot(id: string, end: Pt, inner: Pt, card: Cardinality): DrawMarker {
  const dx = inner[0] - end[0];
  const dy = inner[1] - end[1];
  const len = Math.hypot(dx, dy) || 1;
  // Unit vector pointing AWAY from the table, along the line.
  const ux = dx / len;
  const uy = dy / len;
  // Perpendicular to it.
  const px = -uy;
  const py = ux;
  const at = (d: number, across = 0): Pt => [
    r2(end[0] + ux * d + px * across),
    r2(end[1] + uy * d + py * across),
  ];

  const strokes: Array<Array<Pt>> = [];
  let circle: DrawMarker["circle"];

  if (many(card)) {
    const apex = at(FOOT);
    strokes.push([apex, at(0, TICK)], [apex, at(0, -TICK)]);
  }
  if (card === "one" || card === "zero-one") {
    const d = card === "one" ? 11 : 11;
    strokes.push([at(d, TICK), at(d, -TICK)]);
  }
  if (card === "one-many") {
    strokes.push([at(FOOT + 9, TICK), at(FOOT + 9, -TICK)]);
  }
  if (card === "zero-one" || card === "zero-many") {
    const d = card === "zero-one" ? 20 : FOOT + 8;
    const c = at(d);
    circle = { x: r2(c[0] - CIRCLE_R), y: r2(c[1] - CIRCLE_R), r: CIRCLE_R };
  }

  return { id, strokes, ...(circle ? { circle } : {}), color: LINE };
}

// ------------------------------------------------------------------ emit ----

/** Routed relationships → draw data: the lines, their notation, their labels. */
export function emitWires(wires: Wire[]): { edges: DrawEdge[]; markers: DrawMarker[] } {
  const edges: DrawEdge[] = [];
  const markers: DrawMarker[] = [];
  for (const w of wires) {
    if (w.points.length < 2) continue;
    edges.push({
      id: w.id,
      points: w.points.map((p) => [r2(p[0]), r2(p[1])] as Pt),
      color: LINE,
      dashed: w.identifying,
      ...(w.labelAt && w.labelLines.length
        ? {
            label: {
              x: r2(w.labelAt[0] - w.lw / 2),
              y: r2(w.labelAt[1] - w.lh / 2),
              w: w.lw,
              h: w.lh,
              text: w.labelLines.join("\n"),
              muted: false,
            },
          }
        : {}),
    });
    markers.push(crowsFoot(`${w.id}:from`, w.points[0]!, w.points[1]!, w.fromCard));
    const last = w.points.length - 1;
    markers.push(crowsFoot(`${w.id}:to`, w.points[last]!, w.points[last - 1]!, w.toCard));
  }
  return { edges, markers: markers.filter((m) => m.strokes.length > 0 || m.circle) };
}

export interface ReflowedErd {
  edges: DrawEdge[];
  markers: DrawMarker[];
  /** Relationship ids whose table is gone from the canvas. */
  dropped: string[];
  /** Tables no longer where the layout pass put them. */
  moved: string[];
}

/**
 * Re-route a drawn ERD from where its tables are NOW. The row a line attaches
 * to is remembered by NAME, so it survives a table being moved or resized.
 */
export function reflowErd(graph: ErdGraph, placed: Map<string, Placement>): ReflowedErd {
  const tables: Anchored[] = [];
  const byId = new Map<string, Anchored>();
  const moved: string[] = [];
  for (const e of graph.entities) {
    const at = placed.get(e.id);
    if (!at) continue;
    const table: Anchored = { id: e.id, at, headerH: e.headerH, rows: e.rows };
    tables.push(table);
    byId.set(e.id, table);
    if (!samePlace(e.at, at)) moved.push(e.id);
  }

  const dropped: string[] = [];
  const wires: Wire[] = [];
  const seen = new Map<string, number>();
  for (const r of graph.relations) {
    const pair = `${r.from}->${r.to}`;
    const n = (seen.get(pair) ?? 0) + 1;
    seen.set(pair, n);
    const id = n > 1 ? `${pair}#${n}` : pair;
    if (!byId.has(r.from) || !byId.has(r.to)) {
      dropped.push(id);
      continue;
    }
    wires.push({
      id,
      from: r.from,
      to: r.to,
      fromCard: r.fromCard,
      toCard: r.toCard,
      ...(r.fromField ? { fromField: r.fromField } : {}),
      ...(r.toField ? { toField: r.toField } : {}),
      identifying: r.identifying,
      labelLines: r.labelLines,
      lw: r.lw,
      lh: r.lh,
      ...(r.fromPort ? { fromPort: r.fromPort } : {}),
      ...(r.toPort ? { toPort: r.toPort } : {}),
      points: [],
      labelAt: null,
    });
  }

  route(wires, byId, tables);
  placeLabels(wires);
  // The same clearing pass the layout runs, or a re-route would put every
  // label back on whatever it was nudged off.
  clearLabelOverlaps(wires, tables.map((t) => t.at));
  const emitted = emitWires(wires);
  return { ...emitted, dropped, moved };
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
