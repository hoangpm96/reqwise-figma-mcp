/**
 * userflow: graph in → checked, laid-out draw data out.
 *
 * The agent does the thinking (read the spec/PRD, enumerate the screens, the
 * happy path, the error and edge cases) and hands the result over as a graph.
 * This module draws it and proof-reads its shape; it never invents a node.
 */
import { checkGraph } from "./check.js";
import { fillDeep, unresolved } from "../model/policy.js";
import { emitDrawData, layoutGraph } from "./layout.js";
import { DEFAULT_FONT } from "../diagram/palette.js";
import { needsWideCoverage } from "../diagram/metrics.js";
import { parseMermaid } from "./mermaid.js";
import type { UserflowBuild, UserflowSpec } from "./types.js";

export * from "./types.js";
export { parseMermaid } from "./mermaid.js";
export { checkGraph } from "./check.js";
export { PALETTE } from "../diagram/palette.js";

export function buildUserflow(spec: UserflowSpec): UserflowBuild {
  const warnings: string[] = [];
  const options = spec.options ?? {};

  let nodes = spec.nodes ?? [];
  let edges = spec.edges ?? [];
  let rankdir = options.rankdir ?? "TB";

  if (spec.mermaid) {
    if (spec.nodes?.length || spec.edges?.length) {
      warnings.push(
        "Both `mermaid` and `nodes`/`edges` were given — the mermaid source won. Pass one or the other.",
      );
    }
    const parsed = parseMermaid(spec.mermaid);
    nodes = parsed.nodes;
    edges = parsed.edges;
    if (!options.rankdir && parsed.rankdir) rankdir = parsed.rankdir;
    for (const w of parsed.warnings) warnings.push(w);
  }

  const checked = checkGraph(nodes, edges);
  for (const w of checked.warnings) warnings.push(w);

  // Inter has no CJK/Hangul glyphs: Figma keeps the characters but draws
  // nothing, so the box comes out blank with no error anywhere. Caught here,
  // before a flow is drawn that looks empty on the canvas.
  if (!options.font) {
    const sample: string[] = [];
    for (const n of checked.nodes) {
      if (needsWideCoverage(`${n.label} ${n.detail ?? ""}`)) sample.push(n.id);
    }
    for (const e of checked.edges) {
      if (e.label && needsWideCoverage(e.label)) sample.push(`${e.from}→${e.to}`);
    }
    if (sample.length) {
      warnings.push(
        `Labels on ${sample.slice(0, 6).join(", ")}${sample.length > 6 ? ` and ${sample.length - 6} more` : ""} use CJK/Hangul characters, which ${DEFAULT_FONT} cannot draw — Figma keeps the text but renders it BLANK. Pass options.font with a family that covers them (e.g. "Noto Sans KR", "Noto Sans JP"); check it exists first with figma_read get_fonts. Box sizes are calibrated for ${DEFAULT_FONT}, so expect them to be a little loose.`,
      );
    }
  }

    // The label references the rule; the DRAWING carries its value. Filling in
  // happens here, between the checker and the layout: the checker reads what
  // was written, the layout needs the text that will actually be measured and
  // drawn, and the stored model keeps the reference — which is what lets the
  // page say later which frames depend on this rule.
  const policies = options.policies ?? {};
  const missing = unresolved({ nodes: checked.nodes, edges: checked.edges }, policies);
  if (missing.length) {
    warnings.push(
      `Nothing defines ${missing.map((n) => `\`@${n}\``).join(", ")}, so ${missing.length > 1 ? "those references are" : "that reference is"} drawn as written. Add ${missing.length > 1 ? "them" : "it"} to options.policies, or drop the \`@\`.`,
    );
  }
  const drawn = fillDeep({ nodes: checked.nodes, edges: checked.edges }, policies);

  const laid = layoutGraph(drawn.nodes, drawn.edges, rankdir);
  const title = spec.title || "Userflow";
  const draw = emitDrawData(
    laid,
    {
      title,
      subtitle: spec.subtitle ?? "",
      name: `Userflow · ${title}`,
      x: spec.x ?? 0,
      y: spec.y ?? 0,
      ...(spec.parentId ? { parentId: spec.parentId } : {}),
    },
    { ...options, rankdir },
  );

  return {
    draw,
    model: {
      title,
      ...(spec.subtitle ? { subtitle: spec.subtitle } : {}),
      nodes: checked.nodes,
      edges: checked.edges,
      // rankdir may have come from the mermaid header, so it is folded back
      // into options — the model has to stand on its own without the source.
      options: { ...options, rankdir },
    },
    warnings,
    stats: {
      nodes: checked.nodes.length,
      edges: checked.edges.length,
      returnEdges: laid.edges.filter((e) => e.back || e.kind === "return").length,
      w: draw.w,
      h: draw.h,
    },
  };
}
