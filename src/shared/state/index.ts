/**
 * state: a machine in → checked, laid-out draw data out.
 *
 * The agent does the thinking (read the spec, work out which values the
 * entity can hold, what moves it between them, what has to be true first);
 * this module lays it out, routes the transitions and proof-reads the machine.
 * It never invents a state and never guesses a trigger.
 */
import { parseStateText } from "./text.js";
import { fillDeep, unresolved } from "../model/policy.js";
import { checkState } from "./check.js";
import { emitStateDraw, layoutState, stateBody, transitionLabel } from "./layout.js";
import { DEFAULT_FONT } from "../diagram/palette.js";
import { needsWideCoverage } from "../diagram/metrics.js";
import type { StateBuild, StateSpec } from "./types.js";

export * from "./types.js";
export { parseStateText } from "./text.js";
export { checkState } from "./check.js";
export { layoutState, reflowState, stateBody, transitionLabel } from "./layout.js";

export function buildState(spec: StateSpec): StateBuild {
  const warnings: string[] = [];
  const options = spec.options ?? {};
  // The compact form is an alternative INPUT, not a second model.
  let states = spec.states ?? [];
  let transitions = spec.transitions ?? [];
  if (typeof spec.text === "string" && spec.text.trim()) {
    if (states.length) {
      warnings.push("Both `text` and `states` were given — the text won. Pass one or the other.");
    }
    const parsed = parseStateText(spec.text);
    states = parsed.states;
    transitions = parsed.transitions;
    for (const w of parsed.warnings) warnings.push(w);
  }

  const checked = checkState(states, transitions);
  for (const w of checked.warnings) warnings.push(w);

  // Inter has no CJK/Hangul glyphs: Figma keeps the characters and draws
  // nothing, so the state comes out blank with no error anywhere.
  if (!options.font) {
    const sample: string[] = [];
    for (const s of checked.states) {
      if (needsWideCoverage(`${s.label ?? ""} ${stateBody(s).join(" ")}`)) sample.push(s.id);
    }
    for (const t of checked.transitions) {
      if (needsWideCoverage(transitionLabel(t))) sample.push(`${t.from}→${t.to}`);
    }
    if (sample.length) {
      warnings.push(
        `Labels on ${sample.slice(0, 6).join(", ")}${sample.length > 6 ? ` and ${sample.length - 6} more` : ""} use CJK/Hangul characters, which ${DEFAULT_FONT} cannot draw — Figma keeps the text but renders it BLANK. Pass options.font with a family that covers them (e.g. "Noto Sans KR", "Noto Sans JP"); check it exists first with figma_read get_fonts.`,
      );
    }
  }

    // The label references the rule; the DRAWING carries its value. Filling in
  // happens here, between the checker and the layout: the checker reads what
  // was written, the layout needs the text that will actually be measured and
  // drawn, and the stored model keeps the reference — which is what lets the
  // page say later which frames depend on this rule.
  const policies = options.policies ?? {};
  const missing = unresolved({ states: checked.states, transitions: checked.transitions }, policies);
  if (missing.length) {
    warnings.push(
      `Nothing defines ${missing.map((n) => `\`@${n}\``).join(", ")}, so ${missing.length > 1 ? "those references are" : "that reference is"} drawn as written. Add ${missing.length > 1 ? "them" : "it"} to options.policies, or drop the \`@\`.`,
    );
  }
  const drawn = fillDeep({ states: checked.states, transitions: checked.transitions }, policies);

  const laid = layoutState(drawn.states, drawn.transitions, options, spec.subtitle ?? "");
  const title = spec.title || "State machine";
  const draw = emitStateDraw(
    laid,
    {
      title,
      subtitle: spec.subtitle ?? "",
      name: `State · ${title}`,
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
      states: checked.states,
      transitions: checked.transitions,
      ...(spec.options ? { options: spec.options } : {}),
    },
    warnings,
    stats: {
      states: checked.states.length,
      transitions: checked.transitions.length,
      finals: laid.finals,
      selfTransitions: laid.selfTransitions,
      w: draw.w,
      h: draw.h,
    },
  };
}
