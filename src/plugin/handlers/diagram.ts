/// <reference types="@figma/plugin-typings" />
/**
 * `reflow_diagram`: put a drawn diagram's arrows back on its boxes, on demand.
 *
 * The live watcher does this on every drag while the plugin is open; this op is
 * the same pass for a diagram that was rearranged with the plugin closed, one
 * whose `liveRoute` is off, or after a box was deleted.
 */
import { HandlerContext } from "../context.js";
import { err, nodeNotFound } from "../errors.js";
import { ErrorCode } from "../../shared/protocol.js";
import { hasDiagramMarker } from "../diagram-mark.js";
import { diagramFrames, reflowAnyFrame, type DiagramReport } from "../diagram-reflow.js";

export async function reflowDiagram(ctx: HandlerContext): Promise<unknown> {
  const id = ctx.params.frameId ?? ctx.params.nodeId ?? ctx.params.id;
  const force = ctx.params.force === true;
  const frames: FrameNode[] = [];

  if (typeof id === "string" && id) {
    const node = await figma.getNodeByIdAsync(id);
    if (!node) throw nodeNotFound(id);
    // Point it at a box (or a label) and it still finds the diagram — the
    // caller should not have to know which layer holds the marker.
    const frame = owningMarkedFrame(node);
    if (!frame) {
      throw err(
        ErrorCode.INVALID_PARAMS,
        `Node "${id}" is not part of a diagram drawn by figma_diagram.`,
        "Pass the frameId those tools returned, or omit frameId to reflow every diagram on the page.",
      );
    }
    frames.push(frame);
  } else {
    for (const frame of diagramFrames(figma.currentPage)) frames.push(frame);
    if (!frames.length) {
      throw err(
        ErrorCode.NODE_NOT_FOUND,
        "No diagram on this page carries a routing graph.",
        "Frames drawn before this version have no stored graph — redraw the diagram to make its arrows follow the boxes.",
      );
    }
  }

  const reports: DiagramReport[] = [];
  for (const frame of frames) {
    const report = await reflowAnyFrame(frame, { force });
    if (!report) {
      ctx.warn(
        `"${frame.name}" has no stored routing graph (drawn by an older build) — redraw it to enable re-routing.`,
      );
      continue;
    }
    reports.push(report);
    if (report.goneBoxes.length) {
      ctx.warn(
        `"${frame.name}": ${report.goneBoxes.length} box(es) the diagram names are gone from the canvas (${report.goneBoxes.slice(0, 6).join(", ")}) — the arrows that touched them were hidden. Redraw to remove them for good.`,
      );
    }
    if (report.pinned.length) {
      // Not a problem — a person decided those read better where they are. Said
      // out loud so nobody wonders why they did not move.
      ctx.warn(
        `"${frame.name}": ${report.pinned.length} arrow(s) were moved by hand and left alone (${report.pinned.slice(0, 6).join(", ")}). They no longer follow their boxes. Pass force:true to re-route them from scratch.`,
      );
    }
    if (report.missing.length) {
      ctx.warn(
        `"${frame.name}": no arrow layer for ${report.missing.slice(0, 6).join(", ")} — those layers were renamed or deleted, so they were left alone.`,
      );
    }
    if ("relaned" in report && report.relaned.length) {
      // Deliberately a report, not a rewrite: whether the process really
      // changed hands is the spec author's call, not the router's.
      const moves = report.relaned
        .map((r) => `"${r.id}" ${r.from} → ${r.to ?? "outside every lane"}`)
        .join(", ");
      ctx.warn(
        `"${frame.name}": ${moves}. The stored process still says the old lane — call figma_diagram again with the lane updated if the owner really changed.`,
      );
    }
  }

  return { frames: reports };
}

/**
 * The diagram frame that owns this node — the node itself, or an ancestor.
 *
 * `hasDiagramMarker`, not a hand-written marker list: this function used to
 * test FLOW_MARKER and ACTIVITY_MARKER only, so pointing this op at an ERD, a
 * sequence, a state machine, a use case diagram, a journey or a sitemap frame
 * was refused as "not part of a diagram drawn by figma_diagram" — on a frame
 * one of these tools had just drawn.
 *
 * The MARKER and not the routing graph, deliberately: a frame drawn by an
 * older build carries a marker and no graph, and the right answer for it is
 * the "redraw it to enable re-routing" warning below, not an error saying it
 * is not a diagram. Asking `isDiagramFrame` here (which needs a graph) turned
 * that warning into a refusal.
 */
function owningMarkedFrame(node: BaseNode): FrameNode | null {
  let cur: BaseNode | null = node;
  for (let hop = 0; cur && hop < 4; hop++) {
    if (cur.type === "FRAME" && hasDiagramMarker(cur)) return cur as FrameNode;
    cur = cur.parent;
  }
  return null;
}
