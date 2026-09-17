/**
 * Userflow: the agent hands over a graph it derived from the business spec
 * (screens, happy path, error cases, edge cases); this module lays it out and
 * emits pure draw data. The tool is the draughtsman and the proof-reader —
 * never the thinker: it must not invent nodes, merge branches or guess labels.
 */

import type { RouteGraph } from "./route.js";
import type { Side } from "../diagram/connector.js";
import type { DrawEdge, DrawFrameExtras, FlowClass } from "../diagram/types.js";

export type { DrawEdge, DrawLabel, FlowClass, Placement } from "../diagram/types.js";

/** Shape of a node. `terminal`/`external` are legitimate dead ends. */
export type FlowKind = "screen" | "state" | "decision" | "external" | "terminal";

export interface FlowNodeSpec {
  id: string;
  /** First line is the title; `\n` (or mermaid `<br/>`) starts the detail. */
  label: string;
  detail?: string;
  kind?: FlowKind;
  cls?: FlowClass;
  /** Stable id of the artboard this screen maps to — the back-reference. */
  screenId?: string;
  /** Human-readable short name printed under the title. */
  slug?: string;
}

export interface FlowEdgeSpec {
  from: string;
  to: string;
  label?: string;
  /** `return` = mermaid `-.->`: go-back / cancel / retry. Routed in a gutter. */
  kind?: "forward" | "return";
  /**
   * Where along its face this arrow leaves / arrives, 0..1 (0.5 = the middle).
   * The router spreads ports evenly and has no idea which one reads best;
   * these say so explicitly, and unlike a hand edit they keep following the
   * boxes. For the default TB the faces are horizontal, so 0 is the left edge
   * of the box and 1 the right. Ignored on a decision diamond, whose only
   * sensible attach point is its tip.
   */
  fromAt?: number;
  toAt?: number;
  /**
   * The face to attach to, when the position along the natural face is not
   * enough: "top" | "right" | "bottom" | "left". With a side, the edge is
   * drawn by the generic connector — it leaves that face and arrives at the
   * other one — instead of by the rank-aware routing.
   */
  fromSide?: Side;
  toSide?: Side;
}

export interface UserflowOptions {
  rankdir?: "TB" | "LR";
  /**
   * Font family for every label. Defaults to Inter, which the text metrics are
   * calibrated for — and which has no CJK/Hangul glyphs, so a Korean or
   * Japanese flow needs a family that covers them (e.g. "Noto Sans KR").
   */
  font?: string;
  /**
   * Business rules with a value, referenced from labels as `@name` and filled
   * in when the diagram is drawn. The reference is kept in the stored model,
   * so the page can be asked which frames depend on the rule.
   */
  policies?: Record<string, string | number>;
  /** Colour the arrow by the class of the node it points at. Default true. */
  colorByTarget?: boolean;
  /** Wire ON_CLICK → NAVIGATE from each screen box to its artboard. */
  linkScreens?: boolean;
  /** Check the graph and report, draw nothing. */
  dryRun?: boolean;
  /**
   * Keep the arrows attached to the boxes: while the plugin is open, dragging
   * or resizing a box re-routes every line touching it. Default true. Set
   * false for a frame that should keep the arrows exactly as first drawn.
   */
  liveRoute?: boolean;
}

export interface UserflowSpec {
  title: string;
  subtitle?: string;
  parentId?: string;
  x?: number;
  y?: number;
  nodes?: FlowNodeSpec[];
  edges?: FlowEdgeSpec[];
  /** Mermaid `flowchart TD` source, used INSTEAD of nodes+edges. */
  mermaid?: string;
  options?: UserflowOptions;
}

// ---- resolved graph (after parsing + defaulting) ----

export interface FlowNode extends FlowNodeSpec {
  kind: FlowKind;
  cls: FlowClass;
  /** Wrapped title lines. */
  titleLines: string[];
  /** Wrapped detail lines. */
  detailLines: string[];
  w: number;
  h: number;
  x: number;
  y: number;
}

export interface FlowEdge extends FlowEdgeSpec {
  kind: "forward" | "return";
  labelLines: string[];
  lw: number;
  lh: number;
}

// ---- draw data (what crosses the bridge to the plugin) ----

export interface DrawBox {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
  stroke: string;
  title: string;
  /** Printed under the title: "screenId · slug" — the same string the artboard
   *  is named with, so a reader can match box to artboard at a glance. */
  ref?: string;
  detail?: string;
  screenId?: string;
}

export interface DrawDiamond {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
  stroke: string;
  text: string;
  textW: number;
  textH: number;
}

export interface DrawData extends DrawFrameExtras {
  name: string;
  title: string;
  subtitle: string;
  x: number;
  y: number;
  w: number;
  h: number;
  parentId?: string;
  boxes: DrawBox[];
  diamonds: DrawDiamond[];
  edges: DrawEdge[];
  /** screenId → box node key, for linkScreens. */
  linkScreens: boolean;
  /** Font family every label is drawn with. */
  font: string;
  /** Stored on the frame so a later drag can re-route without a redraw. */
  graph?: RouteGraph;
}

export interface UserflowBuild {
  draw: DrawData;
  /**
   * The merged, checked model this build came from — the same facts whether
   * they arrived as `mermaid` or as the arrays, and with nothing about WHERE
   * the frame goes. This is what the frame stores and what a patch addresses.
   */
  model: UserflowSpec;
  warnings: string[];
  stats: { nodes: number; edges: number; returnEdges: number; w: number; h: number };
}
