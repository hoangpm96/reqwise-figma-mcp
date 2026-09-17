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
  // Every rule below asks "is this message inside that fragment?" by list
  // membership, which only works when a fragment lists the messages of the
  // fragments nested in it too. The text parser emits that shape; JSON written
  // by hand often lists only a fragment's OWN messages. Read both the same way.
  fragments = withNestedMessages(messages, fragments);
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

    // A call made in the OTHER branch of an alt never happened in the run this
    // reply belongs to, so it cannot be what the reply answers — at any step.
    // Sharing an outer `loop` with it used to be enough to pair them, which
    // left the call from before the loop reported as unanswered.
    const answers = (c: PairedCall) =>
      c.to === m.from && c.from === m.to && !outOfRun(fragments, c.id, m.id);
    // 1. The call this reply shares a fragment with — the innermost one. A
    //    reply inside a branch answers the call made inside that branch, never
    //    an older one from before the fragment opened.
    let at = lastIndex(open, (c) => answers(c) && shares(regions, c.id, m.id));
    if (at < 0) {
      // 2. Otherwise: is this the same answer given in another branch? Two
      //    `alt` branches, or a `break` body, are alternative timelines, so
      //    their replies belong to ONE call. Checked before the plain stack,
      //    which would hand it an older call that is still open. The call
      //    itself must be reachable from this branch too (`answers` says so):
      //    a call made and answered INSIDE the if-branch is not what the
      //    else-branch replies to.
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
 * Each fragment with the messages of the fragments nested in it added to the
 * branch that holds them. A fragment sits in a branch when all of its messages
 * fall inside that branch's run of time: from its first message to its last,
 * and — for the body of an `alt` — on up to the message the else opens at, so
 * an inner fragment that ENDS the body is still counted as part of it.
 * Messages only get added from other fragments, never from the gaps in
 * between, so a list that already names everything comes back unchanged.
 */
function withNestedMessages(messages: Msgish[], fragments: SeqFragmentSpec[]): SeqFragmentSpec[] {
  const order = new Map<string, number>();
  messages.forEach((m, i) => order.set(m.id, i));
  const indices = (ids: string[]) => ids.map((id) => order.get(id)).filter((i): i is number => i !== undefined);
  const span = (ids: string[]): [number, number] | null => {
    const at = indices(ids);
    return at.length ? [Math.min(...at), Math.max(...at)] : null;
  };

  const out = fragments.map((f) => ({
    body: [...f.messages],
    els: f.else ? [...f.else.messages] : null,
  }));
  // Repeat until nothing moves, so three levels of nesting fill in from the
  // inside out whatever order the fragments were written in.
  for (let changed = true; changed; ) {
    changed = false;
    out.forEach((f, i) => {
      const body = span(f.body);
      const els = f.els ? span(f.els) : null;
      const bodyRun: [number, number] | null =
        body && els && els[0] > body[1] ? [body[0], els[0] - 1] : body;
      out.forEach((g, j) => {
        if (i === j) return;
        const inner = span(g.body.concat(g.els ?? []));
        if (!inner) return;
        const all = g.body.concat(g.els ?? []);
        for (const [run, list] of [
          [bodyRun, f.body],
          [els, f.els],
        ] as const) {
          if (!run || !list || inner[0] < run[0] || inner[1] > run[1]) continue;
          for (const id of all) {
            if (order.has(id) && !list.includes(id)) {
              list.push(id);
              changed = true;
            }
          }
        }
      });
    });
  }
  return fragments.map((f, i) => ({
    ...f,
    messages: out[i]!.body,
    ...(f.else ? { else: { ...f.else, messages: out[i]!.els! } } : {}),
  }));
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
 * Is a call out of reach of a later reply — did the two happen in different
 * runs? The other branch of an `alt`, yes. A `break` is one-directional,
 * though: a call made BEFORE a break is still open inside its body (the body
 * is often exactly the error reply to it), whereas a call made inside the body
 * cannot be answered after it, because the body ends the enclosing fragment.
 * `exclusive` is symmetric and would refuse the first case.
 */
function outOfRun(fragments: SeqFragmentSpec[], call: string, reply: string): boolean {
  for (const f of fragments) {
    if (f.kind === "alt") {
      const els = f.else?.messages ?? [];
      if (f.messages.indexOf(call) >= 0 && els.indexOf(reply) >= 0) return true;
      if (els.indexOf(call) >= 0 && f.messages.indexOf(reply) >= 0) return true;
    }
    if (f.kind === "break" && f.messages.indexOf(call) >= 0 && f.messages.indexOf(reply) < 0) {
      return true;
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
