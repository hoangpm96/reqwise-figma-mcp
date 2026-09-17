/**
 * The compact form of a data model.
 *
 *   users happy / core.auth
 *     id uuid pk!
 *     email varchar(255)!
 *   bookings happy
 *     id uuid pk!
 *     user_id uuid fk!
 *   psp_transactions ext / payment gateway
 *     reference varchar(64)!
 *   users.id 1-* bookings.user_id "books"
 *   bookings.id 1=+ booking_seats.booking_id "holds"
 *
 * `!` is NOT NULL. Cardinality is one character a side — `1` one, `?` zero-one,
 * `*` zero-many, `+` one-many — and the line between them is `-` normally, `=`
 * for an identifying relationship. Mermaid's crow's-foot tokens (`||--o{`) are
 * accepted too, because a model reaches for them by habit; unlike mermaid's,
 * this form NAMES THE COLUMNS, which is the whole point of an ERD line.
 */
import { lines, splitDetail, takeQuoted, unescapeQuotes, unknownLine } from "../diagram/text-util.js";
import type { ErdAttributeSpec, Cardinality, ErdEntitySpec, ErdRelationSpec } from "./types.js";

export interface ParsedErd {
  entities: ErdEntitySpec[];
  relations: ErdRelationSpec[];
  warnings: string[];
}

const SHORT: Record<string, Cardinality> = {
  "1": "one",
  "?": "zero-one",
  "*": "zero-many",
  "+": "one-many",
};
const MERMAID: Record<string, Cardinality> = {
  "||": "one",
  "|o": "zero-one",
  "o|": "zero-one",
  "}o": "zero-many",
  "o{": "zero-many",
  "}|": "one-many",
  "|{": "one-many",
};

// The from-side card may be left off (`-o{`, `1-*` both read fine); it
// defaults to one, which is what it is in almost every relationship.
const REL =
  /^([A-Za-z_][\w]*)(?:\.([\w]+))?\s+(\|\||\|o|\}o|\}\||[1?*+])?(--|==|\.\.|-|=)(\|\||o\||o\{|\|\{|[1?*+])\s+([A-Za-z_][\w]*)(?:\.([\w]+))?\s*(?::\s*(.+)|"((?:[^"\\]|\\.)*)")?\s*$/;
// The type is free text on purpose — `uuid`, `varchar(255)`, and
// `enum(held|paying|paid)`, whose values are what a state diagram of the
// same table has to agree with.
const ATTR = /^([\w]+)\s+([\w()\\,|]+)(?:\s+(pk|fk|pfk))?\s*(!)?$/i;
const KEY_ONLY = /^([\w]+)\s+(pk|fk|pfk)\s*(!)?$/i;

export function parseErdText(src: string): ParsedErd {
  const entities: ErdEntitySpec[] = [];
  const relations: ErdRelationSpec[] = [];
  const warnings: string[] = [];
  let current: ErdEntitySpec | undefined;

  for (const l of lines(src)) {
    if (isHeader(l.text)) {
      warnings.push(`erd text, line ${l.no}: a leading "erd" header line is not part of the model — skipped; title/subtitle are their own fields.`);
      continue;
    }
    const rel = REL.exec(l.text);
    if (rel) {
      const [, from, fromField, fc, line, tc, to, toField, label1, label2] = rel as unknown as string[];
      const fromCard = fc ? (SHORT[fc] ?? MERMAID[fc]) : undefined;
      const toCard = SHORT[tc!] ?? MERMAID[tc!];
      const label = unescapeQuotes((label1 ?? label2 ?? "").trim().replace(/^"|"$/g, ""));
      if (!fromField || !toField) {
        warnings.push(
          `erd text, line ${l.no}: the relationship names no columns (write \`${from}.<column> 1-* ${to}.<column>\`). Without them the line attaches to the middle of a box and nobody can check it against the schema.`,
        );
      }
      relations.push({
        from: from!,
        to: to!,
        ...(fromField ? { fromField } : {}),
        ...(toField ? { toField } : {}),
        ...(fromCard && fromCard !== "one" ? { fromCard } : {}),
        ...(toCard ? { toCard } : {}),
        ...(label ? { label } : {}),
        ...(line === "=" || line === "==" ? { identifying: true } : {}),
      });
      continue;
    }

    // Indented under an entity → one of its columns.
    if (l.indent > 0 && current) {
      // KEY_ONLY first: ATTR's free-text type also matches `pk`, so `id pk!`
      // read as a column of TYPE pk — no key badge, and a false "no primary
      // key" finding.
      const keyOnly = KEY_ONLY.exec(l.text);
      const m = keyOnly ?? ATTR.exec(l.text);
      if (!m) {
        unknownLine(warnings, "erd", l);
        continue;
      }
      const isKeyOnly = keyOnly !== null;
      const attr: ErdAttributeSpec = isKeyOnly
        ? {
            name: m[1]!,
            key: m[2]!.toLowerCase() as ErdAttributeSpec["key"],
            ...(m[3] ? { required: true } : {}),
          }
        : {
            name: m[1]!,
            type: m[2]!,
            ...(m[3] ? { key: m[3].toLowerCase() as ErdAttributeSpec["key"] } : {}),
            ...(m[4] ? { required: true } : {}),
          };
      (current.attributes ??= []).push(attr);
      continue;
    }

    // Otherwise: a new table.
    const { head, detail } = splitDetail(l.text);
    const { value: quoted, rest } = takeQuoted(head);
    const words = (quoted ? rest : head).split(/\s+/).filter(Boolean);
    const name = words.shift();
    if (!name) {
      unknownLine(warnings, "erd", l);
      continue;
    }
    let cls: ErdEntitySpec["cls"] | undefined;
    let external = false;
    for (const w of words) {
      const bare = w.toLowerCase();
      if (bare === "ext" || bare === "external") external = true;
      else if (bare === "happy" || bare === "edge" || bare === "error" || bare === "plain") cls = bare;
      else warnings.push(`erd text, line ${l.no}: "${w}" is not a class (happy|edge|error|plain) or \`ext\` — ignored.`);
    }
    current = {
      id: name,
      name: quoted ?? name,
      attributes: [],
      ...(detail ? { detail } : {}),
      ...(cls ? { cls } : {}),
      ...(external ? { external: true } : {}),
    };
    entities.push(current);
  }

  return { entities, relations, warnings };
}

/**
 * A leading `erd "Title"` line is what a writer reaches for out of habit
 * (mermaid opens that way). It is not part of the model — `title`/`subtitle`
 * are their own fields — but silently treating it as content is how a header
 * ends up drawn as a step. So: skipped, and said out loud.
 */
function isHeader(text: string): boolean {
  return /^erd\b\s*["']/.test(text.trim());
}
