/**
 * The compact form of a state machine.
 *
 *   held "Seats held"
 *     entry hold_expires_at = now() + 10 min
 *     detail booking_seats rows written
 *   paying "Awaiting payment"
 *     do wait for the payment gateway
 *   paid "Paid" final ok
 *   [*] -> held: Reserve the selected seats / insert bookings + booking_seats
 *   held -> paying: Confirm the order [payment method chosen] / insert payments
 *   paying ~> held: Gateway declined [failed attempts < 3] !err
 *
 * The transition line IS the UML sentence — `event [guard] / action` — so the
 * three fields stay three fields instead of collapsing into one string. `[*]`
 * is mermaid's initial pseudo-state and creates the starting dot; `~>` marks a
 * way back (retry, reopen, revert).
 */
import { lines, takeQuoted, takeWords, unknownLine } from "../diagram/text-util.js";
import type { StateNodeSpec, TransitionSpec } from "./types.js";

export interface ParsedState {
  states: StateNodeSpec[];
  transitions: TransitionSpec[];
  warnings: string[];
}

const KINDS = ["initial", "final", "choice", "fork", "join", "state"] as const;
const TRANS = /^(\[\*\]|[\w.-]+)\s*(~>|->)\s*(\[\*\]|[\w.-]+)\s*(?::\s*(.*))?$/;
const CLAUSES = ["entry", "do", "exit", "detail"] as const;
/**
 * The ids `[*]` becomes. Exported because they are notation, not values the
 * entity holds, and anything comparing a machine's states against a stored
 * enum has to know to leave them out.
 */
export const INITIAL = "__start";
export const FINAL_ID = "__end";

export function parseStateText(src: string): ParsedState {
  const states: StateNodeSpec[] = [];
  const transitions: TransitionSpec[] = [];
  const warnings: string[] = [];
  const byId = new Map<string, StateNodeSpec>();
  let current: StateNodeSpec | undefined;

  const ensure = (id: string, kind?: StateNodeSpec["kind"]): string => {
    const real = id === "[*]" ? (kind === "final" ? FINAL_ID : INITIAL) : id;
    if (!byId.has(real)) {
      const node: StateNodeSpec = { id: real, ...(id === "[*]" ? { kind: kind ?? "initial" } : {}) };
      byId.set(real, node);
      states.push(node);
    }
    return real;
  };

  for (const l of lines(src)) {
    if (isHeader(l.text)) {
      warnings.push(`state text, line ${l.no}: a leading "state" header line is not part of the model — skipped; title/subtitle are their own fields.`);
      continue;
    }
    const clause = CLAUSES.find((c) => l.text.toLowerCase().startsWith(`${c} `));
    if (l.indent > 0 && clause && current) {
      const value = l.text.slice(clause.length).trim();
      if (clause === "detail") current.detail = value;
      else current[clause] = value;
      continue;
    }

    const t = TRANS.exec(l.text);
    if (t) {
      const [, rawFrom, arrow, rawTo, tail] = t as unknown as string[];
      // `[*] ->` is the start; `-> [*]` is an end state.
      const from = ensure(rawFrom!, "initial");
      const to = ensure(rawTo!, "final");
      let rest = (tail ?? "").trim();
      let cls: TransitionSpec["cls"] | undefined;
      const c = /\s*!(ok|happy|err|error|edge|plain)\s*$/.exec(rest);
      if (c) {
        const w = c[1]!;
        cls = w === "ok" || w === "happy" ? "happy" : w === "err" || w === "error" ? "error" : (w as TransitionSpec["cls"]);
        rest = rest.slice(0, c.index).trim();
      }
      let action: string | undefined;
      const slash = rest.lastIndexOf(" / ");
      if (slash >= 0) {
        action = rest.slice(slash + 3).trim();
        rest = rest.slice(0, slash).trim();
      }
      let guard: string | undefined;
      const g = /\[([^\]]*)\]\s*$/.exec(rest);
      if (g) {
        guard = g[1]!.trim();
        rest = rest.slice(0, g.index).trim();
      }
      transitions.push({
        from,
        to,
        ...(rest ? { event: rest } : {}),
        ...(guard ? { guard } : {}),
        ...(action ? { action } : {}),
        ...(arrow === "~>" ? { kind: "return" as const } : {}),
        ...(cls ? { cls } : {}),
      });
      continue;
    }

    // A state declaration: `id ["label"] [kind] [cls]`
    const { value: label, rest } = takeQuoted(l.text);
    const { cls, kind, rest: words } = takeWords(rest, KINDS);
    const id = words.shift();
    if (!id) {
      unknownLine(warnings, "state", l);
      continue;
    }
    for (const junk of words) {
      warnings.push(`state text, line ${l.no}: "${junk}" is not a kind or a class — ignored.`);
    }
    const existing = byId.get(id);
    const node: StateNodeSpec = existing ?? { id };
    if (label) node.label = label;
    if (kind && kind !== "state") node.kind = kind as StateNodeSpec["kind"];
    if (cls) node.cls = cls;
    if (!existing) {
      byId.set(id, node);
      states.push(node);
    }
    current = node;
  }

  // The mermaid pseudo-states only exist if something used them.
  for (const id of [INITIAL, FINAL_ID]) {
    const node = byId.get(id);
    if (!node) continue;
    if (id === FINAL_ID) node.kind = "final";
  }
  return { states, transitions, warnings };
}

/**
 * A leading `state "Title"` line is what a writer reaches for out of habit
 * (mermaid opens that way). It is not part of the model — `title`/`subtitle`
 * are their own fields — but silently treating it as content is how a header
 * ends up drawn as a step. So: skipped, and said out loud.
 */
function isHeader(text: string): boolean {
  return /^state\b\s*["']/.test(text.trim());
}
