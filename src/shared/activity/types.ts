/**
 * Activity diagram with swimlanes: the agent hands over the STEPS of a
 * business process, each one assigned to the lane (role, team, system) that
 * performs it; this module lays the lanes out, places the steps in them and
 * routes the arrows between them.
 *
 * The lane is the point. A userflow answers "what does the user see next"; a
 * swimlane activity answers "who does this, and what gets handed over" — the
 * handoffs between lanes are where real processes break, and drawing them is
 * how a reader sees the handoff at all.
 */
import type { DrawEdge, FlowClass, Placement, DrawFrameExtras } from "../diagram/types.js";
import type { Port, Side } from "../diagram/connector.js";

/**
 * Shape of a step.
 *  - `action`   a step somebody performs
 *  - `decision` a question, drawn as a diamond, needs ≥2 labelled branches
 *  - `start`/`end` where the process begins and ends
 *  - `fork`/`join` split into parallel work / wait for it to rejoin
 *  - `event`    something that happens TO the process (a timer, a message)
 *  - `external` a step outside the boundary (another company, a legacy system)
 */
export type ActivityKind =
  | "action"
  | "decision"
  | "start"
  | "end"
  | "fork"
  | "join"
  | "event"
  | "external";

export interface LaneSpec {
  id: string;
  /** Role / team / system that owns every step in this lane. */
  label: string;
  /** Second line under the lane name, e.g. the system behind the role. */
  detail?: string;
}

export interface ActivityNodeSpec {
  id: string;
  /** First line is the title; `\n` starts the detail. */
  label: string;
  detail?: string;
  /**
   * Which lane performs this step. Required as soon as the diagram HAS lanes —
   * an activity with unassigned steps is exactly the drawing this tool exists
   * to prevent. Omit it (on every step) for a plain activity diagram with no
   * swimlanes at all.
   */
  lane?: string;
  kind?: ActivityKind;
  cls?: FlowClass;
}

export interface ActivityEdgeSpec {
  from: string;
  to: string;
  /**
   * Where along its face this arrow leaves / arrives, 0..1 (0.5 = the middle).
   * For the default LR the faces are vertical, so 0 is the top of the box and
   * 1 the bottom; for TB they are horizontal, so 0 is the left. Use it to pull
   * two arrows apart that the automatic spread left crossing. Ignored on a
   * decision diamond, whose only sensible attach point is its tip.
   */
  fromAt?: number;
  toAt?: number;
  /**
   * The face to attach to, when a position along the natural face is not
   * enough: "top" | "right" | "bottom" | "left". With a side the edge is drawn
   * by the generic connector, leaving that face and arriving at the other —
   * the same thing that happens when somebody drags the arrow's end there.
   */
  fromSide?: Side;
  toSide?: Side;
  /** On a decision branch this is the condition; on a handoff, WHAT is handed
   *  over ("approved PO", "rejection reason"). */
  label?: string;
  /** `return` = send-back / rework / retry: dashed, routed outside the lanes. */
  kind?: "forward" | "return";
}

export interface ActivityOptions {
  /**
   * `LR` (default) runs the process left→right with HORIZONTAL lanes — the
   * classic swimlane. `TB` runs it top→bottom with vertical lanes.
   */
  rankdir?: "TB" | "LR";
  font?: string;
  /**
   * Business rules with a value, referenced from labels as `@name` and filled
   * in when the diagram is drawn. The reference is kept in the stored model,
   * so the page can be asked which frames depend on the rule.
   */
  policies?: Record<string, string | number>;
  /** Colour the arrow by the class of the step it points at. Default true. */
  colorByTarget?: boolean;
  /** Keep the arrows attached when a step is dragged. Default true. */
  liveRoute?: boolean;
  /** Check the process and report, draw nothing. */
  dryRun?: boolean;
}

export interface ActivitySpec {
  /**
   * The compact line form of the model — use this OR the arrays below. Costs
   * roughly a third of the tokens; the parser reports any line it cannot read
   * rather than dropping it.
   */
  text?: string;
  title: string;
  subtitle?: string;
  parentId?: string;
  x?: number;
  y?: number;
  /**
   * The owners, in drawing order. Omit for a plain activity diagram with no
   * swimlanes; pass the ids only on the nodes and the bands are derived from
   * them, in the order they first appear.
   */
  lanes?: LaneSpec[];
  nodes?: ActivityNodeSpec[];
  edges?: ActivityEdgeSpec[];
  options?: ActivityOptions;
}

// ---- draw data (what crosses the bridge to the plugin) ----

export interface DrawLane {
  id: string;
  label: string;
  detail?: string;
  /** The band, in frame coordinates. */
  at: Placement;
  /** The label strip at the band's start. */
  header: Placement;
  fill: string;
  headerFill: string;
  stroke: string;
}

export interface DrawStep {
  id: string;
  /** Layer name: `step:<id> · <title>`, the handle a reflow finds it by. */
  name: string;
  kind: ActivityKind;
  at: Placement;
  fill: string;
  stroke: string;
  strokeWeight: number;
  /** Dashed outline: a step outside the process boundary. */
  dashed: boolean;
  /** Corner radius; a pill is h/2, an action 10. */
  radius: number;
  title: string;
  detail?: string;
  /** Text drawn OUTSIDE the shape (a diamond, a fork bar) rather than inside. */
  outside?: { at: Placement; align: "CENTER" | "LEFT" };
  /** White text on a filled start marker. */
  invert: boolean;
}

export interface ActivityDraw extends DrawFrameExtras {
  name: string;
  title: string;
  subtitle: string;
  x: number;
  y: number;
  w: number;
  h: number;
  parentId?: string;
  lanes: DrawLane[];
  steps: DrawStep[];
  edges: DrawEdge[];
  font: string;
  /** Stored on the frame so a later drag can re-route without a redraw. */
  graph?: ActivityGraph;
}

/** What a drawn activity frame remembers, so it can re-route itself. */
export interface ActivityGraph {
  kind: "activity";
  rankdir: "TB" | "LR";
  colorByTarget: boolean;
  liveRoute: boolean;
  lanes: Array<{ id: string; at: Placement }>;
  nodes: Array<{ id: string; kind: ActivityKind; cls: FlowClass; lane: string; at: Placement }>;
  edges: Array<{
    from: string;
    to: string;
    kind: "forward" | "return";
    labelLines: string[];
    lw: number;
    lh: number;
    /** The caller's connection-point wish, 0..1 along the natural face. */
    fromAt?: number;
    toAt?: number;
    /**
     * A full connection point — which face, and where along it. Set by the
     * spec, or adopted from an arrow somebody dragged onto another face.
     */
    fromPort?: Port;
    toPort?: Port;
    /** True when those ports came from a drag, not from the spec. */
    portsByHand?: boolean;
  }>;
}

export interface ActivityBuild {
  draw: ActivityDraw;
  /**
   * The merged, checked model this build came from — the same facts
   * whether they arrived as `text` or as the arrays, and with nothing
   * about WHERE the frame goes. This is what the frame stores and what
   * a patch addresses.
   */
  model: ActivitySpec;
  warnings: string[];
  stats: {
    lanes: number;
    nodes: number;
    edges: number;
    handoffs: number;
    returnEdges: number;
    w: number;
    h: number;
  };
}
