/// <reference types="@figma/plugin-typings" />
/**
 * The layer plumbing a re-route needs, shared by every diagram kind: find the
 * shapes and arrows a frame already holds, move an arrow onto a new path, hide
 * the arrows of a shape that has been deleted, and let the frame grow when
 * somebody drags a box past its edge.
 *
 * Arrows are MOVED, never recreated: same layers, same z-order, same names, so
 * a re-route cannot disturb anything the user did to the diagram by hand.
 */
import { setArrowPolyline, setPolyline, setStrokeGroup } from "./vector-path.js";
import {
  ACTIVITY_MARKER,
  ERD_MARKER,
  DIAGRAM_MARKERS,
  JOURNEY_MARKER,
  SEQUENCE_MARKER,
  SITEMAP_MARKER,
  STATE_MARKER,
  USECASE_MARKER,
} from "./diagram-mark.js";
import { FLOW_MARKER, LEGACY_FLOW_MARKER } from "./flow-mark.js";
import { createTree } from "./handlers/create.js";
import { err } from "./errors.js";
import { ErrorCode } from "../shared/protocol.js";
import type { Placement } from "../shared/diagram/types.js";
import { findFreeSpot } from "../shared/diagram/place.js";
import type { Rect } from "../shared/diagram/place.js";
import type { HandlerContext } from "./context.js";
import { getNodeByIdSafe } from "./context.js";
import type { DrawEdge } from "../shared/diagram/types.js";

/** Frame padding the layout pass leaves around a diagram. */
const PAD = 40;

/**
 * Set on an arrow this module hid because its box was deleted, so a later
 * re-route can bring it back WITHOUT un-hiding an arrow the user chose to hide
 * by hand.
 */
const AUTO_HIDDEN = "reqwise.diagram.autoHidden";

/**
 * The geometry this module last WROTE to a layer, read back off the node so
 * any normalisation Figma applies is already baked in.
 *
 * This is what makes a hand edit stick. The router has no idea which
 * connection point reads best — a human nudging an arrow off a crossing does —
 * so when a layer no longer matches what we last wrote, the person editing
 * wins and we leave it alone. Undo the edit and it matches again, and the
 * arrow starts following its boxes once more.
 */
const LAST_WRITE = "reqwise.diagram.lastWrite";

/**
 * The polyline a drawn edge currently has, in FRAME coordinates — including
 * whatever a person just dragged it into. Returns null when the path is not a
 * plain polyline any more (a curve, several subpaths), because then there is
 * nothing to read an attachment point out of.
 */
export function readEdgePath(node: SceneNode): Array<[number, number]> | null {
  if (node.type !== "VECTOR") return null;
  const paths = (node as VectorNode).vectorPaths;
  if (paths.length !== 1) return null;
  const data = paths[0]!.data;
  if (/[CQAScqas]/.test(data)) return null;
  const out: Array<[number, number]> = [];
  const re = /([ML])\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/g;
  let m: RegExpExecArray | null;
  let seenMove = false;
  while ((m = re.exec(data))) {
    if (m[1] === "M") {
      if (seenMove) return null; // a second subpath: not ours to interpret
      seenMove = true;
    }
    out.push([Number(m[2]) + node.x, Number(m[3]) + node.y]);
  }
  return out.length >= 2 ? out : null;
}

/** Has this layer been changed since we last wrote it? */
export function edgeWasEdited(byName: Map<string, SceneNode>, id: string): boolean {
  const line = byName.get(`edge ${id}`);
  return !!line && wasEdited(line);
}

export function indexChildren(frame: FrameNode): Map<string, SceneNode> {
  const byName = new Map<string, SceneNode>();
  for (const child of frame.children) byName.set(child.name, child);
  return byName;
}

/** `<prefix><id>` exactly, or `<prefix><id> · label` — never `<prefix><id2>`. */
export function findShape(frame: FrameNode, prefix: string, id: string): SceneNode | null {
  const exact = `${prefix}${id}`;
  const withLabel = `${exact} `;
  for (const child of frame.children) {
    if (child.name === exact || child.name.indexOf(withLabel) === 0) return child;
  }
  return null;
}

export type EdgeApply = "moved" | "pinned" | "missing";

/**
 * Move one arrow (line, head and label) onto its new route.
 *
 * `pinned` = somebody moved this arrow by hand since we last wrote it, so it
 * is left exactly as they left it. `force` overrides that and re-routes it
 * anyway, which also re-arms the tracking.
 */
export async function applyEdge(
  byName: Map<string, SceneNode>,
  e: DrawEdge,
  opts?: { force?: boolean; arrow?: boolean; cap?: "filled" | "line" | "none" },
): Promise<EdgeApply> {
  const line = byName.get(`edge ${e.id}`);
  if (!line || line.type !== "VECTOR") return "missing";

  const force = opts?.force === true;
  if (!force && wasEdited(line)) return "pinned";

  // An ERD line carries a crow's foot, not an arrow head: the notation says
  // how many rows, not which way to travel. A sequence reply carries the open
  // head, a call the filled one.
  const cap = opts?.cap ?? (opts?.arrow === false ? "none" : "filled");
  if (cap === "none") setPolyline(line as VectorNode, e.points, false);
  else await setArrowPolyline(line as VectorNode, e.points, cap === "line" ? "ARROW_LINES" : "ARROW_EQUILATERAL");
  remember(line);
  unhide(line);

  // Older frames drew the head as a separate triangle. Now that the head is a
  // cap on the line, the leftover would sit there for ever pointing nowhere.
  const stale = byName.get(`arrow ${e.id}`);
  if (stale) {
    stale.remove();
    byName.delete(`arrow ${e.id}`);
  }

  // The label is tracked on its own: moving a colliding label out of the way is
  // a smaller decision than re-drawing the arrow, and worth keeping separately.
  const label = byName.get(`label ${e.id}`);
  if (label && e.label && (force || !wasEdited(label))) {
    label.x = e.label.x;
    label.y = e.label.y;
    remember(label);
    unhide(label);
  }
  return "moved";
}

/**
 * Stamp every arrow the draw pass just created, so a hand edit made BEFORE the
 * first re-route is recognised as one. Without this the first drag anywhere in
 * the diagram would quietly overwrite it — which is exactly when somebody is
 * most likely to be tidying up what the agent drew.
 */
export function rememberDrawnEdges(frame: FrameNode): void {
  for (const child of frame.children) {
    const name = child.name;
    if (name.indexOf("edge ") === 0 || name.indexOf("label ") === 0) remember(child);
  }
}

/** Where a layer sits and what shape it is, to the quarter pixel. */
function signature(node: SceneNode): string {
  const at = `${round(node.x)},${round(node.y)}`;
  if (node.type !== "VECTOR") return at;
  const paths = (node as VectorNode).vectorPaths;
  return `${at}|${paths.map((p) => p.data).join(";")}`;
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Does this layer differ from what we last wrote to it? */
function wasEdited(node: SceneNode): boolean {
  let last = "";
  try {
    last = node.getPluginData(LAST_WRITE);
  } catch {
    return false;
  }
  // Nothing recorded (a diagram drawn by an older build): not a hand edit —
  // it just has not been tracked yet, and this pass starts tracking it.
  if (!last) return false;
  return last !== signature(node);
}

function remember(node: SceneNode): void {
  try {
    node.setPluginData(LAST_WRITE, signature(node));
  } catch {
    // A node that refuses plugin data simply is not tracked; it will be
    // re-routed every time, which is the old behaviour.
  }
}

/**
 * Move the crow's feet (and their optionality circles) onto the ends of the
 * lines they belong to. They are siblings of the line — a stroke group cannot
 * be a cap — so a re-route has to bring them along.
 */
export async function applyMarkers(
  byName: Map<string, SceneNode>,
  markers: Array<{
    id: string;
    strokes: Array<Array<[number, number]>>;
    circle?: { x: number; y: number; r: number };
  }>,
): Promise<void> {
  for (const m of markers) {
    const shape = byName.get(`mark ${m.id}`);
    if (shape && shape.type === "VECTOR" && m.strokes.length) {
      await setStrokeGroup(shape as VectorNode, m.strokes);
      // A marker the user hid by hand stays hidden — unhide only reverses the
      // hide WE stamped when its box went away, same contract as the arrows.
      unhide(shape);
    }
    const circle = byName.get(`mark-o ${m.id}`);
    if (circle && m.circle) {
      circle.x = m.circle.x;
      circle.y = m.circle.y;
      unhide(circle);
    }
  }
}

/**
 * Hide the arrow whose box is gone. Hidden, not deleted: an undone delete
 * brings the box back, and the next re-route shows the arrow again exactly as
 * it was.
 */
export function hideEdge(byName: Map<string, SceneNode>, id: string): number {
  let hidden = 0;
  for (const name of [`edge ${id}`, `arrow ${id}`, `label ${id}`]) {
    hidden += hideLayer(byName, name);
  }
  return hidden;
}

/**
 * Hide ONE named layer the way hideEdge hides an arrow: stamped, so a later
 * re-route can bring it back WITHOUT un-hiding a layer the user hid by hand.
 * For the siblings a line does not own — a sequence note, a lifeline, an
 * activation bar, a fragment box, a decision's question text — which would
 * otherwise stay afloat when the thing they belonged to is gone.
 */
export function hideLayer(byName: Map<string, SceneNode>, name: string): number {
  const layer = byName.get(name);
  if (!layer || !layer.visible) return 0;
  layer.visible = false;
  setAutoHidden(layer, true);
  return 1;
}

/**
 * Grow the frame so a box dragged past its edge stays inside it. Never
 * shrinks: a drag would then fight the frame closing in behind it.
 */
export function growToFit(frame: FrameNode): void {
  let maxX = 0;
  let maxY = 0;
  for (const child of frame.children) {
    if (!child.visible) continue;
    maxX = Math.max(maxX, child.x + child.width);
    maxY = Math.max(maxY, child.y + child.height);
  }
  const w = Math.max(frame.width, Math.ceil(maxX + PAD));
  const h = Math.max(frame.height, Math.ceil(maxY + PAD));
  if (w !== frame.width || h !== frame.height) frame.resize(w, h);
}

/** Show a layer again only if WE hid it when its box went away. */
export function unhide(node: SceneNode): void {
  if (node.visible) return;
  let flag = "";
  try {
    flag = node.getPluginData(AUTO_HIDDEN);
  } catch {
    flag = "";
  }
  if (flag !== "1") return;
  node.visible = true;
  setAutoHidden(node, false);
}

/**
 * Every box is back and nothing moved: show again every layer WE hid.
 *
 * Undoing a box delete puts the box back exactly where it was, so a pass that
 * only acts when something moved or went missing found nothing to do and
 * returned — leaving the arrows it hid when the box went away hidden for good.
 * With no box missing, nothing a hide was answering is still true, so all of
 * them can come back. It writes only while a stamped layer is still hidden,
 * so the pass our own write triggers finds none and settles. A layer the user
 * hid by hand carries no stamp and stays hidden.
 */
export function restoreAutoHidden(byName: Map<string, SceneNode>): number {
  let shown = 0;
  byName.forEach((layer) => {
    if (layer.visible) return;
    unhide(layer);
    if (layer.visible) shown++;
  });
  return shown;
}

function setAutoHidden(node: SceneNode, on: boolean): void {
  try {
    node.setPluginData(AUTO_HIDDEN, on ? "1" : "");
  } catch {
    // A node that refuses plugin data still hides correctly; it just will not
    // come back on its own.
  }
}


/**
 * The four Inter faces every diagram draws with, loaded once before the first
 * TEXT node exists. Six handlers each carried a copy of this; a font that
 * cannot be loaded is a warning, not a failure, because the boxes were sized
 * for it and the reader needs to know why the text does not fit.
 */
export async function preloadDiagramFonts(
  ctx: { warn: (msg: string) => void },
  font: string,
): Promise<void> {
  const styles = ["Bold", "Semi Bold", "Medium", "Regular"];
  const failed: string[] = [];
  for (const style of styles) {
    try {
      await figma.loadFontAsync({ family: font, style });
    } catch {
      failed.push(style);
    }
  }
  if (failed.length === styles.length) {
    ctx.warn(
      `None of the ${font} faces could be loaded (${failed.join(", ")}) — the diagram will fall back to whatever font this file has, and the boxes were sized for ${font}, so text may not fit.`,
    );
  }
}

/**
 * Read back the MODEL a drawn diagram was made from.
 *
 * The frame carries it (each handler writes `source` into its marker), so a
 * finding can be fixed by patching one field instead of re-sending the whole
 * spec — which is what "redraw-based" cost in practice: on the ticket-booking
 * set, 73% of the JSON an agent emitted was a spec it had already emitted.
 */
export function readDiagramSource(node: BaseNode): {
  kind?: string;
  title?: string;
  source?: unknown;
} {
  // The CONSTANTS, never a hand-typed copy of them: this list once said
  // "reqwise.flow" while the userflow marker was "reqwise.userflow", so no
  // userflow frame could be read back, patched, or redrawn in place — and the
  // only symptom was "not a frame drawn by a diagram tool" on a frame one of
  // these tools had just drawn.
  for (const key of DIAGRAM_MARKERS) {
    let raw = "";
    try {
      raw = node.getPluginData(key);
    } catch {
      continue;
    }
    if (!raw) continue;
    try {
      const mark = JSON.parse(raw) as Record<string, unknown>;
      return {
        ...(typeof mark.kind === "string" ? { kind: mark.kind } : {}),
        ...(typeof mark.title === "string" ? { title: mark.title } : {}),
        ...(mark.source !== undefined ? { source: mark.source } : {}),
      };
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Get the frame a diagram is about to be drawn into: a new one, or the one the
 * caller asked to redraw.
 *
 * All six kinds opened their frame with the same twenty lines, and all six paid
 * for a `figma.getNodeByIdAsync` immediately after creating it — a round trip
 * into the editor to fetch a node we had just made. `createTree` hands the live
 * node back, so that lookup is gone.
 *
 * Redrawing IN PLACE keeps the frame id, which is the whole point of it:
 * comments pinned to the frame, prototype links into it, and wherever the user
 * dragged it all survive a change to the model. Its position and its parent are
 * therefore left exactly as they are — only the size and the contents follow
 * the new drawing.
 */
/**
 * "This frame is being written right now", stored ON the frame.
 *
 * `paused` in diagram-live holds the live pass, but it cannot stop a second
 * op: after a bridge timeout the next op starts while the plugin is still
 * drawing, and a live batch already pulled from the queue keeps going. A
 * redraw empties the frame while its old graph is still stored, so any pass
 * that reached it then — flagged `deleted` or not — would read "no box left"
 * and hide every line. The mark is what scanBoxes trusts over any flag. It
 * carries a time so a draw that died with the plugin cannot pin it forever.
 */
const DRAWING_KEY = "reqwise.drawing";
const DRAWING_STALE_MS = 5 * 60_000;
const drawnBy = new WeakMap<HandlerContext, FrameNode[]>();

function markDrawing(ctx: HandlerContext, frame: FrameNode): void {
  try {
    frame.setPluginData(DRAWING_KEY, String(Date.now()));
  } catch {
    return;
  }
  const list = drawnBy.get(ctx) ?? [];
  list.push(frame);
  drawnBy.set(ctx, list);
}

/** Clear the marks this op set. Called by whileDrawing, in `finally`. */
export function endDrawing(ctx: HandlerContext): void {
  for (const frame of drawnBy.get(ctx) ?? []) {
    try {
      if (!frame.removed) frame.setPluginData(DRAWING_KEY, "");
    } catch {
      // A frame deleted mid-draw has nothing left to clear.
    }
  }
  drawnBy.delete(ctx);
}

export function isBeingDrawn(frame: BaseNode): boolean {
  let at = 0;
  try {
    at = Number(frame.getPluginData(DRAWING_KEY)) || 0;
  } catch {
    return false;
  }
  return at > 0 && Date.now() - at < DRAWING_STALE_MS;
}

export async function openDiagramFrame(
  ctx: HandlerContext,
  frameSpec: Record<string, unknown>,
  intoFrameId?: string,
): Promise<FrameNode> {
  if (intoFrameId) {
    const reopened = await reopenFrame(intoFrameId, frameSpec, (f) => markDrawing(ctx, f));
    return reopened;
  }

  await keepClearOfExistingWork(ctx, frameSpec);

  const node = await createTree({
    params: frameSpec,
    warnings: ctx.warnings,
    progress: ctx.progress,
    warn: ctx.warn,
  });
  const frame = node as unknown as FrameNode;
  if (!frame || frame.type !== "FRAME") {
    throw err(ErrorCode.INTERNAL, "The diagram frame disappeared right after it was created.");
  }
  markDrawing(ctx, frame);
  return frame;
}

/**
 * Move the frame off anything already drawn, and say so.
 *
 * Every kind defaults to `x: 0, y: 0` and nothing checked what was there, so
 * the first diagram drawn into a real working file landed on top of the
 * user's screens — reported from a live file whose page had a 1024×1000
 * screen sitting exactly at the origin. A frame is a sibling rather than a
 * paint bucket, so nothing was lost, but work you cannot see is work you
 * assume is gone.
 *
 * Moving is NOT silent. The caller asked for a position, and a tool that
 * quietly does something else with it teaches people to stop believing the
 * numbers they pass; the warning names what was in the way and where the
 * frame went instead.
 */
async function keepClearOfExistingWork(
  ctx: HandlerContext,
  frameSpec: Record<string, unknown>,
): Promise<void> {
  const w = Number(frameSpec.width ?? frameSpec.w);
  const h = Number(frameSpec.height ?? frameSpec.h);
  if (!(w > 0) || !(h > 0)) return;

  // Coordinates are relative to whatever the frame is going into, so the
  // things it can collide with are that container's children — the page's
  // when it is going onto the page.
  const parentId = typeof frameSpec.parentId === "string" ? frameSpec.parentId : "";
  let siblings: readonly SceneNode[];
  if (parentId) {
    const parent = await getNodeByIdSafe(parentId);
    if (!parent || !("children" in parent)) return;
    siblings = (parent as ChildrenMixin).children;
  } else {
    siblings = figma.currentPage.children;
  }

  const occupied: Rect[] = [];
  for (const node of siblings) {
    // An invisible layer covers nothing, and a locked one is usually a
    // background the user parked there on purpose.
    if (!node.visible) continue;
    occupied.push({ x: node.x, y: node.y, w: node.width, h: node.height, name: node.name });
  }
  if (!occupied.length) return;

  const want = { x: Number(frameSpec.x) || 0, y: Number(frameSpec.y) || 0, w, h };
  const spot = findFreeSpot(occupied, want);
  if (!spot.moved) return;

  frameSpec.x = spot.x;
  frameSpec.y = spot.y;
  ctx.warn(
    `"${spot.blockedBy}" is already at ${want.x},${want.y}, so the diagram was drawn at ${spot.x},${spot.y} instead — clear of it. Pass x/y to put it somewhere else.`,
  );
}

/**
 * Empty an existing diagram frame and resize it for the new drawing.
 *
 * It must be a frame one of these tools drew. Clearing children is destructive
 * and a frame id is easy to get wrong by one digit, so a frame with no diagram
 * marker is refused rather than emptied — the cost of being wrong here is
 * somebody's artwork.
 */
async function reopenFrame(
  frameId: string,
  frameSpec: Record<string, unknown>,
  beforeEmptying: (frame: FrameNode) => void,
): Promise<FrameNode> {
  const node = await getNodeByIdSafe(frameId);
  if (!node) {
    throw err(
      ErrorCode.NODE_NOT_FOUND,
      `Node "${frameId}" not found — nothing was changed.`,
      "Pass the frameId a diagram tool returned. figma_read get_design_context lists what is on the page.",
    );
  }
  if (node.type !== "FRAME") {
    throw err(
      ErrorCode.INVALID_PARAMS,
      `"${node.name}" is a ${node.type}, not a frame — nothing was changed.`,
      "Only a frame drawn by figma_diagram can be redrawn in place.",
    );
  }
  if (!readDiagramSource(node).kind) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      `"${node.name}" was not drawn by a diagram tool, so it will not be emptied.`,
      "Redrawing in place clears the frame. Pass the frameId a diagram tool returned, or leave it out to draw a new frame.",
    );
  }

  const frame = node as FrameNode;
  beforeEmptying(frame);
  for (const child of [...frame.children]) child.remove();

  const w = Number(frameSpec.width ?? frameSpec.w);
  const h = Number(frameSpec.height ?? frameSpec.h);
  if (w > 0 && h > 0) frame.resize(w, h);
  const name = frameSpec.name;
  if (typeof name === "string" && name) frame.name = name;
  return frame;
}

/**
 * Every diagram model on this frame's page, the frame just drawn included —
 * its marker has already been written by the time this runs.
 *
 * Handed back WITH the drawing rather than fetched afterwards, because a
 * separate read would be a bridge round trip per diagram, and a batch of five
 * would pay it five times. `getPluginData` is synchronous and never enters the
 * editor, so gathering this costs nothing a throttled tab can tax — which is
 * the whole reason the round-trip count was worth cutting in the first place.
 */
/**
 * The frames on this page that are NOT diagrams — the designs, as far as
 * anything here can tell.
 *
 * Deliberately shallow and deliberately generous: a top-level FRAME or
 * COMPONENT with no diagram marker. Nothing else on a page is plausibly a
 * screen, and anything cleverer (guessing by size, by name, by whether it
 * looks like a phone) would be a rule nobody could predict. The coverage
 * check is what decides whether an entry matters, and it stays silent until
 * the author has actually named artboards on their sitemap.
 */
/**
 * Where every box of a stored graph is on the canvas right now — and whether
 * the frame is worth re-routing at all.
 *
 * All seven reflows opened with the same loop, and all seven drew the same
 * wrong conclusion from an empty result. A diagram's lines are appended BEFORE
 * its boxes so they sit under them, and `parent` counts as a geometry change,
 * so `nodechange` fires during the append and the live watcher can run a pass
 * in the window where the lines exist and the boxes do not. That pass found no
 * boxes, concluded every one had been deleted, and hid every line on the
 * diagram — and since nothing further changed, no later pass ever brought them
 * back. One badly-timed reflow silently gutted the drawing until somebody
 * redrew it.
 *
 * Hiding a line is a destructive conclusion, so it needs evidence. ONE box
 * missing while the others are there is a deleted node and still hides its
 * lines. NOT ONE of them found is evidence of something else — a frame
 * mid-write, or a graph that does not belong to this frame — and `midWrite`
 * says so, so the caller can return without touching anything.
 */
export interface BoxScan {
  placed: Map<string, Placement>;
  /** Ids the graph names that are not on the canvas. Empty when `midWrite`. */
  goneBoxes: string[];
  /** The nodes that WERE found, for callers that need the node itself. */
  shapes: Map<string, SceneNode>;
  /** The graph names boxes and not one of them is there. Do nothing. */
  midWrite: boolean;
}

export function scanBoxes<T extends { id: string }>(
  frame: FrameNode,
  nodes: readonly T[],
  prefix: string | ((node: T) => string),
  /**
   * There is evidence the boxes were DELETED — a DELETE change reached the live
   * watcher, or somebody called reflow_diagram on purpose. Then "not one box
   * found" means a person emptied the diagram, and its arrows have to go too;
   * without this, deleting every box left every arrow on the canvas forever.
   */
  deleted = false,
): BoxScan {
  const placed = new Map<string, Placement>();
  const shapes = new Map<string, SceneNode>();
  const goneBoxes: string[] = [];
  for (const n of nodes) {
    const node = findShape(frame, typeof prefix === "string" ? prefix : prefix(n), n.id);
    if (!node) {
      goneBoxes.push(n.id);
      continue;
    }
    shapes.set(n.id, node);
    placed.set(n.id, { x: node.x, y: node.y, w: node.width, h: node.height });
  }
  const midWrite = nodes.length > 0 && placed.size === 0 && (!deleted || isBeingDrawn(frame));
  return { placed, shapes, goneBoxes: midWrite ? [] : goneBoxes, midWrite };
}

/**
 * A page's canvas-level items: its children, plus the children of any
 * SECTION. A section groups work — it does not make its contents any less
 * top-level — and a diagram drawn with `parentId`, or dragged into one by
 * hand, is still a diagram the reflows and lookups have to find. The
 * userflow handler's `linkScreens` makes the same descent for artboards.
 */
export function canvasChildren(page: BaseNode & ChildrenMixin): SceneNode[] {
  const out: SceneNode[] = [];
  const walk = (parent: BaseNode & ChildrenMixin) => {
    for (const child of parent.children) {
      // Sections nest (a section inside a section is one drag away).
      if (child.type === "SECTION") walk(child);
      else out.push(child as SceneNode);
    }
  };
  walk(page);
  return out;
}

export function pageArtboards(page: BaseNode & ChildrenMixin): Array<{ nodeId: string; name: string }> {
  const out: Array<{ nodeId: string; name: string }> = [];
  for (const child of canvasChildren(page)) {
    if (child.type !== "FRAME" && child.type !== "COMPONENT") continue;
    if (readDiagramSource(child).kind) continue;
    out.push({ nodeId: child.id, name: child.name });
  }
  return out;
}

export function pageModel(frame: FrameNode): Array<Record<string, unknown>> {
  // The PAGE, not the frame's parent: a diagram inside a SECTION saw only the
  // section's diagrams, and one on the page never saw those in a section.
  let page: BaseNode | null = frame.parent;
  while (page && page.type !== "PAGE") page = page.parent;
  if (!page) return [];
  const out: Array<Record<string, unknown>> = [];
  // Plus the frame's own siblings: a diagram drawn with parentId into a plain
  // board frame is not canvas-level, and must still see itself and its
  // neighbours. De-duplicated, since in a section those are the same nodes.
  const seen = new Set<string>();
  const candidates = [...canvasChildren(page as PageNode)];
  const parent = frame.parent;
  if (parent && parent.type !== "PAGE" && parent.type !== "SECTION" && "children" in parent) {
    candidates.push(...(parent as ChildrenMixin).children);
  }
  for (const child of candidates) {
    if (seen.has(child.id)) continue;
    seen.add(child.id);
    const mark = readDiagramSource(child);
    if (!mark.kind || mark.source === undefined) continue;
    out.push({
      nodeId: child.id,
      kind: mark.kind,
      ...(mark.title ? { title: mark.title } : {}),
      spec: mark.source,
    });
  }
  return out;
}
