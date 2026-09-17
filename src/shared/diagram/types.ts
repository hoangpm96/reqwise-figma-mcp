/**
 * The vocabulary every diagram in this repo shares: the semantic colour class,
 * a box's footprint, and the drawn-edge payload that crosses the bridge to the
 * plugin. Per-diagram specs (a userflow's screens, an activity's lanes) live
 * next to their own layout.
 */

/** Semantic class → palette (mirrors the mermaid classDef convention). */
export type FlowClass = "happy" | "error" | "edge" | "plain" | "decision";

/** A box's footprint, in the coordinate space of the frame that holds it. */
export interface Placement {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A label pill drawn on an edge. */
export interface DrawLabel {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  muted: boolean;
}

export interface DrawEdge {
  /** Layer handle: `from->to`, which is how a reflow finds the line again. */
  id: string;
  /**
   * The whole polyline in frame coordinates, ending ON the target's face. The
   * arrow head is a CAP on the last point, not a separate shape, so an edge is
   * one layer — which is what lets a person drag its end and have the head
   * come along.
   */
  points: Array<[number, number]>;
  color: string;
  dashed: boolean;
  label?: DrawLabel;
}

/**
 * Frame-level plumbing every diagram kind carries and none of them interpret.
 *
 * Both fields exist so a drawing can be CHANGED instead of re-authored: the
 * frame stores the model it was made from, and a later draw can be pointed
 * back at that same frame.
 */
export interface DrawFrameExtras {
  /**
   * The model this drawing was made from, written into the frame's marker.
   * Without it the frame remembers its routing graph but not what it was asked
   * to draw, so the only way to change one field is to re-send the whole spec.
   */
  source?: unknown;
  /**
   * Redraw into THIS frame instead of creating one. The frame keeps its id, so
   * Figma comments, prototype links and wherever the user dragged it survive.
   */
  intoFrameId?: string;
}
