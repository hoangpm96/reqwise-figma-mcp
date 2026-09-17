/**
 * The compact form of a sequence diagram — mermaid-shaped on purpose, because
 * that is the notation a model already knows cold.
 *
 *   actor user "User"
 *   participant api "Booking API" / booking-svc
 *   db store "Bookings DB" / postgres
 *   user ->> api: POST /holds { seatIds }
 *   alt seats free
 *     api -->> user: 201 { bookingId }
 *     note: hold lasts 10 minutes
 *   else already booked
 *     api -->> user: 409 seats_unavailable !err
 *   end
 *
 * Two things vanish compared with the JSON: the message `id`s (generated here)
 * and the `messages: ["m3","m4"]` id-lists inside fragments — a block's extent
 * is where it is written. Those id-lists were both a third of the payload and
 * the part that was fiddly to get right (a fragment must cover a contiguous
 * run, and a hand-maintained list drifts the moment a message moves).
 */
import { lines, splitDetail, takeQuoted, unknownLine } from "../diagram/text-util.js";
import type { SeqFragmentSpec, SeqMessageSpec, SeqParticipantSpec } from "./types.js";

export interface ParsedSequence {
  participants: SeqParticipantSpec[];
  messages: SeqMessageSpec[];
  fragments: SeqFragmentSpec[];
  warnings: string[];
}

const KIND: Record<string, SeqParticipantSpec["kind"]> = {
  actor: "actor",
  participant: "system",
  system: "system",
  external: "external",
  queue: "queue",
  db: "db",
};

const BLOCKS = ["alt", "opt", "loop", "par", "break", "critical"] as const;
type BlockKind = SeqFragmentSpec["kind"];

// The sender is matched lazily and must start with a letter: mermaid is
// usually written WITHOUT spaces (`db-->>api: paymentId`), and a greedy \S+
// swallowed the first dash of the arrow, leaving a participant called "db-".
const ARROW =
  /^([A-Za-z_][\w.-]*?)\s*(-->>|--\)|->>|->|-->)\s*([A-Za-z_][\w.-]*)\s*:\s*(.+)$/;
const CLS = /\s!(ok|happy|err|error|edge|plain)\b/;

interface OpenBlock {
  kind: BlockKind;
  label: string;
  first: string[];
  current: string[];
  elseLabel?: string;
  inElse: boolean;
  /** Line order of the opening keyword: the tie-break for blocks over the same messages. */
  opened: number;
}

export function parseSequenceText(src: string): ParsedSequence {
  const participants: SeqParticipantSpec[] = [];
  const messages: SeqMessageSpec[] = [];
  const fragments: SeqFragmentSpec[] = [];
  const openedAt = new Map<SeqFragmentSpec, number>();
  const warnings: string[] = [];
  const known = new Set<string>();
  const stack: OpenBlock[] = [];
  let seq = 0;

  const push = (id: string) => {
    for (const b of stack) (b.inElse ? b.current : b.first).push(id);
  };

  for (const l of lines(src)) {
    if (isHeader(l.text)) {
      warnings.push(`sequence text, line ${l.no}: a leading "sequence" header line is not part of the model — skipped; title/subtitle are their own fields.`);
      continue;
    }
    const head = l.text.split(/\s+/)[0]!.toLowerCase();

    // ---- participants ----
    if (KIND[head]) {
      const { head: body, detail } = splitDetail(l.text.slice(head.length).trim());
      const { value: name, rest } = takeQuoted(body);
      const id = rest.split(/\s+/).filter(Boolean)[0];
      if (!id) {
        unknownLine(warnings, "sequence", l);
        continue;
      }
      known.add(id);
      participants.push({
        id,
        name: name ?? id,
        ...(detail ? { detail } : {}),
        ...(KIND[head] !== "system" ? { kind: KIND[head] } : {}),
      });
      continue;
    }

    // ---- blocks ----
    if (BLOCKS.includes(head as (typeof BLOCKS)[number])) {
      stack.push({
        kind: head as BlockKind,
        label: l.text.slice(head.length).trim(),
        first: [],
        current: [],
        inElse: false,
        opened: l.no,
      });
      continue;
    }
    if (head === "else") {
      const b = stack[stack.length - 1];
      if (!b) {
        warnings.push(`sequence text, line ${l.no}: \`else\` with no open block.`);
        continue;
      }
      if (b.inElse) {
        warnings.push(
          `sequence text, line ${l.no}: a second \`else\` — an alt draws two branches, so the extra one was skipped.`,
        );
        continue;
      }
      b.inElse = true;
      b.elseLabel = l.text.slice(4).trim();
      continue;
    }
    if (head === "end") {
      const b = stack.pop();
      if (!b) {
        warnings.push(`sequence text, line ${l.no}: \`end\` with no open block.`);
        continue;
      }
      const frag: SeqFragmentSpec = {
        kind: b.kind,
        label: b.label,
        messages: b.first,
        ...(b.inElse ? { else: { label: b.elseLabel ?? "", messages: b.current } } : {}),
      };
      openedAt.set(frag, b.opened);
      fragments.push(frag);
      continue;
    }

    // ---- a note on the message above ----
    // Exactly `note` / `note:` — a participant called `notifier` or
    // `notes-api` starts with "note" too, and its message used to vanish.
    // And only when the line is not a message: a participant called exactly
    // `note` (`note ->> api: b`) is a sender, and its arrows were being read as
    // a note on the message above.
    if ((head === "note" || head.startsWith("note:")) && !ARROW.test(l.text)) {
      const text = l.text.slice(l.text.indexOf(":") + 1).trim();
      const last = messages[messages.length - 1];
      if (!last || l.text.indexOf(":") < 0) {
        unknownLine(warnings, "sequence", l);
        continue;
      }
      last.note = text;
      continue;
    }

    // ---- messages ----
    const m = ARROW.exec(l.text);
    if (m) {
      const [, from, arrow, to, tail] = m as unknown as [string, string, string, string, string];
      let label = tail.trim();
      let cls: SeqMessageSpec["cls"] | undefined;
      const c = CLS.exec(` ${label}`);
      if (c) {
        const word = c[1]!;
        cls = word === "ok" || word === "happy" ? "happy" : word === "err" || word === "error" ? "error" : (word as SeqMessageSpec["cls"]);
        label = label.replace(CLS, "").trim();
      }
      const kind: SeqMessageSpec["kind"] =
        arrow === "-->>" || arrow === "-->" ? "return" : arrow === "--)" ? "async" : "sync";
      const id = `m${++seq}`;
      messages.push({
        id,
        from,
        to,
        label,
        ...(kind !== "sync" ? { kind } : {}),
        ...(cls ? { cls } : {}),
      });
      push(id);
      for (const who of [from, to]) {
        if (!known.has(who)) {
          known.add(who);
          participants.push({ id: who, name: who });
          warnings.push(
            `sequence text, line ${l.no}: "${who}" was never declared, so it is drawn as a plain system named "${who}". Declare it (\`participant ${who} "…"\`) to give it a name and a kind.`,
          );
        }
      }
      continue;
    }

    unknownLine(warnings, "sequence", l);
  }

  for (const b of stack) {
    warnings.push(`sequence text: \`${b.kind} ${b.label}\` was never closed with \`end\` — the block was dropped.`);
  }

  // A block is finished when it CLOSES, so the innermost one is emitted first.
  // Put them back in the order a person writes them — outermost first — so the
  // list matches the equivalent JSON, and the drawing does too.
  const order = new Map(messages.map((m, i) => [m.id, i]));
  const startOf = (f: SeqFragmentSpec) => order.get(f.messages[0] ?? "") ?? 0;
  const spanOf = (f: SeqFragmentSpec) => {
    const ids = [...f.messages, ...(f.else?.messages ?? [])];
    return (order.get(ids[ids.length - 1] ?? "") ?? 0) - startOf(f);
  };
  // Same start and same span (`loop` whose whole body is an `opt`): only the
  // line each was opened on says which is outside. Without this tie-break the
  // stable sort kept close order, and the inner block was drawn around the outer.
  fragments.sort(
    (a, b) => startOf(a) - startOf(b) || spanOf(b) - spanOf(a) || (openedAt.get(a) ?? 0) - (openedAt.get(b) ?? 0),
  );

  return { participants, messages, fragments, warnings };
}

/**
 * A leading `sequence "Title"` line is what a writer reaches for out of habit
 * (mermaid opens that way). It is not part of the model — `title`/`subtitle`
 * are their own fields — but silently treating it as content is how a header
 * ends up drawn as a step. So: skipped, and said out loud.
 */
function isHeader(text: string): boolean {
  return /^sequence\b\s*["']/.test(text.trim());
}
