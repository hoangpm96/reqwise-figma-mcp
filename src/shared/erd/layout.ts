/**
 * Layout and routing for an entity-relationship diagram.
 *
 * dagre places the tables; everything after that is what an ERD needs and a
 * flowchart does not. A relationship line attaches to the COLUMN that
 * implements it, not to the middle of a box, so the router works in rows; and
 * each end carries a crow's foot rather than an arrow head, because "many"
 * is a fact about the data, not a direction of travel.
 */
import dagre from "@dagrejs/dagre";
import { clearLabelOverlaps, r2, type Pt } from "../diagram/geometry.js";
import { portPoint, type Port } from "../diagram/connector.js";
import { emitWires, many, placeLabels, route, type Anchored, type Wire } from "./route.js";
import { headerHeight, lineHeight, textWidth, wrapText } from "../diagram/metrics.js";
import { DEFAULT_FONT, INK, MUTED, PALETTE } from "../diagram/palette.js";
import type { DrawEdge, FlowClass, Placement } from "../diagram/types.js";
import type {
  Cardinality,
  DrawAttribute,
  DrawEntity,
  DrawMarker,
  ErdDraw,
  ErdEntitySpec,
  ErdGraph,
  ErdOptions,
  ErdRelationSpec,
} from "./types.js";

const PAD = 40;
const HEADER = 96;
/** One attribute row. */
const ROW_H = 24;
/** Title block: the table name, plus its detail line when there is one. */
const TITLE_H = 38;
const TITLE_H_DETAIL = 54;
const BOX_PAD_X = 12;
const BADGE_W = 30;
/** Room around the badge text inside its column (the text is drawn at badgeW - 8). */
const BADGE_PAD_X = 10;
const MIN_W = 190;
const RANK_GAP = 130;
const NODE_GAP = 48;

const LINE = "#000f22";
const ROW_LINE = "#e8ecf1";
const HEADER_TINT = "#f1f4f8";

interface Sized {
  id: string;
  cls: FlowClass;
  external: boolean;
  title: string;
  detail?: string;
  headerH: number;
  badgeW: number;
  rows: DrawAttribute[];
  at: Placement;
}

export interface ErdLayout {
  entities: DrawEntity[];
  edges: DrawEdge[];
  markers: DrawMarker[];
  graph: ErdGraph;
  w: number;
  h: number;
  manyToMany: number;
}

export function layoutErd(
  entities: ErdEntitySpec[],
  relations: ErdRelationSpec[],
  options: ErdOptions,
  subtitle = "",
): ErdLayout {
  const rankdir = options.rankdir === "TB" ? "TB" : "LR";
  const sized = entities.map(sizeEntity);
  const byId = new Map<string, Sized>();
  for (const s of sized) byId.set(s.id, s);

  place(sized, relations, rankdir);

  const wires: Wire[] = relations
    .filter((r) => byId.has(r.from) && byId.has(r.to))
    .map((r, i) => ({
      id: `${r.from}->${r.to}${countBefore(relations, r, i) ? `#${countBefore(relations, r, i) + 1}` : ""}`,
      from: r.from,
      to: r.to,
      fromCard: r.fromCard ?? "one",
      toCard: r.toCard ?? "many",
      ...(r.fromField ? { fromField: r.fromField } : {}),
      ...(r.toField ? { toField: r.toField } : {}),
      identifying: r.identifying === true,
      ...measureLabel(r.label),
      ...(r.fromSide ? { fromPort: { side: r.fromSide, at: 0.5 } } : {}),
      ...(r.toSide ? { toPort: { side: r.toSide, at: 0.5 } } : {}),
      points: [],
      labelAt: null,
    }));

  // Routing works in anchored rows, which is also what the frame stores — one
  // shape, so a reflow and the first draw cannot disagree about where a column
  // sits.
  const anchored = sized.map(toAnchored);
  const anchoredById = new Map(anchored.map((a) => [a.id, a]));
  route(wires, anchoredById, anchored);
  placeLabels(wires);
  clearLabelOverlaps(wires, sized.map((s) => s.at));

  // ---- shift everything under the title block ----
  const bounds = boundsOf(sized, wires);
  const dx = PAD - bounds.minX;
  // Measured, not assumed — the frame's width is the content plus its two
  // margins, so the subtitle can be wrapped to the width it is really drawn
  // at. One line still lands on 96; a longer one pushes the tables down.
  const dy = headerHeight(subtitle, Math.ceil(bounds.maxX + dx + PAD)) - bounds.minY;
  const move = (at: Placement): Placement => ({ x: r2(at.x + dx), y: r2(at.y + dy), w: at.w, h: at.h });
  const movePt = (p: Pt): Pt => [r2(p[0] + dx), r2(p[1] + dy)];
  for (const s of sized) s.at = move(s.at);
  for (const w of wires) {
    w.points = w.points.map(movePt);
    if (w.labelAt) w.labelAt = movePt(w.labelAt);
  }

  const drawEntities: DrawEntity[] = sized.map((s) => {
    const pal = PALETTE[s.cls] ?? PALETTE.plain;
    // A plain table's palette fill is white, which on a white body makes the
    // title block vanish — the audit calls that a slab, rightly. Give it the
    // same quiet tint the lane headers use so every table has a header band.
    const headerFill = s.cls === "plain" || !s.cls ? HEADER_TINT : pal.fill;
    return {
      id: s.id,
      name: `entity:${s.id} · ${s.title}`,
      title: s.title,
      ...(s.detail ? { detail: s.detail } : {}),
      at: s.at,
      headerH: s.headerH,
      headerFill,
      stroke: pal.stroke,
      dashed: s.external,
      badgeW: s.badgeW,
      attributes: s.rows,
    };
  });

  const { edges, markers } = emitWires(wires);

  const graph: ErdGraph = {
    kind: "erd",
    rankdir,
    liveRoute: options.liveRoute !== false,
    entities: sized.map(toAnchored),
    relations: wires.map((w) => ({
      from: w.from,
      to: w.to,
      fromCard: w.fromCard,
      toCard: w.toCard,
      ...(w.fromField ? { fromField: w.fromField } : {}),
      ...(w.toField ? { toField: w.toField } : {}),
      identifying: w.identifying,
      labelLines: w.labelLines,
      lw: w.lw,
      lh: w.lh,
      ...(w.fromPort ? { fromPort: w.fromPort } : {}),
      ...(w.toPort ? { toPort: w.toPort } : {}),
    })),
  };

  const manyToMany = wires.filter((w) => many(w.fromCard) && many(w.toCard)).length;
  return {
    entities: drawEntities,
    edges,
    markers,
    graph,
    w: Math.ceil(bounds.maxX + dx + PAD),
    h: Math.ceil(bounds.maxY + dy + PAD),
    manyToMany,
  };
}

/** The rows of a table, as offsets from its top edge. */
function toAnchored(s: Sized): Anchored {
  return {
    id: s.id,
    at: s.at,
    headerH: s.headerH,
    rows: s.rows.map((row, i) => ({ name: row.name, y: s.headerH + i * ROW_H, h: ROW_H })),
  };
}

// ---------------------------------------------------------------- sizing ----

function sizeEntity(e: ErdEntitySpec): Sized {
  const attributes = e.attributes ?? [];
  const badges = attributes.some((a) => a.key);
  const rows: DrawAttribute[] = attributes.map((a) => ({
    name: a.name,
    type: a.type ?? "",
    badge: a.key === "pfk" ? "PK FK" : a.key ? a.key.toUpperCase() : "",
    required: a.required === true,
    h: ROW_H,
  }));

  // A "PK FK" badge does not fit the one-line PK/FK column: the text wrapped
  // to two lines, grew the row's left cell past ROW_H and came back clipped.
  // Measure the widest badge instead of trusting one constant.
  let badgeW = 0;
  if (badges) {
    badgeW = BADGE_W;
    for (const row of rows) {
      if (row.badge) badgeW = Math.max(badgeW, textWidth(row.badge, 9) + BADGE_PAD_X);
    }
  }
  let widest = textWidth(e.name, 14) + 8;
  if (e.detail) widest = Math.max(widest, textWidth(e.detail, 11));
  for (const row of rows) {
    const name = textWidth(row.name, 12) + (row.required ? 10 : 0);
    const type = row.type ? textWidth(row.type, 11) + 14 : 0;
    widest = Math.max(widest, badgeW + name + type);
  }
  const headerH = e.detail ? TITLE_H_DETAIL : TITLE_H;
  return {
    id: e.id,
    cls: e.cls ?? "plain",
    external: e.external === true,
    title: e.name,
    ...(e.detail ? { detail: e.detail } : {}),
    headerH,
    badgeW,
    rows,
    at: { x: 0, y: 0, w: Math.max(MIN_W, widest + BOX_PAD_X * 2), h: headerH + rows.length * ROW_H },
  };
}

function measureLabel(label?: string): { labelLines: string[]; lw: number; lh: number } {
  const lines = label ? wrapText(label, 26) : [];
  let lw = 0;
  for (const l of lines) lw = Math.max(lw, textWidth(l, 11));
  return {
    labelLines: lines,
    lw: lines.length ? lw + 14 : 0,
    lh: lines.length ? lines.length * lineHeight(11) + 6 : 0,
  };
}

/** How many earlier relations join the same pair — the `#n` suffix. */
function countBefore(all: ErdRelationSpec[], r: ErdRelationSpec, index: number): number {
  let n = 0;
  for (let i = 0; i < index; i++) {
    const o = all[i]!;
    if (o.from === r.from && o.to === r.to) n++;
  }
  return n;
}

// --------------------------------------------------------------- placing ----

function place(sized: Sized[], relations: ErdRelationSpec[], rankdir: "TB" | "LR"): void {
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir, nodesep: NODE_GAP, ranksep: RANK_GAP, edgesep: 20, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));
  const ids = new Set(sized.map((s) => s.id));
  for (const s of sized) g.setNode(s.id, { width: s.at.w, height: s.at.h });
  let key = 0;
  for (const r of relations) {
    if (r.from === r.to || !ids.has(r.from) || !ids.has(r.to)) continue;
    g.setEdge(r.from, r.to, { minlen: 1 }, `r${key++}`);
  }
  dagre.layout(g);
  for (const s of sized) {
    const p = g.node(s.id) as { x: number; y: number } | undefined;
    s.at = { ...s.at, x: (p?.x ?? 0) - s.at.w / 2, y: (p?.y ?? 0) - s.at.h / 2 };
  }
}

// ------------------------------------------------------------------ emit ----

function boundsOf(
  sized: Sized[],
  wires: Wire[],
): { minX: number; minY: number; maxX: number; maxY: number } {
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
  for (const s of sized) acc(s.at.x, s.at.y, s.at.w, s.at.h);
  for (const w of wires) {
    // Room for the crow's foot and the label.
    for (const p of w.points) acc(p[0] - 24, p[1] - 24, 48, 48);
    if (w.labelAt) acc(w.labelAt[0] - w.lw / 2, w.labelAt[1] - w.lh / 2, w.lw, w.lh);
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

export function emitErdDraw(
  laid: ErdLayout,
  meta: { title: string; subtitle: string; name: string; x: number; y: number; parentId?: string },
  options: ErdOptions,
): ErdDraw {
  return {
    name: meta.name,
    title: meta.title,
    subtitle: meta.subtitle,
    x: meta.x,
    y: meta.y,
    w: laid.w,
    h: laid.h,
    ...(meta.parentId ? { parentId: meta.parentId } : {}),
    entities: laid.entities,
    edges: laid.edges,
    markers: laid.markers,
    font: options.font && options.font.trim() ? options.font.trim() : DEFAULT_FONT,
    graph: laid.graph,
  };
}

export { INK, MUTED, ROW_LINE, ROW_H, portPoint };
