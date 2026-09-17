/**
 * State machine: what an entity CAN be, and what moves it.
 *
 * The other kinds answer "what does the user see" (userflow), "who does this
 * step" (activity), "what do we store" (erd) and "what is sent" (sequence).
 * This one answers the question a status column always raises and nobody ever
 * writes down: which values are legal, which change is allowed from which, who
 * or what triggers it, and under what condition. That is the artefact a
 * developer needs to write the guard clause and a tester needs to know which
 * transitions to try — and the one a spec almost always leaves implicit.
 */
import type { DrawEdge, FlowClass, Placement, DrawFrameExtras } from "../diagram/types.js";
import type { Port, Side } from "../diagram/connector.js";

/**
 * Shape of a node.
 *  - `state`   a value the entity rests in, drawn as a rounded box
 *  - `initial` where the lifecycle begins: a filled dot, one per machine
 *  - `final`   where it ends: a ring. A machine may have several
 *  - `choice`  a branch taken on a condition, drawn as a diamond
 *  - `fork`/`join` split into concurrent regions / wait for them to rejoin
 */
export type StateKind = "state" | "initial" | "final" | "choice" | "fork" | "join";

export interface StateNodeSpec {
  id: string;
  /** The state's name — the value a reader would see in the data: "Đã ký". */
  label?: string;
  kind?: StateKind;
  /** Run once on the way IN. UML's `entry /`. */
  entry?: string;
  /** Run for as long as the entity stays here. UML's `do /`. */
  do?: string;
  /** Run once on the way OUT. UML's `exit /`. */
  exit?: string;
  /** Anything else a reader needs: the stored value, who can see it. */
  detail?: string;
  cls?: FlowClass;
}

export interface TransitionSpec {
  from: string;
  to: string;
  /**
   * What triggers it — the event, not the outcome: "Gửi duyệt", "hết 30
   * ngày", "webhook payment.succeeded". A transition with no event fires as
   * soon as the source state's `do` finishes (UML's completion transition),
   * which is the only case where leaving it out means something.
   */
  event?: string;
  /** The condition that must hold for it to fire, drawn `[in brackets]`. */
  guard?: string;
  /** What the system does on the way through, drawn after a `/`. */
  action?: string;
  /**
   * Where along its face this arrow leaves / arrives, 0..1 (0.5 = the middle).
   * Use it to pull two arrows apart that the automatic spread left crossing.
   */
  fromAt?: number;
  toAt?: number;
  /** The face to attach to, when a position along the natural face is not
   *  enough: "top" | "right" | "bottom" | "left". */
  fromSide?: Side;
  toSide?: Side;
  /** Colour by meaning: `error` for a failure or cancellation path. */
  cls?: FlowClass;
  /** `return` = a way back (reopen, retry, revert): dashed, routed outside. */
  kind?: "forward" | "return";
}

export interface StateOptions {
  /** `LR` (default) reads left→right; `TB` runs the lifecycle downwards. */
  rankdir?: "TB" | "LR";
  font?: string;
  /**
   * Business rules with a value, referenced from labels as `@name` and filled
   * in when the diagram is drawn. The reference is kept in the stored model,
   * so the page can be asked which frames depend on the rule.
   */
  policies?: Record<string, string | number>;
  /** Colour the arrow by the class of the state it points at. Default true. */
  colorByTarget?: boolean;
  /** Keep the arrows attached when a state is dragged. Default true. */
  liveRoute?: boolean;
  /** Check the machine and report, draw nothing. */
  dryRun?: boolean;
}

export interface StateSpec {
  /** The compact line form — use this OR `states`/`transitions`. */
  text?: string;
  title: string;
  subtitle?: string;
  parentId?: string;
  x?: number;
  y?: number;
  states?: StateNodeSpec[];
  transitions?: TransitionSpec[];
  options?: StateOptions;
}

// ---- draw data (what crosses the bridge to the plugin) ----

export interface DrawState {
  id: string;
  /** Layer name: `state:<id> · <name>`, the handle a reflow finds it by. */
  name: string;
  kind: StateKind;
  at: Placement;
  fill: string;
  stroke: string;
  strokeWeight: number;
  radius: number;
  title: string;
  /**
   * The `entry / do / exit` compartment, already formatted one per line. Drawn
   * under a separator rule, which is what makes a UML state read as a state
   * rather than as an activity step.
   */
  body: string[];
  /** y of that separator rule inside the box; absent when there is no body. */
  ruleY?: number;
  /** Text drawn OUTSIDE the shape (a dot, a ring, a diamond, a bar). */
  outside?: { at: Placement; align: "CENTER" | "LEFT" };
  /** The inner filled dot of a final ring, in frame coordinates. */
  inner?: Placement;
}

export interface StateDraw extends DrawFrameExtras {
  name: string;
  title: string;
  subtitle: string;
  x: number;
  y: number;
  w: number;
  h: number;
  parentId?: string;
  states: DrawState[];
  edges: DrawEdge[];
  font: string;
  /** Stored on the frame so a later drag can re-route without a redraw. */
  graph?: StateGraph;
}

/** What a drawn state frame remembers, so it can re-route itself. */
export interface StateGraph {
  kind: "state";
  rankdir: "TB" | "LR";
  colorByTarget: boolean;
  liveRoute: boolean;
  nodes: Array<{ id: string; kind: StateKind; cls: FlowClass; at: Placement }>;
  edges: Array<{
    from: string;
    to: string;
    kind: "forward" | "return";
    labelLines: string[];
    lw: number;
    lh: number;
    fromAt?: number;
    toAt?: number;
    /** A full connection point, from the spec or adopted from a drag. */
    fromPort?: Port;
    toPort?: Port;
    portsByHand?: boolean;
  }>;
}

export interface StateBuild {
  draw: StateDraw;
  /**
   * The merged, checked model this build came from — the same facts
   * whether they arrived as `text` or as the arrays, and with nothing
   * about WHERE the frame goes. This is what the frame stores and what
   * a patch addresses.
   */
  model: StateSpec;
  warnings: string[];
  stats: {
    states: number;
    transitions: number;
    finals: number;
    selfTransitions: number;
    w: number;
    h: number;
  };
}
