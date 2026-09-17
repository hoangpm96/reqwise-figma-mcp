/**
 * The proof-reading half of the ERD tool.
 *
 * A data model fails in ways that only hurt later: a table nobody can address
 * a row of, a foreign key pointing at a column that does not exist, a
 * many-to-many that quietly needs a table nobody has drawn. Those are the
 * findings; they are reported before anything is drawn, because fixing the
 * model is cheap now and expensive after the migration.
 */
import { adjacency, firstLine, list } from "../diagram/graph.js";
import type { ErdEntitySpec, ErdRelationSpec } from "./types.js";

export interface ErdCheck {
  warnings: string[];
  entities: ErdEntitySpec[];
  relations: ErdRelationSpec[];
}

export function checkErd(
  rawEntities: ErdEntitySpec[],
  rawRelations: ErdRelationSpec[],
): ErdCheck {
  const warnings: string[] = [];

  const entities: ErdEntitySpec[] = [];
  const byId = new Map<string, ErdEntitySpec>();
  for (const e of rawEntities) {
    if (byId.has(e.id)) {
      warnings.push(`Duplicate entity id "${e.id}" — the later declaration was dropped.`);
      continue;
    }
    byId.set(e.id, e);
    entities.push(e);
  }

  const relations: ErdRelationSpec[] = [];
  for (const r of rawRelations) {
    const missing = [!byId.has(r.from) ? r.from : null, !byId.has(r.to) ? r.to : null].filter(
      (v): v is string => v !== null,
    );
    if (missing.length) {
      warnings.push(
        `Relationship ${r.from} → ${r.to} names undeclared table ${missing.map((m) => `"${m}"`).join(" and ")} — dropped. Declare the table or fix the id.`,
      );
      continue;
    }
    relations.push(r);
  }

  // ---- per table ----
  const noKey: string[] = [];
  const dupes: string[] = [];
  for (const e of entities) {
    const attrs = e.attributes ?? [];
    if (!attrs.length) {
      warnings.push(
        `Table "${e.id}" (${firstLine(e.name)}) has no columns — either it is a placeholder, or nobody has decided what it stores yet.`,
      );
    }
    // An external table's key lives in somebody else's schema; not our finding.
    if (!e.external && !attrs.some((a) => a.key === "pk" || a.key === "pfk")) {
      noKey.push(`"${e.id}"`);
    }
    const seen = new Set<string>();
    for (const a of attrs) {
      const name = a.name.trim().toLowerCase();
      if (seen.has(name)) dupes.push(`"${e.id}.${a.name}"`);
      seen.add(name);
    }
  }
  if (noKey.length) {
    warnings.push(
      `No primary key on ${list(noKey)} — there is no way to address a single row, which breaks updates, joins and every audit trail. Mark the key column with key:"pk".`,
    );
  }
  if (dupes.length) {
    warnings.push(`Duplicate column name: ${list(dupes)}. One of them is a typo or a leftover.`);
  }

  // ---- per relationship ----
  const badField: string[] = [];
  const noField: string[] = [];
  const typeClash: string[] = [];
  const manyToMany: string[] = [];
  for (const r of relations) {
    const from = byId.get(r.from)!;
    const to = byId.get(r.to)!;
    const fromAttr = r.fromField ? findAttr(from, r.fromField) : undefined;
    const toAttr = r.toField ? findAttr(to, r.toField) : undefined;

    if (r.fromField && !fromAttr) badField.push(`"${r.from}.${r.fromField}"`);
    if (r.toField && !toAttr) badField.push(`"${r.to}.${r.toField}"`);
    // Either end missing is enough: the line then attaches mid-box at that
    // end, and the text parser already reports a relationship with one column
    // named — the JSON form should not be quieter than the text one.
    if (!r.fromField || !r.toField) noField.push(`${r.from} → ${r.to}`);

    if (fromAttr?.type && toAttr?.type && normalizeType(fromAttr.type) !== normalizeType(toAttr.type)) {
      typeClash.push(
        `${r.from}.${fromAttr.name} (${fromAttr.type}) ↔ ${r.to}.${toAttr.name} (${toAttr.type})`,
      );
    }

    if (isMany(r.fromCard ?? "one") && isMany(r.toCard ?? "many")) {
      manyToMany.push(`${r.from} ↔ ${r.to}`);
    }
  }
  if (badField.length) {
    warnings.push(
      `Relationship points at a column that does not exist: ${list(badField)}. Add the column, or fix the name — a foreign key to nowhere is a migration that fails at 2am.`,
    );
  }
  if (noField.length) {
    warnings.push(
      `No column named on ${list(noField)} — the line is drawn box-to-box, so the reader cannot see WHICH key implements it. Give fromField/toField.`,
    );
  }
  if (typeClash.length) {
    warnings.push(
      `Foreign key and the key it references have different types: ${list(typeClash)}. One of the two is wrong, and the database will not let you add the constraint.`,
    );
  }
  if (manyToMany.length) {
    warnings.push(
      `Many-to-many with no join table: ${list(manyToMany)}. A relational database cannot store that directly — add the table that holds the pairs (and decide what else it needs: a date, a role, a quantity).`,
    );
  }

  // ---- shape of the whole model ----
  const ids = entities.map((e) => e.id);
  const { out, inbound } = adjacency(ids, relations);
  const orphans = entities
    .filter((e) => !out.get(e.id)!.length && !inbound.get(e.id)!.length)
    .map((e) => `"${e.id}"`);
  if (orphans.length && entities.length > 1) {
    warnings.push(
      `Nothing joins ${list(orphans)} to the rest of the model. Either a relationship is missing, or the table belongs to a different diagram.`,
    );
  }

  const naming = namingStyle(entities);
  if (naming) warnings.push(naming);
  if (!entities.length) warnings.push("The model is empty — nothing to draw.");

  return { warnings, entities, relations };
}

function findAttr(e: ErdEntitySpec, name: string) {
  const want = name.trim().toLowerCase();
  return (e.attributes ?? []).find((a) => a.name.trim().toLowerCase() === want);
}

function isMany(c: string): boolean {
  return c === "many" || c === "zero-many" || c === "one-many";
}

/** `varchar(255)` and `VARCHAR (255)` are the same type; `uuid` and `text` are not. */
function normalizeType(t: string): string {
  return t.toLowerCase().replace(/\s+/g, "");
}

/**
 * snake_case and camelCase in one schema is the kind of thing nobody notices
 * until half the queries need quoting. Reported once, not per column.
 */
function namingStyle(entities: ErdEntitySpec[]): string | null {
  let snake = 0;
  let camel = 0;
  for (const e of entities) {
    for (const a of e.attributes ?? []) {
      if (/_/.test(a.name)) snake++;
      else if (/[a-z][A-Z]/.test(a.name)) camel++;
    }
  }
  if (snake && camel) {
    return `Column names mix snake_case (${snake}) and camelCase (${camel}). Pick one for the whole schema — the mixture is what makes people quote identifiers for ever.`;
  }
  return null;
}
