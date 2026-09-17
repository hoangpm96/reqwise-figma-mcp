/**
 * The proof-reading half of the sequence tool.
 *
 * An exchange between systems goes wrong in ways a picture normally hides: a
 * call nobody answers, a reply nobody asked for, an `alt` with no else, a
 * participant drawn because somebody thought it was involved. Those are what
 * the integration spec has to settle, so they are reported before anything is
 * drawn.
 */
import { firstLine, list } from "../diagram/graph.js";
import { pairCalls } from "./pairing.js";
import type { SeqFragmentSpec, SeqMessageSpec, SeqParticipantSpec } from "./types.js";

export interface SequenceCheck {
  warnings: string[];
  participants: SeqParticipantSpec[];
  messages: SeqMessageSpec[];
  fragments: SeqFragmentSpec[];
}

export function checkSequence(
  rawParticipants: SeqParticipantSpec[],
  rawMessages: SeqMessageSpec[],
  rawFragments: SeqFragmentSpec[],
): SequenceCheck {
  const warnings: string[] = [];

  const participants: SeqParticipantSpec[] = [];
  const byId = new Map<string, SeqParticipantSpec>();
  for (const p of rawParticipants) {
    if (byId.has(p.id)) {
      warnings.push(`Duplicate participant id "${p.id}" — the later declaration was dropped.`);
      continue;
    }
    byId.set(p.id, p);
    participants.push(p);
  }

  const messages: SeqMessageSpec[] = [];
  const msgIds = new Set<string>();
  for (const m of rawMessages) {
    if (msgIds.has(m.id)) {
      warnings.push(`Duplicate message id "${m.id}" — the later one was dropped.`);
      continue;
    }
    const missing = [!byId.has(m.from) ? m.from : null, !byId.has(m.to) ? m.to : null].filter(
      (v): v is string => v !== null,
    );
    if (missing.length) {
      warnings.push(
        `Message "${m.id}" involves undeclared participant ${missing.map((x) => `"${x}"`).join(" and ")} — dropped. Declare it, or fix the id.`,
      );
      continue;
    }
    if (!m.label || !m.label.trim()) {
      warnings.push(
        `Message "${m.id}" (${m.from} → ${m.to}) has no label — an arrow that does not say WHAT is sent is the part of an integration spec people argue about later.`,
      );
    }
    msgIds.add(m.id);
    messages.push(m);
  }

  // ---- calls and replies ----
  // Who answers whom is shared with the layout (`pairCalls`), so a warning
  // here and an activation bar there can never disagree.
  const paired = pairCalls(messages, rawFragments);
  if (paired.orphanReplies.length) {
    warnings.push(
      `Reply with no call to answer: ${list(paired.orphanReplies.map((r) => `"${r.id}" (${r.from} → ${r.to})`))}. Either the call is missing from the diagram, or this is not a reply — mark it kind:"async".`,
    );
  }
  // Unanswered calls are only worth reporting when the diagram DOES show
  // replies elsewhere: a diagram that never draws them is a style, not a bug.
  const returns = messages.filter((m) => (m.kind ?? "sync") === "return").length;
  // A person tapping a button is not waiting for a message back — only a
  // system-to-system call reads as unanswered.
  const actors = new Set(participants.filter((p) => p.kind === "actor").map((p) => p.id));
  const unanswered = paired.unanswered.filter((c) => !actors.has(c.from));
  if (returns > 0 && unanswered.length) {
    warnings.push(
      `Call with no reply: ${list(unanswered.map((c) => `"${c.id}" (${c.from} → ${c.to})`))}. This diagram draws replies elsewhere, so the reader will read the silence as "nothing comes back" — say what does, or mark the call kind:"async".`,
    );
  }

  // ---- fragments ----
  const order = new Map<string, number>();
  messages.forEach((m, i) => order.set(m.id, i));
  const fragments: SeqFragmentSpec[] = [];
  for (const f of rawFragments) {
    const all = f.messages.concat(f.else?.messages ?? []);
    const unknown = all.filter((id) => !order.has(id));
    if (unknown.length) {
      warnings.push(
        `Fragment "${f.kind} ${firstLine(f.label)}" names ${list(unknown.map((u) => `"${u}"`))}, which is not a message in this diagram — dropped.`,
      );
      continue;
    }
    if (!all.length) {
      warnings.push(`Fragment "${f.kind} ${firstLine(f.label)}" holds no messages — dropped.`);
      continue;
    }
    const indices = all.map((id) => order.get(id)!).sort((a, b) => a - b);
    const contiguous = indices[indices.length - 1]! - indices[0]! === indices.length - 1;
    if (!contiguous) {
      warnings.push(
        `Fragment "${f.kind} ${firstLine(f.label)}" skips a message in the middle of its range. A block on a sequence diagram covers a CONTIGUOUS run of time — reorder the messages, or split the fragment.`,
      );
      continue;
    }
    if (f.kind === "alt" && !f.else) {
      warnings.push(
        `"alt ${firstLine(f.label)}" has no else — an alternative with one branch is an opt. Say what happens otherwise, or use kind:"opt".`,
      );
    }
    fragments.push(f);
  }

  // ---- who is actually involved ----
  const used = new Set<string>();
  for (const m of messages) {
    used.add(m.from);
    used.add(m.to);
  }
  const idle = participants.filter((p) => !used.has(p.id)).map((p) => `"${p.id}"`);
  if (idle.length) {
    warnings.push(
      `Participant with no messages: ${list(idle)}. Either something it sends or receives is missing, or it does not belong on this diagram.`,
    );
  }

  if (!participants.length) warnings.push("No participants — nothing to draw.");
  if (!messages.length) warnings.push("No messages — an empty exchange says nothing.");

  return { warnings, participants, messages, fragments };
}



