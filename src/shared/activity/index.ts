/**
 * activity: a business process in → checked, laid-out draw data out.
 *
 * The agent does the thinking (read the spec, work out the steps, who performs
 * each one, what is handed over at every lane change, where it can fail); this
 * module lays it out in lanes, routes the handoffs and proof-reads the process.
 * It never invents a step and never guesses an owner.
 */
import { parseActivityText } from "./text.js";
import { fillDeep, unresolved } from "../model/policy.js";
import { checkActivity } from "./check.js";
import { emitActivityDraw, layoutActivity } from "./layout.js";
import { DEFAULT_FONT } from "../diagram/palette.js";
import { needsWideCoverage } from "../diagram/metrics.js";
import type { ActivityBuild, ActivitySpec } from "./types.js";

export * from "./types.js";
export { parseActivityText } from "./text.js";
export { checkActivity, UNASSIGNED_LANE } from "./check.js";
export { reflowActivity, routeActivity } from "./route.js";

export function buildActivity(spec: ActivitySpec): ActivityBuild {
  const warnings: string[] = [];
  const options = spec.options ?? {};
  // The compact form is an alternative INPUT, not a second model.
  let lanes = spec.lanes ?? [];
  let nodes = spec.nodes ?? [];
  let edges = spec.edges ?? [];
  let rankdir = options.rankdir;
  if (spec.text) {
    if (nodes.length) {
      warnings.push("Both `text` and `nodes` were given — the text won. Pass one or the other.");
    }
    const parsed = parseActivityText(spec.text);
    lanes = parsed.lanes;
    nodes = parsed.nodes;
    edges = parsed.edges;
    if (!rankdir && parsed.rankdir) rankdir = parsed.rankdir;
    for (const w of parsed.warnings) warnings.push(w);
  }

  const checked = checkActivity(lanes, nodes, edges);
  for (const w of checked.warnings) warnings.push(w);

  // Inter has no CJK/Hangul glyphs: Figma keeps the characters and draws
  // nothing, so the step comes out blank with no error anywhere.
  if (!options.font) {
    const sample: string[] = [];
    for (const l of checked.lanes) if (needsWideCoverage(`${l.label} ${l.detail ?? ""}`)) sample.push(`lane ${l.id}`);
    for (const n of checked.nodes) if (needsWideCoverage(`${n.label} ${n.detail ?? ""}`)) sample.push(n.id);
    for (const e of checked.edges) if (e.label && needsWideCoverage(e.label)) sample.push(`${e.from}→${e.to}`);
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
  const missing = unresolved({ lanes: checked.lanes, nodes: checked.nodes, edges: checked.edges }, policies);
  if (missing.length) {
    warnings.push(
      `Nothing defines ${missing.map((n) => `\`@${n}\``).join(", ")}, so ${missing.length > 1 ? "those references are" : "that reference is"} drawn as written. Add ${missing.length > 1 ? "them" : "it"} to options.policies, or drop the \`@\`.`,
    );
  }
  const drawn = fillDeep({ lanes: checked.lanes, nodes: checked.nodes, edges: checked.edges }, policies);

  const laid = layoutActivity(drawn.lanes, drawn.nodes, drawn.edges, { ...options, ...(rankdir ? { rankdir } : {}) }, spec.subtitle ?? "");
  const title = spec.title || "Activity";
  const draw = emitActivityDraw(
    laid,
    {
      title,
      subtitle: spec.subtitle ?? "",
      name: `Activity · ${title}`,
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
      lanes: checked.lanes,
      nodes: checked.nodes,
      edges: checked.edges,
      // rankdir may have come from the text's own header line, so it is folded
      // back into options — the model has to stand on its own without the text.
      ...(spec.options || rankdir ? { options: { ...options, ...(rankdir ? { rankdir } : {}) } } : {}),
    },
    warnings,
    stats: {
      lanes: checked.lanes.length,
      nodes: checked.nodes.length,
      edges: checked.edges.length,
      handoffs: laid.handoffs,
      returnEdges: laid.returnEdges,
      w: draw.w,
      h: draw.h,
    },
  };
}
