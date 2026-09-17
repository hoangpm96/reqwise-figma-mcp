/**
 * Shared bits of the compact text front ends.
 *
 * Why they exist: a diagram spec in JSON is ~78% punctuation, field names and
 * ids the caller has to invent. The model that writes it pays for every one of
 * those tokens, and the ids and `messages: [...]` id-lists are where the
 * mistakes actually happen. A line-oriented form says the same thing in ~2-3x
 * fewer tokens, and the ids can be generated.
 *
 * House rule, inherited from mermaid.ts: a line that is not understood is
 * REPORTED, never silently dropped. A diagram that quietly lost a step is
 * worse than one that failed to parse.
 */

export interface TextLine {
  /** The line with comments and trailing space removed. */
  text: string;
  /** Leading spaces/tabs, so a parser can tell a child line from a parent. */
  indent: number;
  /** 1-based, for the warning message. */
  no: number;
}

/** Split a source into meaningful lines: comments and blanks gone. */
export function lines(src: string): TextLine[] {
  const out: TextLine[] = [];
  src.split("\n").forEach((raw, i) => {
    const noComment = stripComment(raw);
    const text = noComment.trim();
    if (!text) return;
    out.push({ text, indent: noComment.length - noComment.trimStart().length, no: i + 1 });
  });
  return out;
}

/** `#` and mermaid's `%%` both start a comment; neither works inside a quote. */
export function stripComment(line: string): string {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '"') quoted = !quoted;
    if (quoted) continue;
    if (c === "#") return line.slice(0, i);
    if (c === "%" && line[i + 1] === "%") return line.slice(0, i);
  }
  return line;
}

/**
 * Pull the first "quoted string" out of a line, returning it and what is left.
 * Labels are quoted because they contain the words the business uses, spaces
 * and colons included.
 */
export function takeQuoted(text: string): { value?: string; rest: string } {
  // `\"` inside the label: a step really can be called `Show "Seats
  // unavailable"`, and a naive [^"]* stopped at the inner quote, silently
  // truncating the label AND leaving the tail to be read as another step.
  const m = /"((?:[^"\\]|\\.)*)"/.exec(text);
  if (!m) return { rest: text };
  return {
    value: unescapeQuotes(m[1] ?? ""),
    rest: (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim(),
  };
}

/** `\"` → `"`, `\\` → `\`. */
export function unescapeQuotes(text: string): string {
  return text.replace(/\\(["\\])/g, "$1");
}

/** `label | second line` becomes the two-line label the layouts expect. */
export function detailBar(label: string): string {
  return label.includes("|")
    ? label
        .split("|")
        .map((p) => p.trim())
        .join("\n")
    : label;
}

/** `... / a trailing note` → the `detail` field, and the head of the line. */
export function splitDetail(text: string): { head: string; detail?: string } {
  const i = text.indexOf(" / ");
  if (i < 0) return { head: text.trim() };
  return { head: text.slice(0, i).trim(), detail: text.slice(i + 3).trim() || undefined };
}

const CLS: Record<string, "happy" | "error" | "edge" | "plain"> = {
  ok: "happy",
  happy: "happy",
  err: "error",
  error: "error",
  edge: "edge",
  plain: "plain",
};

/**
 * Pull known bare words out of a line: `ok`/`err`/`edge`/`plain` for the class
 * and whatever the caller lists as kinds. Returns what it found plus the words
 * it did not recognise, so the parser can report them.
 */
export function takeWords(
  text: string,
  kinds: readonly string[],
): { cls?: "happy" | "error" | "edge" | "plain"; kind?: string; rest: string[]; } {
  const words = text.split(/\s+/).filter(Boolean);
  let cls: "happy" | "error" | "edge" | "plain" | undefined;
  let kind: string | undefined;
  const rest: string[] = [];
  for (const w of words) {
    const bare = w.replace(/^!/, "");
    if (CLS[bare] && !cls) {
      cls = CLS[bare];
      continue;
    }
    if (kinds.includes(bare) && !kind) {
      kind = bare;
      continue;
    }
    rest.push(w);
  }
  return { ...(cls ? { cls } : {}), ...(kind ? { kind } : {}), rest };
}

export function unknownLine(warnings: string[], kind: string, l: TextLine): void {
  warnings.push(`${kind} text, line ${l.no}: not understood, skipped — ${l.text}`);
}
