/// <reference types="@figma/plugin-typings" />
/**
 * One door for "put this diagram's arrows back on its boxes", whichever kind
 * of diagram it is. The live watcher and the reflow op both come through here,
 * so adding a diagram kind means adding it in ONE place rather than teaching
 * every caller about the new marker.
 */
import { reflowFrame, userflowFrames, userflowGraphOf, type ReflowReport } from "./userflow-reflow.js";
import {
  activityFrames,
  activityGraphOf,
  reflowActivityFrame,
  type ActivityReflowReport,
} from "./activity-reflow.js";
import { erdFrames, erdGraphOf, reflowErdFrame, type ErdReflowReport } from "./erd-reflow.js";
import {
  reflowSequenceFrame,
  sequenceFrames,
  sequenceGraphOf,
  type SequenceReflowReport,
} from "./sequence-reflow.js";
import { reflowStateFrame, stateFrames, stateGraphOf, type StateReflowReport } from "./state-reflow.js";
import {
  reflowSitemapFrame,
  sitemapFrames,
  sitemapGraphOf,
  type SitemapReflowReport,
} from "./sitemap-reflow.js";
import { DIAGRAM_MARKERS } from "./diagram-mark.js";

export type DiagramReport =
  | ReflowReport
  | ActivityReflowReport
  | ErdReflowReport
  | SequenceReflowReport
  | StateReflowReport
  | SitemapReflowReport;

export interface ReflowOpts {
  grow?: boolean;
  onlyIfMoved?: boolean;
  /** Re-route even the arrows somebody moved by hand. */
  force?: boolean;
  /** Boxes were deleted (or the caller asked): an empty frame is not mid-write. See scanBoxes. */
  deleted?: boolean;
}

/** Does this node carry a diagram we know how to re-route? */
export function isDiagramFrame(node: BaseNode): boolean {
  return (
    !!userflowGraphOf(node) ||
    !!activityGraphOf(node) ||
    !!erdGraphOf(node) ||
    !!sequenceGraphOf(node) ||
    !!stateGraphOf(node) ||
    !!sitemapGraphOf(node)
  );
}

/** Is live re-routing switched on for this frame? */
export function liveRouteOn(frame: FrameNode): boolean {
  const flow = userflowGraphOf(frame);
  if (flow) return flow.liveRoute;
  const activity = activityGraphOf(frame);
  if (activity) return activity.liveRoute;
  const erd = erdGraphOf(frame);
  if (erd) return erd.liveRoute;
  const seq = sequenceGraphOf(frame);
  if (seq) return seq.liveRoute;
  const state = stateGraphOf(frame);
  if (state) return state.liveRoute;
  const sitemap = sitemapGraphOf(frame);
  if (sitemap) return sitemap.liveRoute;
  return false;
}

export async function reflowAnyFrame(
  frame: FrameNode,
  opts?: ReflowOpts,
): Promise<DiagramReport | null> {
  if (userflowGraphOf(frame)) return reflowFrame(frame, opts);
  if (activityGraphOf(frame)) return reflowActivityFrame(frame, opts);
  if (erdGraphOf(frame)) return reflowErdFrame(frame, opts);
  if (sequenceGraphOf(frame)) return reflowSequenceFrame(frame, opts);
  if (stateGraphOf(frame)) return reflowStateFrame(frame, opts);
  if (sitemapGraphOf(frame)) return reflowSitemapFrame(frame, opts);
  return null;
}

/**
 * Every re-routable diagram on the page, at ANY depth.
 *
 * The per-kind lists only look at the page and its sections, so a diagram
 * drawn with `parentId` into a plain frame (or dragged into one) was never in
 * the DELETE sweep: deleting one of its boxes left its arrows dangling, and
 * reflow_diagram with no frameId skipped it. One native search, narrowed to
 * frames that carry one of our markers, is what keeps this cheap enough to run
 * on every delete on a large page — the JSON of a graph is only parsed for
 * the handful of frames that have one.
 */
export function diagramFrames(page: PageNode): FrameNode[] {
  let marked: readonly SceneNode[] | null = null;
  try {
    if (typeof page.findAllWithCriteria === "function") {
      marked = page.findAllWithCriteria({
        types: ["FRAME"],
        pluginData: { keys: [...DIAGRAM_MARKERS] },
      });
    }
  } catch {
    // An API surface without the criterion: fall back to the shallow lists,
    // which still cover every diagram on the page or in a section.
    marked = null;
  }
  if (marked) {
    const out: FrameNode[] = [];
    for (const node of marked) {
      if (node.type === "FRAME" && isDiagramFrame(node) && !insideInstanceOrComponent(node)) {
        out.push(node as FrameNode);
      }
    }
    return out;
  }
  return shallowDiagramFrames(page);
}

function shallowDiagramFrames(page: PageNode): FrameNode[] {
  const out: FrameNode[] = [];
  const seen = new Set<string>();
  for (const frame of userflowFrames(page).concat(activityFrames(page), erdFrames(page), sequenceFrames(page), stateFrames(page), sitemapFrames(page))) {
    if (seen.has(frame.id)) continue;
    seen.add(frame.id);
    out.push(frame);
  }
  return out;
}

/**
 * Walk up from a changed node to the diagram frame that owns it — all the way
 * to the page, like owningMarkedFrame in handlers/diagram.ts. The old four-hop
 * limit missed an ERD column's text (text → cell → row → entity → diagram is
 * five), so editing it re-routed nothing. The nearest diagram still wins.
 *
 * This runs for every node of every change batch, so `memo` (one per batch)
 * remembers the answer for each ancestor already walked: a paste of a thousand
 * layers into one frame climbs that frame's ancestry once, not a thousand
 * times, and a graph's JSON is parsed once per frame.
 */
/**
 * A diagram inside a component is a picture of one, not a live diagram: the
 * native search reaches into instances, and hiding or routing their layers
 * would write overrides onto every copy.
 */
function insideInstanceOrComponent(node: BaseNode): boolean {
  for (let cur = node.parent; cur && cur.type !== "PAGE"; cur = cur.parent) {
    if (cur.type === "INSTANCE" || cur.type === "COMPONENT" || cur.type === "COMPONENT_SET") return true;
  }
  return false;
}

export function owningDiagram(
  node: BaseNode | null,
  memo?: Map<string, FrameNode | null>,
): FrameNode | null {
  const walked: string[] = [];
  let found: FrameNode | null = null;
  let cur: BaseNode | null = node;
  while (cur && cur.type !== "PAGE" && cur.type !== "DOCUMENT") {
    const known = memo?.get(cur.id);
    if (known !== undefined) {
      found = known;
      break;
    }
    walked.push(cur.id);
    if (cur.type === "FRAME" && isDiagramFrame(cur)) {
      found = insideInstanceOrComponent(cur) ? null : (cur as FrameNode);
      break;
    }
    cur = cur.parent;
  }
  if (memo) for (const id of walked) memo.set(id, found);
  return found;
}
