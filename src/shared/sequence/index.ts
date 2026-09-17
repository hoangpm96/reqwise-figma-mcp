/**
 * sequence: an exchange in → checked, laid-out draw data out.
 *
 * The participants, the order of the messages and what each one carries come
 * from YOUR reading of the spec or the API contract. This module places them
 * and proof-reads the exchange; it never invents a message.
 */
import { checkSequence } from "./check.js";
import { fillDeep, unresolved } from "../model/policy.js";
import { parseSequenceText } from "./text.js";
import { emitSequenceDraw, layoutSequence } from "./layout.js";
import { DEFAULT_FONT } from "../diagram/palette.js";
import { needsWideCoverage } from "../diagram/metrics.js";
import type { SequenceBuild, SequenceSpec } from "./types.js";

export * from "./types.js";
export { checkSequence } from "./check.js";
export { layoutSequence } from "./layout.js";
export { parseSequenceText } from "./text.js";

export function buildSequence(spec: SequenceSpec): SequenceBuild {
  const warnings: string[] = [];
  const options = spec.options ?? {};

  // The compact form is an alternative INPUT, not a second model: it parses to
  // the same participants/messages/fragments and is checked identically.
  let participants = spec.participants ?? [];
  let messages = spec.messages ?? [];
  let fragments = spec.fragments ?? [];
  if (spec.text) {
    if (participants.length || messages.length) {
      warnings.push(
        "Both `text` and `participants`/`messages` were given — the text won. Pass one or the other.",
      );
    }
    const parsed = parseSequenceText(spec.text);
    participants = parsed.participants;
    messages = parsed.messages;
    fragments = parsed.fragments;
    for (const w of parsed.warnings) warnings.push(w);
  }

  const checked = checkSequence(participants, messages, fragments);
  for (const w of checked.warnings) warnings.push(w);

  if (!options.font) {
    const sample: string[] = [];
    for (const p of checked.participants) {
      if (needsWideCoverage(`${p.name} ${p.detail ?? ""}`)) sample.push(p.id);
    }
    for (const m of checked.messages) {
      if (needsWideCoverage(`${m.label} ${m.note ?? ""}`)) sample.push(m.id);
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
  const missing = unresolved({ participants: checked.participants, messages: checked.messages, fragments: checked.fragments }, policies);
  if (missing.length) {
    warnings.push(
      `Nothing defines ${missing.map((n) => `\`@${n}\``).join(", ")}, so ${missing.length > 1 ? "those references are" : "that reference is"} drawn as written. Add ${missing.length > 1 ? "them" : "it"} to options.policies, or drop the \`@\`.`,
    );
  }
  const drawn = fillDeep({ participants: checked.participants, messages: checked.messages, fragments: checked.fragments }, policies);

  const laid = layoutSequence(drawn.participants, drawn.messages, drawn.fragments, options, spec.subtitle ?? "");
  const title = spec.title || "Sequence";
  const draw = emitSequenceDraw(
    laid,
    {
      title,
      subtitle: spec.subtitle ?? "",
      name: `Sequence · ${title}`,
      x: spec.x ?? 0,
      y: spec.y ?? 0,
      ...(spec.parentId ? { parentId: spec.parentId } : {}),
    },
    options,
  );

  return {
    draw,
    model: {
      title,
      ...(spec.subtitle ? { subtitle: spec.subtitle } : {}),
      participants: checked.participants,
      messages: checked.messages,
      fragments: checked.fragments,
      ...(spec.options ? { options: spec.options } : {}),
    },
    warnings,
    stats: {
      participants: checked.participants.length,
      messages: checked.messages.length,
      returns: laid.returns,
      fragments: checked.fragments.length,
      w: draw.w,
      h: draw.h,
    },
  };
}
