/// <reference types="@figma/plugin-typings" />
/**
 * The part that makes a drawn diagram behave like a FigJam board: drag or
 * resize a box and every arrow touching it re-routes, live. Works for every
 * diagram kind — the dispatcher in ./diagram-reflow.ts picks the router.
 *
 * Figma Design has no connector node (`figma.createConnector()` is FigJam
 * only), so "the line follows the box" cannot be a property of the line — it
 * has to be a reaction to the document changing. `PageNode.on("nodechange")`
 * is that reaction, and it works under `documentAccess: "dynamic-page"`
 * without `loadAllPagesAsync()` because it is scoped to one page.
 *
 * Two properties of this listener matter:
 *  - The re-route is ASYNC (the arrow head is a cap in the vector network, and
 *    that is an async write), so our own writes DO come back as further
 *    changes. What stops the loop is that a second pass finds every box still
 *    where it was and does nothing — plus a queue, so a batch arriving mid-write
 *    is answered afterwards instead of being dropped.
 *  - It only runs while the plugin is open. A diagram edited with the plugin
 *    closed is put right by the `reflow_diagram` op.
 */
import {
  diagramFrames,
  isDiagramFrame,
  liveRouteOn,
  owningDiagram,
  reflowAnyFrame,
} from "./diagram-reflow.js";

/** Properties that can move an arrow's endpoints. */
const GEOMETRY: string[] = ["x", "y", "width", "height", "relativeTransform", "parent"];

let watched: PageNode | null = null;
/** Frames waiting for a re-route, by id, so a burst collapses into one pass. */
const queue = new Map<string, FrameNode>();
let running = false;
/**
 * Nested count of "a diagram is being written right now".
 *
 * The listener above reacts to our OWN writes — that is unavoidable, since a
 * re-route is itself a write — and it survives them because a second pass
 * finds every box where it was and does nothing. That idempotence is the whole
 * safety argument, and it stops being true while a frame is half-populated: a
 * diagram's lines are appended before its boxes so they sit under them, so
 * there is a window where the lines are there and the boxes are not. A pass
 * landing in it used to conclude every box had been deleted.
 *
 * `scanBoxes` makes that conclusion harmless. This closes the window itself,
 * so the pass does not happen at all — and because changes are still QUEUED
 * while paused, a person dragging a box during a draw still gets their
 * re-route, one moment later.
 */
let paused = 0;

export function installDiagramLive(): void {
  attach(figma.currentPage);
  figma.on("currentpagechange", () => attach(figma.currentPage));
}

function attach(page: PageNode): void {
  if (watched === page) return;
  if (watched) {
    try {
      watched.off("nodechange", onNodeChange);
    } catch {
      // The old page may be gone; nothing to detach from.
    }
  }
  watched = page;
  try {
    page.on("nodechange", onNodeChange);
  } catch {
    // Older API surface: live routing is simply unavailable, and the
    // reflow_diagram op still does the job on demand.
    watched = null;
  }
}

/**
 * Hold the live pass while a handler rewrites a diagram, and let it go after.
 * Nested because a `batch` can run several draws inside one dispatch, and
 * counted rather than boolean so the inner one cannot release the outer.
 */
export function pauseLive(): void {
  paused++;
}

export function resumeLive(): void {
  paused = paused > 0 ? paused - 1 : 0;
  if (!paused) void drain();
}

/** For tests and diagnostics: is a draw in progress? */
export function liveIsPaused(): boolean {
  return paused > 0;
}

function onNodeChange(event: NodeChangeEvent): void {
  const frames = new Map<string, FrameNode>();
  let sweptForDeletes = false;
  for (const change of event.nodeChanges) {
    if (change.type === "PROPERTY_CHANGE" && !touchesGeometry(change.properties)) continue;
    if (change.type === "CREATE") continue;
    const node = change.type === "DELETE" ? null : (change.node as BaseNode);
    // A change to the flow FRAME itself (moving the whole diagram, renaming
    // it) cannot move an arrow relative to its boxes — only its descendants
    // can. Deletes are followed up from the frame side instead, because the
    // deleted node's parent is already gone.
    const frame =
      node && node.type === "FRAME" && isDiagramFrame(node) ? null : owningDiagram(node);
    if (frame) frames.set(frame.id, frame);
    // A deleted node arrives with no parent to walk up from, so every
    // userflow on the page is re-checked; each one hides the arrows whose
    // box has gone.
    if (change.type === "DELETE" && !sweptForDeletes) {
      sweptForDeletes = true;
      for (const f of diagramFrames(figma.currentPage)) frames.set(f.id, f);
    }
  }
  if (!frames.size) return;
  frames.forEach((frame) => queue.set(frame.id, frame));
  void drain();
}

/**
 * Work the queue until it is empty. Our own writes arrive back here as another
 * batch; that pass finds nothing moved and writes nothing, so it settles.
 *
 * A draw in progress holds it: the queue keeps filling, nothing is routed, and
 * `resumeLive` drains it once the frame is whole. Nothing is dropped, so a
 * drag that happened during a draw is still answered.
 */
async function drain(): Promise<void> {
  if (running || paused) return;
  running = true;
  try {
    while (queue.size && !paused) {
      const batch = Array.from(queue.values());
      queue.clear();
      for (const frame of batch) {
        try {
          if (frame.removed) continue;
          if (!liveRouteOn(frame)) continue;
          await reflowAnyFrame(frame, { onlyIfMoved: true });
        } catch {
          // A live re-route must never take the plugin (and with it the bridge)
          // down. The op path reports failures properly.
        }
      }
    }
  } finally {
    running = false;
  }
}

function touchesGeometry(properties: readonly string[]): boolean {
  for (const p of properties) if (GEOMETRY.indexOf(p) >= 0) return true;
  return false;
}
