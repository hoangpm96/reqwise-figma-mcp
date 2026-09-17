/**
 * Which reply answers which call — the one question both the checker and the
 * activation bars depend on, so they answer it the same way.
 *
 * The hard part is that the branches of an `alt`, and the body of a `break`,
 * are ALTERNATIVE timelines. Three `web → user` replies in three branches are
 * three outcomes of ONE call, not three replies to be matched off a LIFO stack
 * against three different calls. Matching them naively closed a call from
 * earlier in the scenario — which drew its activation bar down the whole
 * diagram and pushed the real bar under it into a nested, stepped-aside
 * position — and reported the leftovers as replies answering nothing.
 */

import type { SeqFragmentSpec } from "./types.js";

/** A call, plus every reply attributed to it (one per exclusive branch). */
export interface PairedCall {
  id: string;
  from: string;
  to: string;
  replies: string[];
}

export interface Pairing {
  calls: PairedCall[];
  /** Calls nobody answers, in message order. */
  unanswered: PairedCall[];
  /** reply id → the call it answers. */
  callOfReply: Map<string, PairedCall>;
  /** Replies that answer no call at all. */
  orphanReplies: Array<{ id: string; from: string; to: string }>;
}

interface Msgish {
  id: string;
  from: string;
  to: string;
  kind?: string;
}

export function pairCalls(messages: Msgish[], fragments: SeqFragmentSpec[]): Pairing {
  const calls: PairedCall[] = [];
  const open: PairedCall[] = [];
  const callOfReply = new Map<string, PairedCall>();
  const orphanReplies: Array<{ id: string; from: string; to: string }> = [];
  const regions = regionMap(fragments);

  for (const m of messages) {
    // A self-message is a participant doing its own work: nobody to reply.
    if (m.from === m.to) continue;
    const kind = m.kind ?? "sync";
    if (kind === "sync") {
      const call: PairedCall = { id: m.id, from: m.from, to: m.to, replies: [] };
      calls.push(call);
      open.push(call);
      continue;
    }
    if (kind !== "return") continue;

    const answers = (c: PairedCall) => c.to === m.from && c.from === m.to;
    // 1. The call this reply shares a fragment with — the innermost one. A
    //    reply inside a branch answers the call made inside that branch, never
    //    an older one from before the fragment opened.
    let at = lastIndex(open, (c) => answers(c) && shares(regions, c.id, m.id));
    if (at < 0) {
      // 2. Otherwise: is this the same answer given in another branch? Two
      //    `alt` branches, or a `break` body, are alternative timelines, so
      //    their replies belong to ONE call. Checked before the plain stack,
      //    which would hand it an older call that is still open.
      const alt = lastMatch(
        calls,
        (c) => answers(c) && c.replies.some((r) => exclusive(fragments, r, m.id)),
      );
      if (alt) {
        alt.replies.push(m.id);
        callOfReply.set(m.id, alt);
        continue;
      }
      // 3. Plain nesting: the innermost open call it could answer.
      at = lastIndex(open, answers);
    }
    if (at >= 0) {
      const call = open[at]!;
      call.replies.push(m.id);
      callOfReply.set(m.id, call);
      open.splice(at, 1);
      continue;
    }
    orphanReplies.push({ id: m.id, from: m.from, to: m.to });
  }

  return { calls, unanswered: open, callOfReply, orphanReplies };
}

/**
 * Can these two messages happen in the same run? `alt` branches cannot, and a
 * `break` body runs INSTEAD of the rest of its enclosing fragment. An `opt`
 * body is deliberately NOT counted: it happens in addition, not instead, so a
 * reply inside one is a real second reply and worth reporting.
 */
export function exclusive(fragments: SeqFragmentSpec[], a: string, b: string): boolean {
  for (const f of fragments) {
    if (f.kind === "alt") {
      const els = f.else?.messages ?? [];
      const aIn = f.messages.indexOf(a) >= 0;
      const bIn = f.messages.indexOf(b) >= 0;
      const aElse = els.indexOf(a) >= 0;
      const bElse = els.indexOf(b) >= 0;
      if ((aIn && bElse) || (aElse && bIn)) return true;
    }
    if (f.kind === "break") {
      const aIn = f.messages.indexOf(a) >= 0;
      const bIn = f.messages.indexOf(b) >= 0;
      if (aIn !== bIn) return true;
    }
  }
  return false;
}

/**
 * message id → the fragments it sits inside, `<index>` for a body and
 * `<index>:else` for an else branch. Two messages in the same one are part of
 * the same run of the exchange.
 */
function regionMap(fragments: SeqFragmentSpec[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (id: string, key: string) => {
    const set = out.get(id) ?? new Set<string>();
    set.add(key);
    out.set(id, set);
  };
  fragments.forEach((f, i) => {
    for (const id of f.messages) add(id, `${i}`);
    for (const id of f.else?.messages ?? []) add(id, `${i}:else`);
  });
  return out;
}

function shares(regions: Map<string, Set<string>>, a: string, b: string): boolean {
  const one = regions.get(a);
  const two = regions.get(b);
  if (!one || !two) return false;
  for (const key of one) if (two.has(key)) return true;
  return false;
}

function lastIndex<T>(arr: T[], pred: (v: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i]!)) return i;
  return -1;
}

function lastMatch<T>(arr: T[], pred: (v: T) => boolean): T | undefined {
  const at = lastIndex(arr, pred);
  return at >= 0 ? arr[at] : undefined;
}
