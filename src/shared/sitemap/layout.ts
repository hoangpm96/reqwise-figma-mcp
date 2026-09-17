/**
 * Layout for a sitemap.
 *
 * This is the one kind in the repo that does NOT go through dagre by default,
 * and the reason is not aesthetic:
 *
 *   - A tree has zero edge crossings by construction, so every bit of work
 *     dagre does — median ordering, crossing minimisation — is work with
 *     nothing to optimise.
 *   - Worse, that work REORDERS siblings. In an information architecture the
 *     sibling order IS content: it is the order the nav shows. A layout engine
 *     free to swap "Trang chủ" and "Cài đặt" to tidy a picture is changing the
 *     model behind the author's back.
 *
 * So the default is a tidy tree — Buchheim/Walker's linear-time refinement of
 * Reingold–Tilford — which centres every parent exactly over its children,
 * keeps sibling order, and tucks a narrow subtree under a wide one instead of
 * reserving a rectangle for it. `options.layout: "dagre"` hands the same tree
 * to the shared engine for anyone who prefers its packing.
 *
 * The router is not shared either, and that is also deliberate: a containment
 * line is not a routed path. It is a parent's shoulder with a drop to each
 * child, four points and no arrow head, and it has no reason to know about
 * corridors, lanes or hand-dragged ports.
 */
import dagre from "@dagrejs/dagre";
import { r2 } from "../diagram/geometry.js";
import { headerHeight, lineHeight, textWidth, wrapToWidth } from "../diagram/metrics.js";
import { EDGE_AMBER, ERROR_RED, INK, MUTED, PALETTE, RETURN_GRAY } from "../diagram/palette.js";
import type { DrawEdge, FlowClass, Placement } from "../diagram/types.js";
import { artboardsOf } from "./check.js";
import type { SitemapCheck } from "./check.js";
import type { DrawPage, PageKind, PageSpec, SitemapDraw, SitemapGraph, SitemapOptions } from "./types.js";

/** Frame chrome: the margin round the drawing. */
const PAD = 32;
/** Inside a page box. */
const BOX_PAD_X = 14;
const BOX_PAD_Y = 12;
const TITLE_SIZE = 13;
const DETAIL_SIZE = 11;
/** Between two siblings, along the sibling axis. */
const SEP = 28;
/** Between one level and the next, along the depth axis. */
const DGAP = 56;
const BOX_MIN_W = 132;
const BOX_MAX_W = 240;
const BOX_MIN_H = 46;

export interface LaidSitemap {
  pages: DrawPage[];
  edges: DrawEdge[];
  graph: SitemapGraph;
  w: number;
  h: number;
  leaves: number;
  depth: number;
  sections: number;
}

// --------------------------------------------------------------- measuring ----

/**
 * One width for every box, because a sitemap is read as a menu rather than as
 * a set of differently important objects: ragged box widths make a level look
 * like a hierarchy it is not. The width is the widest label that needs it,
 * clamped — beyond the clamp, labels wrap.
 */
function boxWidth(pages: PageSpec[]): number {
  let widest = 0;
  for (const p of pages) {
    widest = Math.max(widest, textWidth(label(p), TITLE_SIZE));
    const arts = artboardsOf(p);
    if (arts.length) widest = Math.max(widest, textWidth(artboardLine(arts), DETAIL_SIZE));
  }
  return Math.min(BOX_MAX_W, Math.max(BOX_MIN_W, Math.ceil(widest) + BOX_PAD_X * 2));
}

/**
 * The artboards on one line: `· 01 · 02`. Joined rather than stacked, because
 * a page with five states would otherwise be five times the height of its
 * siblings and the row would stop reading as a level.
 */
export function artboardLine(arts: string[]): string {
  return arts.length ? `· ${arts.join(" · ")}` : "";
}

function label(p: PageSpec): string {
  const l = (p.label ?? "").trim();
  return l ? l : p.id;
}

interface Measured {
  page: PageSpec;
  titleLines: string[];
  detailLines: string[];
  w: number;
  h: number;
}

function measure(pages: PageSpec[], w: number): Map<string, Measured> {
  const inner = w - BOX_PAD_X * 2;
  const out = new Map<string, Measured>();
  for (const p of pages) {
    const titleLines = wrapToWidth(label(p), inner, TITLE_SIZE);
    const detailLines = (p.detail ?? "").trim()
      ? wrapToWidth(p.detail!.trim(), inner, DETAIL_SIZE)
      : [];
    let h = BOX_PAD_Y * 2 + titleLines.length * lineHeight(TITLE_SIZE);
    if (artboardsOf(p).length) h += lineHeight(DETAIL_SIZE);
    if (detailLines.length) h += 4 + detailLines.length * lineHeight(DETAIL_SIZE);
    out.set(p.id, { page: p, titleLines, detailLines, w, h: Math.max(BOX_MIN_H, h) });
  }
  return out;
}

// ------------------------------------------------------------- the tidy tree ----

/**
 * A node in the tidy-tree pass. `prelim`/`mod`/`thread`/`ancestor` are
 * Buchheim's, and they are the whole algorithm: `thread` is what lets the
 * contour of a subtree be walked without visiting its interior, which is what
 * turns the quadratic version of this into a linear one.
 */
interface TreeNode {
  id: string;
  /** Extent along the SIBLING axis — width for TB, height for LR. */
  size: number;
  /** Extent along the DEPTH axis. */
  thick: number;
  depth: number;
  children: TreeNode[];
  parent?: TreeNode;
  /** Index among its siblings, for O(1) left-sibling lookup. */
  i: number;
  prelim: number;
  mod: number;
  shift: number;
  change: number;
  thread?: TreeNode;
  ancestor: TreeNode;
  /** Filled by the second walk: centre along the sibling axis. */
  pos: number;
}

function tidy(root: TreeNode): void {
  firstWalk(root);
  secondWalk(root, -root.prelim);
}

function firstWalk(v: TreeNode): void {
  if (!v.children.length) {
    const w = leftSibling(v);
    v.prelim = w ? w.prelim + gap(w, v) : 0;
    return;
  }
  let defaultAncestor = v.children[0]!;
  for (const w of v.children) {
    firstWalk(w);
    defaultAncestor = apportion(w, defaultAncestor);
  }
  executeShifts(v);
  const midpoint = (v.children[0]!.prelim + v.children[v.children.length - 1]!.prelim) / 2;
  const w = leftSibling(v);
  if (w) {
    v.prelim = w.prelim + gap(w, v);
    v.mod = v.prelim - midpoint;
  } else {
    v.prelim = midpoint;
  }
}

function secondWalk(v: TreeNode, m: number): void {
  v.pos = v.prelim + m;
  for (const w of v.children) secondWalk(w, m + v.mod);
}

/** The clear distance between the CENTRES of two adjacent boxes. */
function gap(a: TreeNode, b: TreeNode): number {
  return (a.size + b.size) / 2 + SEP;
}

function leftSibling(v: TreeNode): TreeNode | undefined {
  return v.parent && v.i > 0 ? v.parent.children[v.i - 1] : undefined;
}

function leftmostSibling(v: TreeNode): TreeNode | undefined {
  return v.parent && v.parent.children.length ? v.parent.children[0] : undefined;
}

function nextLeft(v: TreeNode): TreeNode | undefined {
  return v.children.length ? v.children[0] : v.thread;
}

function nextRight(v: TreeNode): TreeNode | undefined {
  return v.children.length ? v.children[v.children.length - 1] : v.thread;
}

function moveSubtree(wm: TreeNode, wp: TreeNode, shift: number): void {
  const subtrees = wp.i - wm.i;
  wp.change -= shift / subtrees;
  wp.shift += shift;
  wm.change += shift / subtrees;
  wp.prelim += shift;
  wp.mod += shift;
}

function executeShifts(v: TreeNode): void {
  let shift = 0;
  let change = 0;
  for (let i = v.children.length - 1; i >= 0; i--) {
    const w = v.children[i]!;
    w.prelim += shift;
    w.mod += shift;
    change += w.change;
    shift += w.shift + change;
  }
}

function ancestorOf(vim: TreeNode, v: TreeNode, defaultAncestor: TreeNode): TreeNode {
  return vim.ancestor.parent === v.parent ? vim.ancestor : defaultAncestor;
}

function apportion(v: TreeNode, defaultAncestor: TreeNode): TreeNode {
  const w = leftSibling(v);
  if (!w) return defaultAncestor;

  let vip: TreeNode | undefined = v;
  let vop: TreeNode | undefined = v;
  let vim: TreeNode | undefined = w;
  let vom: TreeNode | undefined = leftmostSibling(v);
  let sip = vip.mod;
  let sop = vop.mod;
  let sim = vim.mod;
  let som = vom ? vom.mod : 0;
  let ancestor = defaultAncestor;

  while (vim && vip && nextRight(vim) && nextLeft(vip)) {
    vim = nextRight(vim)!;
    vip = nextLeft(vip)!;
    vom = vom ? nextLeft(vom) : undefined;
    vop = vop ? nextRight(vop) : undefined;
    if (vop) vop.ancestor = v;
    const shift = vim.prelim + sim - (vip.prelim + sip) + gap(vim, vip);
    if (shift > 0) {
      moveSubtree(ancestorOf(vim, v, ancestor), v, shift);
      sip += shift;
      sop += shift;
    }
    sim += vim.mod;
    sip += vip.mod;
    som += vom ? vom.mod : 0;
    sop += vop ? vop.mod : 0;
  }

  if (vim && nextRight(vim) && vop && !nextRight(vop)) {
    vop.thread = nextRight(vim);
    vop.mod += sim - sop;
  }
  if (vip && nextLeft(vip) && vom && !nextLeft(vom)) {
    vom.thread = nextLeft(vip);
    vom.mod += sip - som;
    ancestor = v;
  }
  return ancestor;
}

// ----------------------------------------------------------------- placing ----

/**
 * A forest gets a VIRTUAL root that is never drawn. More than one top-level
 * page is a finding, not an error (a half-mapped IA has loose branches), and
 * hanging them off an invisible parent is what lets the same tidy pass lay out
 * one tree or five without a second code path.
 */
function buildTree(
  checked: SitemapCheck,
  sized: Map<string, { size: number; thick: number }>,
): { root: TreeNode; byId: Map<string, TreeNode> } {
  const byId = new Map<string, TreeNode>();
  const make = (id: string, depth: number, i: number, parent?: TreeNode): TreeNode => {
    const s = sized.get(id) ?? { size: 0, thick: 0 };
    const node: TreeNode = {
      id,
      size: s.size,
      thick: s.thick,
      depth,
      children: [],
      ...(parent ? { parent } : {}),
      i,
      prelim: 0,
      mod: 0,
      shift: 0,
      change: 0,
      ancestor: undefined as unknown as TreeNode,
      pos: 0,
    };
    node.ancestor = node;
    byId.set(id, node);
    (checked.children.get(id) ?? []).forEach((kid, k) => {
      node.children.push(make(kid, depth + 1, k, node));
    });
    return node;
  };

  const virtual: TreeNode = {
    id: "",
    size: 0,
    thick: 0,
    depth: 0,
    children: [],
    i: 0,
    prelim: 0,
    mod: 0,
    shift: 0,
    change: 0,
    ancestor: undefined as unknown as TreeNode,
    pos: 0,
  };
  virtual.ancestor = virtual;
  checked.roots.forEach((id, i) => {
    virtual.children.push(make(id, 1, i, virtual));
  });
  return { root: virtual, byId };
}

export function layoutSitemap(
  checked: SitemapCheck,
  options: SitemapOptions = {},
  subtitle = "",
): LaidSitemap {
  const rankdir = options.rankdir === "LR" ? "LR" : "TB";
  const pages = checked.pages;
  const w = boxWidth(pages);
  const measured = measure(pages, w);

  // The sibling axis is x for TB and y for LR, so what counts as a box's
  // "size" swaps with the orientation. Everything below is written once,
  // against the abstract axes, and mapped to x/y at the end.
  const sized = new Map<string, { size: number; thick: number }>();
  for (const p of pages) {
    const m = measured.get(p.id)!;
    sized.set(p.id, rankdir === "TB" ? { size: m.w, thick: m.h } : { size: m.h, thick: m.w });
  }

  const maxDepth = Math.max(1, ...pages.map((p) => checked.depth.get(p.id) ?? 1));
  /** The thickest box at each level decides where the next level starts. */
  const levelThick: number[] = new Array(maxDepth + 1).fill(0);
  for (const p of pages) {
    const d = checked.depth.get(p.id) ?? 1;
    levelThick[d] = Math.max(levelThick[d]!, sized.get(p.id)!.thick);
  }
  const levelAt: number[] = new Array(maxDepth + 1).fill(0);
  for (let d = 2; d <= maxDepth; d++) levelAt[d] = levelAt[d - 1]! + levelThick[d - 1]! + DGAP;

  const along = new Map<string, number>();
  if (options.layout === "dagre") {
    for (const [id, pos] of dagrePositions(checked, sized, rankdir)) along.set(id, pos);
  } else {
    const { root, byId } = buildTree(checked, sized);
    tidy(root);
    for (const [id, node] of byId) along.set(id, node.pos);
  }

  // Normalise: the leftmost (topmost, for LR) box edge sits at the margin.
  let min = Infinity;
  let max = -Infinity;
  for (const p of pages) {
    const half = sized.get(p.id)!.size / 2;
    const c = along.get(p.id) ?? 0;
    min = Math.min(min, c - half);
    max = Math.max(max, c + half);
  }
  if (!pages.length) {
    min = 0;
    max = 0;
  }

  const span = max - min;
  const depthSpan = levelAt[maxDepth]! + (levelThick[maxDepth] ?? 0);
  const frameW = r2(
    Math.max(420, rankdir === "TB" ? PAD * 2 + span : PAD * 2 + depthSpan),
  );
  const HEAD = headerHeight(subtitle, frameW);

  const drawn: DrawPage[] = [];
  const place = new Map<string, Placement>();
  for (const p of pages) {
    const m = measured.get(p.id)!;
    const s = sized.get(p.id)!;
    const d = checked.depth.get(p.id) ?? 1;
    const center = (along.get(p.id) ?? 0) - min;
    // For TB every box in a row gets the ROW's height, for the same reason
    // every box gets one width: a level of a sitemap is read as a menu, and
    // ragged boxes make one entry look more important than its siblings. It
    // is free — the row already takes its tallest box's height, so this fills
    // the space that was white anyway rather than adding any. (For LR the
    // depth axis is x and the widths are already uniform, so there is nothing
    // to even up; the heights there vary ALONG the column, which is what a
    // column of different-sized things is supposed to look like.)
    const at: Placement =
      rankdir === "TB"
        ? { x: r2(PAD + center - s.size / 2), y: r2(HEAD + levelAt[d]!), w: m.w, h: levelThick[d]! }
        : { x: r2(PAD + levelAt[d]!), y: r2(HEAD + center - s.size / 2), w: m.w, h: m.h };
    place.set(p.id, at);
    drawn.push(pageSpecToDraw(p, m, at, d));
  }

  const graph: SitemapGraph = {
    kind: "sitemap",
    rankdir,
    colorByTarget: options.colorByTarget !== false,
    liveRoute: options.liveRoute !== false,
    nodes: pages.map((p) => ({
      id: p.id,
      kind: (p.kind ?? "page") as PageKind,
      cls: (p.cls ?? "plain") as FlowClass,
      at: place.get(p.id)!,
    })),
    edges: containment(checked),
  };

  const edges = routeSitemap(graph, place).edges;

  const frameH = rankdir === "TB" ? HEAD + depthSpan + PAD : HEAD + span + PAD;

  let leaves = 0;
  let sections = 0;
  for (const p of pages) {
    if (!(checked.children.get(p.id) ?? []).length) leaves++;
    if (p.kind === "section") sections++;
  }

  return {
    pages: drawn,
    edges,
    graph,
    w: frameW,
    h: r2(Math.max(220, frameH)),
    leaves,
    depth: pages.length ? maxDepth : 0,
    sections,
  };
}

/** Parent → child, in declaration order, which is the drawing order too. */
function containment(checked: SitemapCheck): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  for (const p of checked.pages) {
    const kids = checked.children.get(p.id) ?? [];
    for (const kid of kids) out.push({ from: p.id, to: kid });
  }
  return out;
}

/**
 * The escape hatch. dagre is handed the containment tree as a graph and asked
 * for positions along the sibling axis only — the level positions stay ours,
 * so a dagre sitemap and a tidy one have identical rows and differ only in how
 * tightly the branches pack.
 */
function dagrePositions(
  checked: SitemapCheck,
  sized: Map<string, { size: number; thick: number }>,
  rankdir: "TB" | "LR",
): Map<string, number> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir, nodesep: SEP, ranksep: DGAP, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const p of checked.pages) {
    const s = sized.get(p.id)!;
    g.setNode(p.id, rankdir === "TB" ? { width: s.size, height: s.thick } : { width: s.thick, height: s.size });
  }
  for (const e of containment(checked)) g.setEdge(e.from, e.to);
  dagre.layout(g);
  const out = new Map<string, number>();
  for (const p of checked.pages) {
    const n = g.node(p.id) as { x: number; y: number } | undefined;
    out.set(p.id, rankdir === "TB" ? (n?.x ?? 0) : (n?.y ?? 0));
  }
  return out;
}

// ------------------------------------------------------------------ drawing ----

const SECTION = { fill: "#eef2f7", stroke: "#475569" };

/**
 * What each kind looks like, and why it composes rather than being four
 * unrelated looks.
 *
 * Three independent signals, so a reader learns one rule instead of four:
 *
 *   stroke   INK = a page you navigate TO; MUTED = something else
 *   dash     solid = ours; dashed = not ours to design
 *   radius   10 = a page; 18 = an overlay that opens on top of one
 *
 * A `modal` therefore reads as muted + pill, an `external` as muted + dashed,
 * and a `section` carries a tint because it is the one kind that is a GROUP
 * rather than a thing. Radius alone was not enough: on the first real drawing
 * four of seven boxes were dialogs and nothing but the corners said so, which
 * is exactly the distinction this kind exists to make (a modal is not a
 * navigation level, and the depth rule exempts it for that reason).
 */
function pageSpecToDraw(p: PageSpec, m: Measured, at: Placement, depth: number): DrawPage {
  const kind = (p.kind ?? "page") as PageKind;
  // An explicit class is the author saying what this page MEANS, so it wins
  // over the kind's default look.
  const pal = p.cls ? PALETTE[p.cls] : kind === "section" ? SECTION : PALETTE.plain;
  const notANavLevel = kind === "modal" || kind === "external";
  return {
    id: p.id,
    name: `page:${p.id} · ${label(p)}`,
    kind,
    at,
    fill: pal.fill,
    stroke: notANavLevel && !p.cls ? MUTED : pal.stroke,
    dashed: kind === "external",
    radius: kind === "modal" ? 18 : 10,
    title: m.titleLines,
    detail: m.detailLines,
    depth,
    ...(artboardsOf(p).length ? { screenId: artboardsOf(p) } : {}),
  };
}

/**
 * A containment line, and why it is not routed.
 *
 * Four points: down out of the parent, across a shoulder, down into the child.
 * Every child of one parent shares that shoulder's y, so the lines read as one
 * bracket even though each is its own layer — which is what keeps them
 * individually re-routable when a page is dragged.
 *
 * No arrow head. A head would say "go here next", which is the userflow's
 * relation, not this one's.
 */
export function routeSitemap(
  graph: SitemapGraph,
  placed: Map<string, Placement>,
): { edges: DrawEdge[]; dropped: string[] } {
  const edges: DrawEdge[] = [];
  const dropped: string[] = [];
  const clsOf = new Map(graph.nodes.map((n) => [n.id, n.cls]));
  const kindOf = new Map(graph.nodes.map((n) => [n.id, n.kind]));

  for (const e of graph.edges) {
    const id = `${e.from}->${e.to}`;
    const p = placed.get(e.from);
    const c = placed.get(e.to);
    if (!p || !c) {
      dropped.push(id);
      continue;
    }
    edges.push({
      id,
      points: graph.rankdir === "TB" ? elbowTB(p, c) : elbowLR(p, c),
      color: lineColor(clsOf.get(e.to), graph.colorByTarget),
      dashed: kindOf.get(e.to) === "external",
    });
  }

  // Every child of one parent shares the stub out of it and the shoulder that
  // spans them, so whichever line is painted LAST owns those pixels. Left in
  // spec order that was the last child declared, which put a red stub under
  // "Cài đặt" and made the parent read as the failure — visible on the first
  // render and invisible to every assertion. Neutral lines go last, so a
  // shared segment is grey and only the drop into a classed page is tinted.
  edges.sort((a, b) => rank(a.color) - rank(b.color));
  return { edges, dropped };
}

/** Paint order: tinted first, neutral last, so shared segments end up grey. */
function rank(color: string): number {
  return color === RETURN_GRAY ? 1 : 0;
}

function elbowTB(p: Placement, c: Placement): Array<[number, number]> {
  const pcx = r2(p.x + p.w / 2);
  const ccx = r2(c.x + c.w / 2);
  const from = r2(p.y + p.h);
  const to = r2(c.y);
  if (Math.abs(pcx - ccx) < 1) return [[pcx, from], [ccx, to]];
  // Half the level gap normally; halfway when a drag has brought the two boxes
  // closer than that, so the shoulder never doubles back above the parent.
  const shoulder = to > from ? r2(to - Math.min(DGAP / 2, (to - from) / 2)) : r2(from + 12);
  return [
    [pcx, from],
    [pcx, shoulder],
    [ccx, shoulder],
    [ccx, to],
  ];
}

function elbowLR(p: Placement, c: Placement): Array<[number, number]> {
  const pcy = r2(p.y + p.h / 2);
  const ccy = r2(c.y + c.h / 2);
  const from = r2(p.x + p.w);
  const to = r2(c.x);
  if (Math.abs(pcy - ccy) < 1) return [[from, pcy], [to, ccy]];
  const shoulder = to > from ? r2(to - Math.min(DGAP / 2, (to - from) / 2)) : r2(from + 12);
  return [
    [from, pcy],
    [shoulder, pcy],
    [shoulder, ccy],
    [to, ccy],
  ];
}

/**
 * Containment lines are structure, not story, so they are grey by default
 * rather than ink: a sitemap has one line per page and INK-weight lines turn
 * the tree into a grid of strokes with the labels lost inside it. A page the
 * author marked as a failure or an edge case still tints its line, because
 * that is the one thing on a sitemap worth scanning for.
 */
function lineColor(cls: FlowClass | undefined, colorByTarget: boolean): string {
  if (!colorByTarget) return RETURN_GRAY;
  if (cls === "error") return ERROR_RED;
  if (cls === "edge") return EDGE_AMBER;
  return RETURN_GRAY;
}

export function emitSitemapDraw(
  laid: LaidSitemap,
  frame: { title: string; subtitle: string; name: string; x: number; y: number; parentId?: string },
  options: SitemapOptions,
): SitemapDraw {
  return {
    name: frame.name,
    title: frame.title,
    subtitle: frame.subtitle,
    x: frame.x,
    y: frame.y,
    w: laid.w,
    h: laid.h,
    ...(frame.parentId ? { parentId: frame.parentId } : {}),
    pages: laid.pages,
    edges: laid.edges,
    font: options.font && options.font.trim() ? options.font.trim() : "Inter",
    graph: laid.graph,
  };
}

/**
 * Re-route from where the boxes are NOW. The pure half of the reflow pass, so
 * the plugin side is only "read positions, write points".
 */
export function reflowSitemap(
  graph: SitemapGraph,
  placed: Map<string, Placement>,
): { edges: DrawEdge[]; dropped: string[]; moved: string[] } {
  const moved: string[] = [];
  for (const n of graph.nodes) {
    const at = placed.get(n.id);
    if (!at) continue;
    // A RESIZE moves the stub a child's line drops from, so w/h count as
    // moved here — the other reflows' samePlace already compares them.
    if (!samePlace(n.at, at)) moved.push(n.id);
  }
  const { edges, dropped } = routeSitemap(graph, placed);
  return { edges, dropped, moved };
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

export const SITEMAP_INK = INK;
