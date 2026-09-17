/**
 * Sequence diagram: who talks to whom, in what order.
 *
 * The other diagrams answer "what does the user see", "who does this step" and
 * "what do we store". This one answers the question that only shows up when
 * systems have to agree: WHAT is sent, in which order, and what comes back —
 * which is where an integration spec is usually vague and an implementation is
 * usually wrong.
 */
import type { FlowClass, Placement, DrawFrameExtras } from "../diagram/types.js";

/** What a participant is, which decides how its head is drawn. */
export type ParticipantKind = "actor" | "system" | "external" | "queue" | "db";

/** How a message is drawn: a call, a fire-and-forget, or a reply. */
export type MessageKind = "sync" | "async" | "return";

export interface SeqParticipantSpec {
  id: string;
  /** The name a reader knows it by: "Khách hàng", "Payment gateway". */
  name: string;
  /** Second line: the service, the team, the protocol. */
  detail?: string;
  kind?: ParticipantKind;
  cls?: FlowClass;
}

export interface SeqMessageSpec {
  /** Referenced by fragments; also what a finding names. */
  id: string;
  from: string;
  to: string;
  /** What is actually sent — a call with its arguments, an event, a payload. */
  label: string;
  /** `sync` a call that waits · `async` fire-and-forget · `return` the reply. */
  kind?: MessageKind;
  /** Something the reader has to know that is not in the label. */
  note?: string;
  /** Colour by meaning: `error` for the failure path, `edge` for a rare one. */
  cls?: FlowClass;
}

/**
 * A block around a run of messages: the conditional, the loop, the parallel
 * work. `messages` must be a contiguous run in time order — a fragment that
 * skips a message in the middle is not a thing a sequence diagram can draw,
 * and saying so is more useful than drawing a lie.
 */
export interface SeqFragmentSpec {
  kind: "alt" | "opt" | "loop" | "par" | "break";
  /** The condition, the iteration, the reason: "OTP đúng", "mỗi 30 giây". */
  label: string;
  messages: string[];
  /** The `else` half of an `alt`. */
  else?: { label?: string; messages: string[] };
}

export interface SeqOptions {
  font?: string;
  /**
   * Business rules with a value, referenced from labels as `@name` and filled
   * in when the diagram is drawn. The reference is kept in the stored model,
   * so the page can be asked which frames depend on the rule.
   */
  policies?: Record<string, string | number>;
  /** Keep the arrows attached when a participant is dragged. Default true. */
  liveRoute?: boolean;
  /** Check the exchange and report, draw nothing. */
  dryRun?: boolean;
}

export interface SequenceSpec {
  /**
   * The compact, mermaid-shaped form of participants+messages+fragments — use
   * this OR the arrays. Costs ~a third of the tokens and generates the message
   * ids, so fragments are written as blocks instead of id-lists.
   */
  text?: string;
  title: string;
  subtitle?: string;
  parentId?: string;
  x?: number;
  y?: number;
  participants?: SeqParticipantSpec[];
  messages?: SeqMessageSpec[];
  fragments?: SeqFragmentSpec[];
  options?: SeqOptions;
}

// ---- draw data ----

export interface DrawParticipant {
  id: string;
  /** Layer name: `party:<id> · <name>`, the handle a reflow finds it by. */
  name: string;
  title: string;
  detail?: string;
  at: Placement;
  fill: string;
  stroke: string;
  dashed: boolean;
  /** Centre of the head — where the lifeline hangs from. */
  lifelineX: number;
  /** The dashed line under the head: from its bottom to the diagram's end. */
  lifeline: { x: number; y: number; h: number };
}

export interface DrawActivation {
  id: string;
  participant: string;
  at: Placement;
}

export interface DrawMessage {
  id: string;
  /** Polyline in frame coordinates; a self-message is a three-sided hop. */
  points: Array<[number, number]>;
  color: string;
  dashed: boolean;
  /** `filled` a call · `line` an async or a reply. */
  cap: "filled" | "line";
  label: { x: number; y: number; w: number; h: number; text: string; muted: boolean };
  note?: { x: number; y: number; w: number; h: number; text: string };
}

export interface DrawFragment {
  id: string;
  /** "alt" / "loop" / … — drawn in the corner tab. */
  kind: string;
  label: string;
  at: Placement;
  /** Width of the corner tab, so the plugin does not re-measure it. */
  tabW: number;
  tabH: number;
  /** The `else` divider: a dashed line across the box, with its own label. */
  divider?: { y: number; label: string };
}

export interface SequenceDraw extends DrawFrameExtras {
  name: string;
  title: string;
  subtitle: string;
  x: number;
  y: number;
  w: number;
  h: number;
  parentId?: string;
  participants: DrawParticipant[];
  activations: DrawActivation[];
  messages: DrawMessage[];
  fragments: DrawFragment[];
  font: string;
  graph?: SequenceGraph;
}

/** What a drawn sequence frame remembers, so it can re-place itself. */
export interface SequenceGraph {
  kind: "sequence";
  liveRoute: boolean;
  /** Where the layout put each head, and how far its lifeline reached. */
  participants: Array<{ id: string; at: Placement; lifelineH: number }>;
  messages: Array<{
    id: string;
    from: string;
    to: string;
    kind: MessageKind;
    cls: FlowClass;
    /** Time position: the row this message sits on, in frame coordinates. */
    y: number;
    labelLines: string[];
    lw: number;
    lh: number;
    noteLines: string[];
    nw: number;
    nh: number;
  }>;
  activations: Array<{ id: string; participant: string; y: number; h: number; depth: number }>;
  fragments: Array<{
    id: string;
    kind: string;
    label: string;
    /** Participants the block spans, and the rows it covers. */
    parties: string[];
    top: number;
    bottom: number;
    tabW: number;
    tabH: number;
    divider?: { y: number; label: string };
  }>;
}

export interface SequenceBuild {
  draw: SequenceDraw;
  /**
   * The merged, checked model this build came from — the same facts
   * whether they arrived as `text` or as the arrays, and with nothing
   * about WHERE the frame goes. This is what the frame stores and what
   * a patch addresses.
   */
  model: SequenceSpec;
  warnings: string[];
  stats: {
    participants: number;
    messages: number;
    returns: number;
    fragments: number;
    w: number;
    h: number;
  };
}
