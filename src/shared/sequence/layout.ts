/**
 * Layout for a sequence diagram — the one kind that needs no graph layout at
 * all. A participant is a COLUMN and a message is a ROW: the order the caller
 * wrote the messages in IS the time order, so the only real work is deciding
 * how wide each column gap has to be for the labels that cross it, and where
 * the activation bars and fragment boxes fall.
 *
 * That determinism is also what makes the live re-place exact: dragging a
 * participant moves a column, and everything on that column follows.
 */
import { r2, type Pt } from "../diagram/geometry.js";
import { headerHeight, lineHeight, textWidth, wrapText } from "../diagram/metrics.js";
import { pairCalls, type PairedCall } from "./pairing.js";
import { DEFAULT_FONT, ERROR_RED, EDGE_AMBER, INK, PALETTE } from "../diagram/palette.js";
import type { FlowClass, Placement } from "../diagram/types.js";
import type {
  DrawActivation,
  DrawFragment,
  DrawMessage,
  DrawParticipant,
  MessageKind,
  ParticipantKind,
  SeqFragmentSpec,
  SeqMessageSpec,
  SeqOptions,
  SeqParticipantSpec,
  SequenceDraw,
  SequenceGraph,
} from "./types.js";

const PAD = 40;
const HEADER = 96;
/** Vertical distance between two consecutive messages. */
const ROW = 46;
/** Clearance under a label so a tall one pushes its own row down, not up. */
const LABEL_ROOM = 12;
/** A self-message needs room for its hop. */
const SELF_ROW = 62;
/** Space between the head and the first message. */
const FIRST_ROW = 44;
/** Lifeline left hanging below the last message. */
const TAIL = 40;
const HEAD_H = 52;
const HEAD_H_DETAIL = 66;
const HEAD_MIN_W = 132;
const GAP_MIN = 88;
/** Width of an activation bar. */
const BAR_W = 10;
/** How far a self-message reaches out. */
const SELF_OUT = 46;
/** Room a fragment box claims around the messages it holds. */
const FRAG_TOP = 30;
const FRAG_BOTTOM = 16;
const FRAG_SIDE = 34;
/** How far a nested fragment box steps in from each side per level. */
const NEST_INSET = 8;
/** The least a nested box steps in per level once its tab no longer fits. */
const NEST_MIN_STEP = 2;
/** No box, however deep, gets narrower than this. */
const NEST_MIN_W = 12;
/** Narrowest a nested box is stepped in to, whatever its tab says. */
const FRAG_MIN_W = 48;

const LIFELINE = "#aeb6c2";
const FRAG_STROKE = "#94a3b8";

interface Party extends SeqParticipantSpec {
  kind: ParticipantKind;
  cls: FlowClass;
  w: number;
  h: number;
  x: number;
  /** Lifeline centre. */
  cx: number;
}

interface Msg {
  id: string;
  from: string;
  to: string;
  kind: MessageKind;
  cls: FlowClass;
  labelLines: string[];
  lw: number;
  lh: number;
  noteLines: string[];
  nw: number;
  nh: number;
  y: number;
  self: boolean;
}

export interface SequenceLayout {
  participants: DrawParticipant[];
  activations: DrawActivation[];
  messages: DrawMessage[];
  fragments: DrawFragment[];
  graph: SequenceGraph;
  w: number;
  h: number;
  returns: number;
}

export function layoutSequence(
  participants: SeqParticipantSpec[],
  messages: SeqMessageSpec[],
  fragments: SeqFragmentSpec[],
  options: SeqOptions,
  subtitle = "",
): SequenceLayout {
  const parties: Party[] = participants.map(sizeParty);
  // One head height for all of them: lifelines that start at different heights
  // read as a mistake, and the time axis is supposed to be one line.
  const headH = parties.reduce((h, p) => Math.max(h, p.h), HEAD_H);
  for (const p of parties) p.h = headH;
  const byId = new Map<string, Party>();
  for (const p of parties) byId.set(p.id, p);

  const msgs: Msg[] = messages.map((m) => sizeMessage(m, m.from === m.to));

  placeColumns(parties, msgs, byId);
  // The columns are placed, so the frame's width is known — and the title
  // block can be MEASURED against the width its subtitle will really be
  // wrapped to, before anything is positioned under it. One line still lands
  // on 96, so no existing sequence moves; a longer one pushes the whole time
  // axis down instead of being drawn over the first participant.
  const width = Math.ceil((parties[parties.length - 1]?.x ?? 0) + (parties[parties.length - 1]?.w ?? 0) + PAD);
  const head = headerHeight(subtitle, width);
  const rows = placeRows(msgs, fragments, headH, head);
  const bars = deriveActivations(msgs, byId, fragments);
  const boxes = placeFragments(fragments, msgs, byId);

  const bottom = rows.bottom;
  const height = Math.ceil(bottom + TAIL + PAD);

  const drawParties: DrawParticipant[] = parties.map((p) => {
    const pal = PALETTE[p.cls] ?? PALETTE.plain;
    return {
      id: p.id,
      name: `party:${p.id} · ${p.name}`,
      title: p.name,
      ...(p.detail ? { detail: p.detail } : {}),
      at: { x: r2(p.x), y: head, w: p.w, h: p.h },
      fill: p.kind === "actor" ? INK : pal.fill,
      stroke: p.kind === "actor" ? INK : pal.stroke,
      dashed: p.kind === "external",
      lifelineX: r2(p.cx),
      lifeline: { x: r2(p.cx), y: head + p.h, h: r2(bottom + TAIL - (head + p.h)) },
    };
  });

  const drawMessages: DrawMessage[] = msgs.map((m) => emitMessage(m, byId));
  // A nested call is drawn stepped to the right, so two bars on one lifeline
  // read as one inside the other instead of one hiding the other.
  const drawBars: DrawActivation[] = bars.map((b) => ({
    id: b.id,
    participant: b.participant,
    at: {
      x: r2(byId.get(b.participant)!.cx - BAR_W / 2 + b.depth * (BAR_W / 2)),
      y: r2(b.y),
      w: BAR_W,
      h: r2(b.h),
    },
  }));

  const graph: SequenceGraph = {
    kind: "sequence",
    liveRoute: options.liveRoute !== false,
    participants: drawParties.map((p) => ({ id: p.id, at: p.at, lifelineH: p.lifeline.h })),
    messages: msgs.map((m) => ({
      id: m.id,
      from: m.from,
      to: m.to,
      kind: m.kind,
      cls: m.cls,
      y: r2(m.y),
      labelLines: m.labelLines,
      lw: m.lw,
      lh: m.lh,
      noteLines: m.noteLines,
      nw: m.nw,
      nh: m.nh,
    })),
    activations: bars.map((b) => ({
      id: b.id,
      participant: b.participant,
      y: r2(b.y),
      h: r2(b.h),
      depth: b.depth,
    })),
    fragments: boxes.map((f) => ({
      id: f.id,
      kind: f.kind,
      label: f.label,
      parties: f.parties,
      top: r2(f.top),
      bottom: r2(f.bottom),
      tabW: f.tabW,
      tabH: f.tabH,
      ...(f.reach ? { reach: f.reach } : {}),
      ...(f.divider ? { divider: f.divider } : {}),
    })),
  };

  return {
    participants: drawParties,
    activations: drawBars,
    messages: drawMessages,
    fragments: boxes.map((f) => emitFragment(f, byId)),
    graph,
    w: width,
    h: height,
    returns: msgs.filter((m) => m.kind === "return").length,
  };
}

// ---------------------------------------------------------------- sizing ----

function sizeParty(p: SeqParticipantSpec): Party {
  const kind = p.kind ?? "system";
  const cls: FlowClass = p.cls ?? (kind === "actor" ? "plain" : "plain");
  const name = textWidth(p.name, 13) + 28;
  const detail = p.detail ? textWidth(p.detail, 11) + 28 : 0;
  const w = Math.max(HEAD_MIN_W, name, detail);
  return {
    ...p,
    kind,
    cls,
    w,
    h: p.detail ? HEAD_H_DETAIL : HEAD_H,
    x: 0,
    cx: 0,
  };
}

function sizeMessage(m: SeqMessageSpec, self: boolean): Msg {
  const labelLines = wrapText(m.label, 34);
  let lw = 0;
  for (const l of labelLines) lw = Math.max(lw, textWidth(l, 11));
  const noteLines = m.note ? wrapText(m.note, 30) : [];
  let nw = 0;
  for (const l of noteLines) nw = Math.max(nw, textWidth(l, 10));
  return {
    id: m.id,
    from: m.from,
    to: m.to,
    kind: m.kind ?? "sync",
    cls: m.cls ?? "plain",
    labelLines,
    lw: lw + 12,
    lh: labelLines.length * lineHeight(11) + 4,
    noteLines,
    nw: noteLines.length ? nw + 16 : 0,
    nh: noteLines.length ? noteLines.length * lineHeight(11) + 10 : 0,
    y: 0,
    self,
  };
}

// --------------------------------------------------------------- columns ----

/**
 * Column gaps are decided by the LABELS that cross them: a message between two
 * neighbours has only that one gap to fit in, so the gap grows to hold it.
 * Anything spanning further has room by construction.
 */
function placeColumns(parties: Party[], msgs: Msg[], byId: Map<string, Party>): void {
  const index = new Map<string, number>();
  parties.forEach((p, i) => index.set(p.id, i));

  const gaps: number[] = new Array(Math.max(0, parties.length - 1)).fill(GAP_MIN);
  for (const m of msgs) {
    const a = index.get(m.from);
    const b = index.get(m.to);
    if (a === undefined || b === undefined) continue;
    if (m.self) {
      // A self-message hangs to the right of its own lifeline; give the next
      // gap room for the hop and the label beside it.
      const need = SELF_OUT + m.lw + 24;
      if (a < gaps.length) gaps[a] = Math.max(gaps[a]!, need);
      continue;
    }
    if (Math.abs(a - b) !== 1) continue;
    const g = Math.min(a, b);
    gaps[g] = Math.max(gaps[g]!, m.lw + 36);
  }

  let cursor = PAD;
  parties.forEach((p, i) => {
    p.x = cursor;
    p.cx = cursor + p.w / 2;
    cursor += p.w + (gaps[i] ?? 0);
  });
  void byId;
}

// ------------------------------------------------------------------ rows ----

/**
 * One row per message, in the order they were written — plus the room a
 * fragment needs above its first message and below its last.
 */
function placeRows(msgs: Msg[], fragments: SeqFragmentSpec[], headH: number, head: number): { bottom: number } {
  const opensAt = new Map<string, number>();
  const closesAt = new Map<string, number>();
  const dividerAt = new Map<string, number>();
  const byMsg = msgIndex(msgs);
  for (const f of fragments) {
    const span = fragmentSpan(f, byMsg);
    if (!span) continue;
    opensAt.set(span.first.id, (opensAt.get(span.first.id) ?? 0) + 1);
    if (span.elseFirst) dividerAt.set(span.elseFirst.id, (dividerAt.get(span.elseFirst.id) ?? 0) + 1);
    closesAt.set(span.last.id, (closesAt.get(span.last.id) ?? 0) + 1);
  }

  let y = head + headH + FIRST_ROW;
  let prevY: number | null = null;
  for (const m of msgs) {
    y += (opensAt.get(m.id) ?? 0) * fragTop(m);
    // The `else` line needs its own row, not a nudge: a divider dropped into
    // the 26px above the arrow ran straight through the message's label.
    y += (dividerAt.get(m.id) ?? 0) * dividerRoom(m);
    // A label is drawn ABOVE its own arrow, and the fixed ROW only fits two
    // lines: a three-line label reached back over the message before it.
    if (prevY !== null) y = Math.max(y, prevY + m.lh + LABEL_ROOM);
    m.y = y;
    prevY = y;
    y += m.self ? SELF_ROW : ROW;
    if (m.nh) y += m.nh + 6;
    y += (closesAt.get(m.id) ?? 0) * FRAG_BOTTOM;
  }
  return { bottom: y };
}

function msgIndex(msgs: Msg[]): Map<string, { m: Msg; at: number }> {
  const out = new Map<string, { m: Msg; at: number }>();
  msgs.forEach((m, at) => out.set(m.id, { m, at }));
  return out;
}

/**
 * The messages a fragment's box starts at, ends at, and draws its `else` line
 * above — counting only messages that are actually drawn, and in the order
 * they are drawn. placeRows reserves the bands and placeFragments draws the
 * boxes into them, so both read the span from HERE: the rows used the raw ids
 * and the boxes the drawn ones, and a fragment naming a message that is not
 * drawn (or listing its messages out of order) got its band reserved at one
 * message and its box drawn at another.
 */
function fragmentSpan(
  f: SeqFragmentSpec,
  byMsg: Map<string, { m: Msg; at: number }>,
): { held: Msg[]; first: Msg; last: Msg; elseFirst?: Msg } | null {
  const drawn = (ids: string[]) =>
    ids
      .map((id) => byMsg.get(id))
      .filter((e): e is { m: Msg; at: number } => !!e)
      .sort((a, b) => a.at - b.at);
  const els = drawn(f.else?.messages ?? []);
  const held = drawn(f.messages.concat(f.else?.messages ?? [])).map((e) => e.m);
  if (!held.length) return null;
  return {
    held,
    first: held[0]!,
    last: held[held.length - 1]!,
    ...(els.length ? { elseFirst: els[0]!.m } : {}),
  };
}

/**
 * Room above the first message in a fragment for the box's top edge and tab.
 * A two-line label is taller than the fixed 30px the first version reserved,
 * so the border was drawn straight through it.
 */
function fragTop(m: Msg): number {
  return m.self ? FRAG_TOP : Math.max(FRAG_TOP, m.lh + 22);
}

/** Room above a message for an `else` divider AND its label to clear both. */
function dividerRoom(m: Msg): number {
  return m.self ? 26 : m.lh + 30;
}

/** Where that divider sits: above the message's label, not across it. */
function dividerY(m: Msg): number {
  return m.self ? m.y - 22 : m.y - m.lh - 20;
}

// ----------------------------------------------------------- activations ----

interface Bar {
  id: string;
  participant: string;
  y: number;
  h: number;
  /** Nesting level: a call arriving while the last one is still open. */
  depth: number;
}

/**
 * A call puts the callee to work until it replies. Derived rather than
 * declared: making the caller book-keep activate/deactivate is how sequence
 * diagrams get out of step with themselves.
 *
 * The awkward case is a call nobody answers — a person tapping a button, a
 * fire-and-forget that the diagram simply does not follow. Such a bar ends at
 * the last message its participant is involved in, rather than running past
 * the end of the diagram; and a second unanswered call while the participant
 * is ALREADY working does not open another bar, because that is the same
 * stretch of work continuing, not a call inside a call. (Two bars covering
 * almost the same rows is what the first version drew.)
 *
 * It stops SHORT, though, of the participant's next answered call: a call with
 * a reply is a self-contained stretch of work, so a tap earlier in the scenario
 * is finished by the time it starts. Running to the last appearance regardless
 * drew a bar down the whole diagram and pushed every real bar under it into a
 * nested, stepped-aside position, which reads as "this tap never completed".
 */
function deriveActivations(
  msgs: Msg[],
  byId: Map<string, Party>,
  fragments: SeqFragmentSpec[],
): Bar[] {
  const yOf = new Map<string, number>();
  const lastSeen = new Map<string, number>();
  const drawn = msgs.filter((m) => byId.has(m.from) && byId.has(m.to));
  for (const m of drawn) {
    yOf.set(m.id, m.y);
    lastSeen.set(m.from, m.y);
    lastSeen.set(m.to, m.y);
  }

  // Who answers whom is decided once, in pairing.ts, and shared with the
  // checker: alternative replies in exclusive branches all belong to the same
  // call instead of closing older ones off a stack.
  const paired = pairCalls(drawn, fragments);
  const from = (c: PairedCall) => yOf.get(c.id) ?? 0;
  // A call is busy until its LAST outcome: one timeline is drawn, so the bar
  // has to cover every branch's reply, not just the first one.
  const until = (c: PairedCall): number | null => {
    let last: number | null = null;
    for (const r of c.replies) {
      const y = yOf.get(r);
      if (y !== undefined && (last === null || y > last)) last = y;
    }
    return last;
  };

  const bars: Bar[] = [];
  for (const call of paired.calls) {
    let to = until(call);
    if (to === null) {
      // Nobody answers: a person tapping a button, a fire-and-forget the
      // diagram does not follow. End it at this participant's last message,
      // but no later than its next ANSWERED call — a call with a reply is a
      // self-contained stretch of work, so the earlier tap is done by then.
      const next = paired.calls.find(
        (o) => o.replies.length > 0 && o.to === call.to && from(o) > from(call),
      );
      const ys = drawn
        .filter(
          (m) =>
            (m.from === call.to || m.to === call.to) &&
            m.y > from(call) &&
            (!next || m.y < from(next)),
        )
        .map((m) => m.y);
      to = ys.length ? ys[ys.length - 1]! : (lastSeen.get(call.to) ?? from(call));
      to += 6;

      // An unanswered call inside a stretch this participant is already
      // working through adds nothing: it is the same work, not a nested call.
      const covered = bars.some(
        (b) => b.participant === call.to && from(call) >= b.y && from(call) <= b.y + b.h,
      );
      if (covered) continue;
    }
    const y = from(call) - 6;
    const h = Math.max(to, from(call)) - from(call) + 12;
    // Nesting level: how many bars on this lifeline are still running here.
    const depth = bars.filter(
      (b) => b.participant === call.to && y > b.y && y < b.y + b.h,
    ).length;
    bars.push({ id: call.id, participant: call.to, y, h, depth });
  }
  return bars;
}

// ------------------------------------------------------------- fragments ----

interface Box {
  id: string;
  kind: string;
  label: string;
  parties: string[];
  top: number;
  bottom: number;
  left: number;
  right: number;
  tabW: number;
  tabH: number;
  divider?: { y: number; label: string };
  /** Right edge a self-message inside needs (its hop plus its label). */
  needRight: number;
  /** Extra width past the lifelines, stored so a reflow keeps it. */
  reach: number;
}

function placeFragments(
  fragments: SeqFragmentSpec[],
  msgs: Msg[],
  byId: Map<string, Party>,
): Box[] {
  const byMsg = msgIndex(msgs);
  const out: Box[] = [];

  // Which fragment sits inside which, by the messages they hold. Two fragments
  // over the SAME messages (a `loop` whose whole body is an `opt`) are nested
  // too: the one written first is the outer one, as the text parser emits them.
  const sets = fragments.map(
    (f) => new Set(f.messages.concat(f.else?.messages ?? []).filter((id) => byMsg.has(id))),
  );
  const inside = (j: number, i: number): boolean => {
    if (i === j || !sets[j]!.size) return false;
    for (const id of sets[j]!) if (!sets[i]!.has(id)) return false;
    return sets[j]!.size < sets[i]!.size || j > i;
  };

  fragments.forEach((f, i) => {
    const span = fragmentSpan(f, byMsg);
    if (!span) return;
    const { held } = span;

    const parties = new Set<string>();
    for (const m of held) {
      parties.add(m.from);
      parties.add(m.to);
    }
    const xs: number[] = [];
    for (const id of parties) {
      const p = byId.get(id);
      if (p) xs.push(p.cx);
    }
    if (!xs.length) return;

    const { first, last } = span;
    // placeRows already reserved one band above the first message for EVERY
    // fragment opening there, and one below the last for every fragment
    // closing there. Each box takes the band its nesting gives it: fragments
    // nested inside this one and sharing its first (last) message sit closer
    // in, so this one steps out past them. Without it two boxes over the same
    // messages were drawn on top of each other, identical to the pixel.
    let opensInside = 0;
    let closesInside = 0;
    for (let j = 0; j < fragments.length; j++) {
      if (!inside(j, i)) continue;
      const inner = fragmentSpan(fragments[j]!, byMsg);
      if (inner?.first.id === first.id) opensInside++;
      if (inner?.last.id === last.id) closesInside++;
    }
    const elseFirst = span.elseFirst;
    const label = `${f.kind} · ${f.label}`;
    // A self-message hangs to the right of its lifeline with its label beyond
    // the hop; a box sized from the lifelines alone cut through both.
    let needRight = -Infinity;
    for (const m of held) {
      if (!m.self) continue;
      const cx = byId.get(m.from)?.cx;
      if (cx !== undefined) needRight = Math.max(needRight, cx + SELF_OUT + 10 + m.lw + 12);
    }
    out.push({
      id: `frag${i}`,
      kind: f.kind,
      label: f.label,
      parties: Array.from(parties),
      top: first.y - (1 + opensInside) * fragTop(first) + 6,
      bottom:
        last.y +
        (last.self ? SELF_ROW : ROW) -
        10 +
        (last.nh ? last.nh + 6 : 0) +
        closesInside * FRAG_BOTTOM,
      left: Math.min(...xs) - FRAG_SIDE,
      right: Math.max(...xs) + FRAG_SIDE,
      tabW: textWidth(label, 10) + 16,
      tabH: 20,
      ...(elseFirst && f.else
        ? { divider: { y: r2(dividerY(elseFirst)), label: f.else.label ?? "else" } }
        : {}),
      needRight,
      reach: 0,
    });
  });
  const depth = nestDepth(out);
  const base = out.map((b, i) => {
    const inset = nestInset(depth[i]!, b.right - b.left, b.tabW);
    b.left += inset;
    b.right -= inset;
    return b.right;
  });
  // Widen for the self-messages, deepest first, so every enclosing box ends
  // one nesting step past the box it holds.
  const order = out.map((_, i) => i).sort((p, q) => depth[q]! - depth[p]!);
  for (const i of order) {
    const b = out[i]!;
    if (b.needRight > b.right) b.right = b.needRight;
    for (const j of order) {
      const c = out[j]!;
      if (depth[j]! > depth[i]! && c.top > b.top && c.bottom < b.bottom && c.right + NEST_INSET > b.right) {
        b.right = c.right + NEST_INSET;
      }
    }
  }
  out.forEach((b, i) => {
    b.reach = r2(b.right - base[i]!);
  });
  return out;
}

/**
 * How far a box at this nesting depth steps in from each side.
 *
 * Eight pixels a level, but never so far that the box gets narrower than its
 * own tab (or a sane minimum). Uncapped, six loops nested around one self
 * message came out 68, 52, 36, 20, 4 and -12 wide: from the third level the
 * word "loop" stuck out past its box, and the last resize made Figma throw.
 * Past the cap the deeper boxes keep the same width — they still read as
 * nested by their top and bottom, which step out per level regardless. The
 * layout and the reflow both go through here, so a drag never changes a width
 * the first draw did not have.
 */
function nestInset(depth: number, width: number, tabW: number): number {
  const floor = Math.max(tabW, FRAG_MIN_W);
  const roomy = Math.min(depth * NEST_INSET, (width - floor) / 2);
  // Past the cap every level still steps in a little, so two nested boxes
  // never share a left/right edge (a narrow box used to fall back to the
  // outermost x). Bounded so even a deep stack keeps a visible width.
  const stepped = Math.max(roomy, depth * NEST_MIN_STEP);
  return Math.max(0, Math.min(stepped, (width - NEST_MIN_W) / 2));
}

/**
 * How many other boxes enclose each one, read off the boxes' own top and
 * bottom. Geometry rather than the message lists, because the reflow only has
 * the stored boxes — and a box nested in another then steps in from both
 * sides, so its border never runs along its parent's on a shared lifeline.
 */
function nestDepth(boxes: Array<{ top: number; bottom: number }>): number[] {
  return boxes.map(
    (b) => boxes.filter((o) => o !== b && o.top < b.top && o.bottom > b.bottom).length,
  );
}

// ------------------------------------------------------------------ emit ----

function emitMessage(m: Msg, byId: Map<string, Party>): DrawMessage {
  const from = byId.get(m.from);
  const to = byId.get(m.to);
  const color = m.cls === "error" ? ERROR_RED : m.cls === "edge" ? EDGE_AMBER : INK;
  const cap: "filled" | "line" = m.kind === "sync" ? "filled" : "line";
  const dashed = m.kind === "return";
  const y = r2(m.y);

  if (!from || !to) {
    return {
      id: m.id,
      points: [],
      color,
      dashed,
      cap,
      label: { x: 0, y: 0, w: 0, h: 0, text: "", muted: false },
    };
  }

  let points: Pt[];
  let label: { x: number; y: number; w: number; h: number };
  if (m.self) {
    const x = r2(from.cx + BAR_W / 2);
    const out = r2(from.cx + SELF_OUT);
    points = [
      [x, y],
      [out, y],
      [out, r2(y + 26)],
      [x, r2(y + 26)],
    ];
    label = { x: r2(out + 10), y: r2(y + 4), w: m.lw, h: m.lh };
  } else {
    const right = to.cx > from.cx;
    const x1 = r2(from.cx + (right ? BAR_W / 2 : -BAR_W / 2));
    const x2 = r2(to.cx + (right ? -BAR_W / 2 : BAR_W / 2));
    points = [
      [x1, y],
      [x2, y],
    ];
    label = {
      x: r2((x1 + x2) / 2 - m.lw / 2),
      y: r2(y - m.lh - 5),
      w: m.lw,
      h: m.lh,
    };
  }

  return {
    id: m.id,
    points,
    color,
    dashed,
    cap,
    label: { ...label, text: m.labelLines.join("\n"), muted: m.kind === "return" },
    ...(m.noteLines.length
      ? {
          note: {
            x: r2(Math.min(points[0]![0], points[points.length - 1]![0])),
            y: r2(y + (m.self ? 34 : 8)),
            w: m.nw,
            h: m.nh,
            text: m.noteLines.join("\n"),
          },
        }
      : {}),
  };
}

function emitFragment(f: Box, _byId: Map<string, Party>): DrawFragment {
  return {
    id: f.id,
    kind: f.kind,
    label: f.label,
    at: { x: r2(f.left), y: r2(f.top), w: r2(f.right - f.left), h: r2(f.bottom - f.top) },
    tabW: f.tabW,
    tabH: f.tabH,
    ...(f.divider ? { divider: f.divider } : {}),
  };
}

export function emitSequenceDraw(
  laid: SequenceLayout,
  meta: { title: string; subtitle: string; name: string; x: number; y: number; parentId?: string },
  options: SeqOptions,
): SequenceDraw {
  return {
    name: meta.name,
    title: meta.title,
    subtitle: meta.subtitle,
    x: meta.x,
    y: meta.y,
    w: laid.w,
    h: laid.h,
    ...(meta.parentId ? { parentId: meta.parentId } : {}),
    participants: laid.participants,
    activations: laid.activations,
    messages: laid.messages,
    fragments: laid.fragments,
    font: options.font && options.font.trim() ? options.font.trim() : DEFAULT_FONT,
    graph: laid.graph,
  };
}

export { LIFELINE, FRAG_STROKE, BAR_W };


// ---------------------------------------------------------------- reflow ----

export interface ReflowedSequence {
  participants: Array<{ id: string; lifeline: { x: number; y: number; h: number } }>;
  messages: DrawMessage[];
  activations: DrawActivation[];
  fragments: DrawFragment[];
  /** Participants no longer where the layout pass put them. */
  moved: string[];
  /** Message ids whose participant is gone from the canvas. */
  dropped: string[];
}

/**
 * Re-place a drawn sequence from where its participants are NOW.
 *
 * Only the COLUMNS move: the row a message sits on is its position in time,
 * which dragging a head does not change. So the arrows re-span, the labels
 * re-centre, the bars follow their lifeline and the fragment boxes re-stretch,
 * and the order the diagram tells is exactly the order it told before.
 */
export function reflowSequence(
  graph: SequenceGraph,
  placed: Map<string, Placement>,
): ReflowedSequence {
  const byId = new Map<string, Party>();
  const moved: string[] = [];
  let bottom = 0;
  for (const p of graph.participants) {
    const at = placed.get(p.id);
    if (!at) continue;
    byId.set(p.id, {
      id: p.id,
      name: p.id,
      kind: "system",
      cls: "plain",
      w: at.w,
      h: at.h,
      x: at.x,
      cx: at.x + at.w / 2,
    });
    if (!samePlace(p.at, at)) moved.push(p.id);
    bottom = Math.max(bottom, at.y + at.h + p.lifelineH);
  }

  const dropped: string[] = [];
  const msgs: Msg[] = [];
  for (const m of graph.messages) {
    if (!byId.has(m.from) || !byId.has(m.to)) {
      dropped.push(m.id);
      continue;
    }
    msgs.push({
      id: m.id,
      from: m.from,
      to: m.to,
      kind: m.kind,
      cls: m.cls,
      labelLines: m.labelLines,
      lw: m.lw,
      lh: m.lh,
      noteLines: m.noteLines,
      nw: m.nw,
      nh: m.nh,
      y: m.y,
      self: m.from === m.to,
    });
  }

  const participants = graph.participants
    .filter((p) => placed.has(p.id))
    .map((p) => {
      const at = placed.get(p.id)!;
      return {
        id: p.id,
        lifeline: { x: r2(at.x + at.w / 2), y: r2(at.y + at.h), h: r2(bottom - (at.y + at.h)) },
      };
    });

  const activations: DrawActivation[] = graph.activations
    .filter((b) => byId.has(b.participant))
    .map((b) => ({
      id: b.id,
      participant: b.participant,
      at: {
        x: r2(byId.get(b.participant)!.cx - BAR_W / 2 + (b.depth ?? 0) * (BAR_W / 2)),
        y: r2(b.y),
        w: BAR_W,
        h: r2(b.h),
      },
    }));

  const depth = nestDepth(graph.fragments);
  const fragments: DrawFragment[] = graph.fragments.map((f, i) => {
    const xs = f.parties
      .map((id) => byId.get(id)?.cx)
      .filter((x): x is number => typeof x === "number");
    const outerLeft = xs.length ? Math.min(...xs) - FRAG_SIDE : 0;
    const outerRight = xs.length ? Math.max(...xs) + FRAG_SIDE : 0;
    const inset = xs.length ? nestInset(depth[i]!, outerRight - outerLeft, f.tabW) : 0;
    const left = outerLeft + inset;
    const right = outerRight - inset + (f.reach ?? 0);
    return {
      id: f.id,
      kind: f.kind,
      label: f.label,
      at: { x: r2(left), y: r2(f.top), w: r2(right - left), h: r2(f.bottom - f.top) },
      tabW: f.tabW,
      tabH: f.tabH,
      ...(f.divider ? { divider: f.divider } : {}),
    };
  });

  return {
    participants,
    messages: msgs.map((m) => emitMessage(m, byId)),
    activations,
    fragments,
    moved,
    dropped,
  };
}

/** Same box, to within the quarter-pixel grid the layout rounds to. */
function samePlace(a: Placement, b: Placement): boolean {
  return (
    Math.abs(a.x - b.x) < 0.5 &&
    Math.abs(a.y - b.y) < 0.5 &&
    Math.abs(a.w - b.w) < 0.5 &&
    Math.abs(a.h - b.h) < 0.5
  );
}
