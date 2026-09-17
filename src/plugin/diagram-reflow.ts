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

/** Every re-routable diagram on the page. */
export function diagramFrames(page: PageNode): FrameNode[] {
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
 * Walk up from a changed node to the diagram frame that owns it. A box is a
 * direct child of the frame and a text inside a box is one level deeper, so
 * four hops is more than enough — and bounded, because this runs on every
 * batch of document changes.
 */
export function owningDiagram(node: BaseNode | null): FrameNode | null {
  let cur: BaseNode | null = node;
  for (let hop = 0; cur && hop < 4; hop++) {
    if (cur.type === "FRAME" && isDiagramFrame(cur)) return cur as FrameNode;
    cur = cur.parent;
  }
  return null;
}
