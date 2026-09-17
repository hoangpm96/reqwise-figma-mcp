/**
 * The compact form of an activity diagram.
 *
 *   rankdir LR
 *   lane user "User"
 *   lane pay "Payment Gateway" / external
 *   user: s start "Visits the website"
 *   sys: showtimes "Display available showtimes"
 *   sys: isLogged ? "User logged in?"
 *   sys: cancel err "Cancel the transaction | and release reserved seats"
 *   s > selMovie
 *   selMovie > showtimes "selected movie"
 *   payErr ~> confirm "error message, pay again"
 *
 * `<lane>:` prefixes the step with its owner — the field this diagram exists
 * for, and the one mermaid has no room for. `?` is a decision, `~>` a rework
 * path, `|` splits the label onto a detail line, and `ok`/`err`/`edge` colour
 * a step by meaning.
 */
import { detailBar, lines, unescapeQuotes, splitDetail, takeQuoted, takeWords, unknownLine } from "../diagram/text-util.js";
import type { ActivityEdgeSpec, ActivityNodeSpec, LaneSpec } from "./types.js";

export interface ParsedActivity {
  lanes: LaneSpec[];
  nodes: ActivityNodeSpec[];
  edges: ActivityEdgeSpec[];
  rankdir?: "TB" | "LR";
  warnings: string[];
}

const KINDS = ["start", "end", "decision", "fork", "join", "event", "external", "action", "ext"] as const;
const EDGE = /^([\w.-]+)\s*(~>|>)\s*([\w.-]+)\s*(?:"((?:[^"\\]|\\.)*)")?\s*$/;

export function parseActivityText(src: string): ParsedActivity {
  const lanes: LaneSpec[] = [];
  const nodes: ActivityNodeSpec[] = [];
  const edges: ActivityEdgeSpec[] = [];
  const warnings: string[] = [];
  let rankdir: "TB" | "LR" | undefined;

  for (const l of lines(src)) {
    if (isHeader(l.text)) {
      warnings.push(`activity text, line ${l.no}: a leading "activity" header line is not part of the model — skipped; title/subtitle are their own fields.`);
      continue;
    }
    const word = l.text.split(/\s+/)[0]!.toLowerCase();

    if (word === "rankdir") {
      const dir = l.text.split(/\s+/)[1]?.toUpperCase();
      if (dir === "LR" || dir === "TB") rankdir = dir;
      else warnings.push(`activity text, line ${l.no}: rankdir must be LR or TB.`);
      continue;
    }

    if (word === "lane") {
      const { head, detail } = splitDetail(l.text.slice(4).trim());
      const { value: label, rest } = takeQuoted(head);
      const id = rest.split(/\s+/).filter(Boolean)[0];
      if (!id) {
        unknownLine(warnings, "activity", l);
        continue;
      }
      lanes.push({ id, label: label ?? id, ...(detail ? { detail } : {}) });
      continue;
    }

    const edge = EDGE.exec(l.text);
    if (edge) {
      const [, from, arrow, to, label] = edge as unknown as string[];
      edges.push({
        from: from!,
        to: to!,
        ...(label ? { label: unescapeQuotes(label) } : {}),
        ...(arrow === "~>" ? { kind: "return" as const } : {}),
      });
      continue;
    }

    // A step: `[lane:] id [kind] [cls] "label"`
    const colon = l.text.indexOf(":");
    const hasLane = colon > 0 && !/\s/.test(l.text.slice(0, colon));
    const lane = hasLane ? l.text.slice(0, colon) : undefined;
    const body = hasLane ? l.text.slice(colon + 1).trim() : l.text;
    const { value: label, rest } = takeQuoted(body);
    const words = rest.replace(/\?/g, " decision ");
    const { cls, kind, rest: leftover } = takeWords(words, KINDS);
    const id = leftover.shift();
    if (!id) {
      unknownLine(warnings, "activity", l);
      continue;
    }
    for (const junk of leftover) {
      warnings.push(`activity text, line ${l.no}: "${junk}" is not a kind or a class — ignored.`);
    }
    nodes.push({
      id,
      label: detailBar(label ?? id),
      ...(lane ? { lane } : {}),
      ...(kind && kind !== "action"
        ? { kind: (kind === "ext" ? "external" : kind) as ActivityNodeSpec["kind"] }
        : {}),
      ...(cls ? { cls } : {}),
    });
  }

  return { lanes, nodes, edges, ...(rankdir ? { rankdir } : {}), warnings };
}

/**
 * A leading `activity "Title"` line is what a writer reaches for out of habit
 * (mermaid opens that way). It is not part of the model — `title`/`subtitle`
 * are their own fields — but silently treating it as content is how a header
 * ends up drawn as a step. So: skipped, and said out loud.
 */
function isHeader(text: string): boolean {
  return /^activity\b\s*["']/.test(text.trim());
}
