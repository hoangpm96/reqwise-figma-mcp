/**
 * The proof-reading half of the state tool.
 *
 * A state machine fails in ways a picture of it hides, and every one of them
 * becomes a bug in code: a state nothing can reach, a state nothing can leave,
 * two transitions on the SAME event with nothing to choose between them, a
 * final state that somehow continues. Those are the questions the spec left
 * open, so they are reported before anything is drawn.
 *
 * The bar, learned the hard way on the sequence checker: a proof-reader is
 * only worth having if it is QUIET when the machine is right. Every rule here
 * has an exemption for the case where the silence is deliberate.
 */
import { adjacency, list, reachableFrom } from "../diagram/graph.js";
import type { StateKind, StateNodeSpec, TransitionSpec } from "./types.js";

export interface StateCheck {
  warnings: string[];
  states: StateNodeSpec[];
  transitions: TransitionSpec[];
}

/** Nodes that are notation, not a value the entity rests in. */
const PSEUDO = new Set<StateKind>(["initial", "choice", "fork", "join"]);

export function checkState(
  rawStates: StateNodeSpec[],
  rawTransitions: TransitionSpec[],
): StateCheck {
  const warnings: string[] = [];

  const states: StateNodeSpec[] = [];
  const byId = new Map<string, StateNodeSpec>();
  for (const s of rawStates) {
    if (byId.has(s.id)) {
      warnings.push(`Duplicate state id "${s.id}" — the later declaration was dropped.`);
      continue;
    }
    byId.set(s.id, s);
    states.push(s);
  }

  const kindOf = (id: string): StateKind => byId.get(id)?.kind ?? "state";
  const nameOf = (id: string): string => {
    const s = byId.get(id);
    const label = (s?.label ?? "").trim();
    return label ? label : id;
  };

  const transitions: TransitionSpec[] = [];
  for (const t of rawTransitions) {
    const missing = [!byId.has(t.from) ? t.from : null, !byId.has(t.to) ? t.to : null].filter(
      (v): v is string => v !== null,
    );
    if (missing.length) {
      warnings.push(
        `Transition ${t.from} → ${t.to} names undeclared state ${list(missing.map((m) => `"${m}"`))} — dropped. Declare it, or fix the id.`,
      );
      continue;
    }
    transitions.push(t);
  }

  // ---- where it starts ----
  const initials = states.filter((s) => s.kind === "initial");
  if (!initials.length) {
    warnings.push(
      `No initial state — nothing says where the lifecycle begins, so a reader cannot tell which value a new record is created with. Add { id, kind:"initial" } and a transition from it.`,
    );
  } else if (initials.length > 1) {
    warnings.push(
      `${initials.length} initial states (${list(initials.map((s) => `"${s.id}"`))}). A machine starts in exactly ONE place — the others are either ordinary states or belong on a diagram of their own.`,
    );
  }

  const into = new Map<string, TransitionSpec[]>();
  for (const t of transitions) {
    const bucket = into.get(t.to);
    if (bucket) bucket.push(t);
    else into.set(t.to, [t]);
  }
  const badEntry = transitions.filter((t) => kindOf(t.to) === "initial");
  if (badEntry.length) {
    warnings.push(
      `Transition INTO an initial state: ${list(badEntry.map((t) => `${t.from} → ${t.to}`))}. The starting dot is where the machine begins, not somewhere it can return to — point these at the state the entity actually goes back to.`,
    );
  }

  const out = new Map<string, TransitionSpec[]>();
  for (const t of transitions) {
    const bucket = out.get(t.from);
    if (bucket) bucket.push(t);
    else out.set(t.from, [t]);
  }

  // ---- what it can reach ----
  const ids = states.map((s) => s.id);
  const adj = adjacency(ids, transitions);
  if (initials.length) {
    const live = reachableFrom(
      initials.map((s) => s.id),
      adj.out,
    );
    const stranded = ids.filter((id) => !live.has(id));
    if (stranded.length) {
      warnings.push(
        `Unreachable from the initial state: ${list(stranded.map((id) => `"${nameOf(id)}"`))}. Either a transition into ${stranded.length > 1 ? "them" : "it"} is missing, or ${stranded.length > 1 ? "they are" : "it is"} a value the entity can never actually hold.`,
      );
    }
  } else {
    // With no initial there is nothing to walk from, so fall back to the
    // weaker question: what does nothing point at?
    const orphans = ids.filter((id) => !into.has(id) && kindOf(id) !== "initial");
    if (orphans.length && orphans.length < ids.length) {
      warnings.push(
        `Nothing transitions into: ${list(orphans.map((id) => `"${nameOf(id)}"`))}. Once there is an initial state this will be the unreachable set.`,
      );
    }
  }

  // ---- what it cannot leave ----
  // A `final` is meant to be a dead end. Everything else that has no way out
  // is a state the entity gets stuck in, which nobody ever intends.
  const stuck = states.filter(
    (s) => s.kind !== "final" && !(out.get(s.id) ?? []).some((t) => t.to !== s.id),
  );
  if (stuck.length) {
    warnings.push(
      `No way out of: ${list(stuck.map((s) => `"${nameOf(s.id)}"`))}. An entity that reaches ${stuck.length > 1 ? "these" : "this"} can never change again — mark ${stuck.length > 1 ? "them" : "it"} kind:"final" if that is the end of the lifecycle, or say what moves it on.`,
    );
  }

  const leaky = states.filter((s) => s.kind === "final" && (out.get(s.id) ?? []).length > 0);
  if (leaky.length) {
    warnings.push(
      `Final state with a way out: ${list(leaky.map((s) => `"${nameOf(s.id)}"`))}. A final state ends the lifecycle — if the entity can come back from it, it is an ordinary state.`,
    );
  }

  // ---- what fires, and when ----
  // Two transitions leaving one state on the SAME event with nothing to
  // choose between them is THE state-machine bug: whichever the code happens
  // to evaluate first wins, and the diagram promised nothing.
  for (const [id, outs] of out) {
    if (PSEUDO.has(kindOf(id))) continue;
    const byEvent = new Map<string, TransitionSpec[]>();
    for (const t of outs) {
      const key = (t.event ?? "").trim().toLowerCase();
      const bucket = byEvent.get(key);
      if (bucket) bucket.push(t);
      else byEvent.set(key, [t]);
    }
    for (const group of byEvent.values()) {
      if (group.length < 2) continue;
      const unguarded = group.filter((t) => !(t.guard ?? "").trim());
      if (unguarded.length < 2) continue;
      // Quote the event as it was WRITTEN, not the lower-cased key the
      // grouping used, or the reader goes looking for a string that is not
      // in their spec.
      const written = (unguarded[0]!.event ?? "").trim();
      warnings.push(
        `"${nameOf(id)}" has ${unguarded.length} transitions on ${written ? `the same event "${written}"` : "no event at all"} with no guard to tell them apart (to ${list(unguarded.map((t) => `"${nameOf(t.to)}"`))}). Whichever the implementation checks first will win — add a [guard] to each, or merge them.`,
      );
    }
  }

  // A real state waits for something. The exception is UML's COMPLETION
  // transition: a state with a `do` activity moves on by itself when that
  // activity finishes, and leaving the event off is how you say so.
  const silent = transitions.filter((t) => {
    if (PSEUDO.has(kindOf(t.from))) return false;
    if ((t.event ?? "").trim() || (t.guard ?? "").trim()) return false;
    return !(byId.get(t.from)?.do ?? "").trim();
  });
  if (silent.length) {
    warnings.push(
      `Transition with no event and no guard: ${list(silent.map((t) => `${nameOf(t.from)} → ${nameOf(t.to)}`))}. A state stays put until something happens to it — say what (an action, a timer, a webhook), or give the source a \`do\` activity, which is how you say "when that finishes".`,
    );
  }

  // ---- branches ----
  for (const s of states) {
    if (s.kind !== "choice") continue;
    const outs = out.get(s.id) ?? [];
    if (outs.length < 2) {
      warnings.push(
        `Choice "${nameOf(s.id)}" has ${outs.length} way(s) out. A diamond that does not branch is not a choice — give it the other outcome, or make it an ordinary transition.`,
      );
      continue;
    }
    const bare = outs.filter((t) => !(t.guard ?? "").trim());
    // One unguarded branch is the `[else]` and reads fine; two do not.
    if (bare.length > 1) {
      warnings.push(
        `Choice "${nameOf(s.id)}" has ${bare.length} branches with no [guard] — a reader cannot tell which one is taken. Label every branch but at most one, which reads as the else.`,
      );
    }
  }

  // ---- concurrency ----
  const forks = states.filter((s) => s.kind === "fork").length;
  const joins = states.filter((s) => s.kind === "join").length;
  if (forks && !joins) {
    warnings.push(
      `${forks} fork(s) and no join. Concurrent regions have to come back together before the machine can move on — add the join, or the diagram says the entity is in two states forever.`,
    );
  }

  if (!states.length) warnings.push("No states — nothing to draw.");
  if (states.length && !transitions.length) {
    warnings.push("No transitions — a list of states with nothing moving between them is a list, not a machine.");
  }

  return { warnings, states, transitions };
}
