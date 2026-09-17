/// <reference types="@figma/plugin-typings" />
/**
 * Re-attach a drawn sitemap's containment lines to its page boxes.
 *
 * Shorter than the other six reflows, and the two things it does NOT do are
 * the point:
 *
 *  - **No hand-edit adoption.** Dragging the end of a transition onto another
 *    face is a routing preference, so the state and activity reflows adopt it
 *    and remember it. Dragging the end of a containment line onto another page
 *    is not a preference — it means "this page now lives somewhere else",
 *    which is a change to the MODEL. Adopting it would let the picture and the
 *    stored model disagree about the IA while both looked right, so a line
 *    moved by hand is simply put back where the boxes say it goes. Moving a
 *    page in the tree is a patch on its `parent`.
 *  - **No orphaned label fixing.** A page box is a FRAME with its own text
 *    inside it, so dragging it carries its name along and there is nothing
 *    here to reposition.
 */
import { readDiagramData, SITEMAP_MARKER } from "./diagram-mark.js";
import { applyEdge, canvasChildren, edgeEnds, growToFit, hideEdge, indexChildren, scanBoxes, restoreAutoHidden } from "./diagram-apply.js";
import { reflowSitemap } from "../shared/sitemap/layout.js";
import type { PageKind, SitemapGraph } from "../shared/sitemap/types.js";
import type { FlowClass, Placement } from "../shared/diagram/types.js";

export interface SitemapReflowReport {
  frameId: string;
  name: string;
  kind: "sitemap";
  /** false = every page is still where the layout pass put it. */
  changed: boolean;
  routed: number;
  hidden: number;
  missing: string[];
  /**
   * Always empty. A containment line moved by hand is put back rather than
   * pinned — see the note at the top of this file — and the field stays so
   * every reflow report has the same shape.
   */
  pinned: string[];
  goneBoxes: string[];
}

export function sitemapGraphOf(node: BaseNode): SitemapGraph | null {
  const mark = readDiagramData(node, SITEMAP_MARKER);
  return mark ? normalizeGraph(mark.graph) : null;
}

export function sitemapFrames(page: PageNode): FrameNode[] {
  const out: FrameNode[] = [];
  for (const child of canvasChildren(page)) {
    if (child.type === "FRAME" && sitemapGraphOf(child)) out.push(child);
  }
  return out;
}

export async function reflowSitemapFrame(
  frame: FrameNode,
  opts?: { grow?: boolean; onlyIfMoved?: boolean; force?: boolean; deleted?: boolean },
): Promise<SitemapReflowReport | null> {
  const graph = sitemapGraphOf(frame);
  if (!graph) return null;

  const byName = indexChildren(frame);
  const scan = scanBoxes(frame, graph.nodes, "page:", opts?.deleted === true);
  const { placed, goneBoxes } = scan;

  // Not one box found, though the graph names some: this frame is being
  // written, not emptied. Routing on from here would hide every line and
  // nothing would ever bring them back — see scanBoxes.
  if (scan.midWrite) {
    return {
      frameId: frame.id,
      name: frame.name,
      kind: "sitemap",
      changed: false,
      routed: 0,
      hidden: 0,
      missing: [],
      pinned: [],
      goneBoxes: [],
    };
  }

  const { edges, dropped, moved } = reflowSitemap(graph, placed);
  const changed = moved.length > 0 || dropped.length > 0;
  if (opts?.onlyIfMoved && !changed) {
    // An undone delete brings its box back where it was, so nothing reads as
    // moved — but the lines hidden when it went are still hidden. See
    // restoreAutoHidden, which brings back each layer whose own boxes are
    // back even while some other box is still missing.
    restoreAutoHidden(byName, scan);
    return {
      frameId: frame.id,
      name: frame.name,
      kind: "sitemap",
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
  for (const e of edges) {
    // `arrow: false` is LOAD-BEARING, not a detail. `applyEdge` caps a line
    // with a filled head unless told otherwise, so without this the reflow
    // pass grew an arrow head on every containment line — turning "this page
    // lives under that one" into "go here next", which is the one thing this
    // kind exists not to say. The draw path was correct and only the reflow
    // was wrong, so the drawing was right until somebody dragged a box.
    //
    // `force` on every line, always: a containment line has no hand-tidied
    // state worth keeping, so "put it back on the boxes" is the whole job.
    const applied = await applyEdge(byName, e, { force: true, arrow: false });
    if (applied === "moved") routed++;
    else if (applied !== "pinned") missing.push(e.id);
  }

  let hidden = 0;
  for (const id of dropped) hidden += hideEdge(byName, id, edgeEnds(id));

  // A layer hidden for a box that is back, but which the pass above did not
  // touch (a hand-moved arrow is left alone, so applyEdge never un-hides it),
  // and the stamp of a layer somebody showed by hand. Layers hidden above
  // wait for a box that is still gone, so nothing flips back.
  restoreAutoHidden(byName, scan);

  if (opts?.grow !== false) growToFit(frame);

  return {
    frameId: frame.id,
    name: frame.name,
    kind: "sitemap",
    changed,
    routed,
    hidden,
    missing,
    pinned: [],
    goneBoxes,
  };
}

// ------------------------------------------------------------- validation ----

const KINDS: PageKind[] = ["page", "section", "modal", "external"];
const CLASSES: FlowClass[] = ["happy", "error", "edge", "plain", "decision"];

/**
 * The graph comes back out of plugin data, which any build may have written,
 * so it is treated as untrusted input: anything malformed makes the frame
 * un-reflowable rather than throwing inside a document-change callback.
 */
function normalizeGraph(raw: unknown): SitemapGraph | null {
  if (!raw || typeof raw !== "object") return null;
  const g = raw as Record<string, unknown>;
  if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) return null;

  const nodes: SitemapGraph["nodes"] = [];
  for (const item of g.nodes) {
    if (!item || typeof item !== "object") continue;
    const n = item as Record<string, unknown>;
    const at = placement(n.at);
    if (typeof n.id !== "string" || !n.id || !at) continue;
    nodes.push({
      id: n.id,
      kind: KINDS.indexOf(n.kind as PageKind) >= 0 ? (n.kind as PageKind) : "page",
      cls: CLASSES.indexOf(n.cls as FlowClass) >= 0 ? (n.cls as FlowClass) : "plain",
      at,
    });
  }
  if (!nodes.length) return null;

  const edges: SitemapGraph["edges"] = [];
  for (const item of g.edges) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    if (typeof e.from !== "string" || typeof e.to !== "string") continue;
    edges.push({ from: e.from, to: e.to });
  }

  return {
    kind: "sitemap",
    rankdir: g.rankdir === "LR" ? "LR" : "TB",
    colorByTarget: g.colorByTarget !== false,
    liveRoute: g.liveRoute !== false,
    nodes,
    edges,
  };
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
