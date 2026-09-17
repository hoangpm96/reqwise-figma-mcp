/**
 * erd: a data model in → checked, laid-out draw data out.
 *
 * The tables, their columns and the keys that join them come from YOUR reading
 * of the spec or the schema. This module places them, attaches each line to the
 * column that implements it, and proof-reads the model.
 */
import { parseErdText } from "./text.js";
import { fillDeep, unresolved } from "../model/policy.js";
import { checkErd } from "./check.js";
import { emitErdDraw, layoutErd } from "./layout.js";
import { DEFAULT_FONT } from "../diagram/palette.js";
import { needsWideCoverage } from "../diagram/metrics.js";
import type { ErdBuild, ErdSpec } from "./types.js";

export * from "./types.js";
export { parseErdText } from "./text.js";
export { checkErd } from "./check.js";
export { layoutErd } from "./layout.js";

export function buildErd(spec: ErdSpec): ErdBuild {
  const warnings: string[] = [];
  const options = spec.options ?? {};
  // The compact form is an alternative INPUT, not a second model: it parses to
  // the same entities/relations and is checked identically.
  let entities = spec.entities ?? [];
  let relations = spec.relations ?? [];
  if (typeof spec.text === "string" && spec.text.trim()) {
    // `relations` counts too: the text brings its own, so a relations list
    // passed alongside it was being thrown away without a word.
    if (entities.length || relations.length) {
      const given = [entities.length ? "`entities`" : "", relations.length ? "`relations`" : ""]
        .filter(Boolean)
        .join("/");
      warnings.push(`Both \`text\` and ${given} were given — the text won. Pass one or the other.`);
    }
    const parsed = parseErdText(spec.text);
    entities = parsed.entities;
    relations = parsed.relations;
    for (const w of parsed.warnings) warnings.push(w);
  }

  const checked = checkErd(entities, relations);
  for (const w of checked.warnings) warnings.push(w);

  if (!options.font) {
    const sample: string[] = [];
    for (const e of checked.entities) {
      if (needsWideCoverage(`${e.name} ${e.detail ?? ""}`)) sample.push(e.id);
      for (const a of e.attributes ?? []) {
        if (needsWideCoverage(`${a.name} ${a.type ?? ""}`)) sample.push(`${e.id}.${a.name}`);
      }
    }
    for (const r of checked.relations) {
      if (r.label && needsWideCoverage(r.label)) sample.push(`${r.from}→${r.to}`);
    }
    if (sample.length) {
      warnings.push(
        `Labels on ${sample.slice(0, 6).join(", ")}${sample.length > 6 ? ` and ${sample.length - 6} more` : ""} use CJK/Hangul characters, which ${DEFAULT_FONT} cannot draw — Figma keeps the text but renders it BLANK. Pass options.font with a family that covers them (e.g. "Noto Sans KR", "Noto Sans JP").`,
      );
    }
  }

    // The label references the rule; the DRAWING carries its value. Filling in
  // happens here, between the checker and the layout: the checker reads what
  // was written, the layout needs the text that will actually be measured and
  // drawn, and the stored model keeps the reference — which is what lets the
  // page say later which frames depend on this rule.
  const policies = options.policies ?? {};
  const missing = unresolved({ entities: checked.entities, relations: checked.relations }, policies);
  if (missing.length) {
    warnings.push(
      `Nothing defines ${missing.map((n) => `\`@${n}\``).join(", ")}, so ${missing.length > 1 ? "those references are" : "that reference is"} drawn as written. Add ${missing.length > 1 ? "them" : "it"} to options.policies, or drop the \`@\`.`,
    );
  }
  const drawn = fillDeep({ entities: checked.entities, relations: checked.relations }, policies);

  const laid = layoutErd(drawn.entities, drawn.relations, options, spec.subtitle ?? "");
  const title = spec.title || "Data model";
  const draw = emitErdDraw(
    laid,
    {
      title,
      subtitle: spec.subtitle ?? "",
      name: `ERD · ${title}`,
      x: spec.x ?? 0,
      y: spec.y ?? 0,
      ...(spec.parentId ? { parentId: spec.parentId } : {}),
    },
    options,
  );

  const attributes = checked.entities.reduce((n, e) => n + (e.attributes ?? []).length, 0);
  return {
    draw,
    model: {
      title,
      ...(spec.subtitle ? { subtitle: spec.subtitle } : {}),
      entities: checked.entities,
      relations: checked.relations,
      ...(spec.options ? { options: spec.options } : {}),
    },
    warnings,
    stats: {
      entities: checked.entities.length,
      attributes,
      relations: checked.relations.length,
      manyToMany: laid.manyToMany,
      w: draw.w,
      h: draw.h,
    },
  };
}
