/**
 * sitemap: an IA tree in → checked, laid-out draw data out.
 *
 * The agent does the thinking (read the spec, work out which pages exist and
 * which one contains which); this module lays the tree out, draws the
 * containment lines and proof-reads the architecture. It never invents a page
 * and never guesses a parent.
 */
import { DEFAULT_MAX_DEPTH, checkSitemap } from "./check.js";
import { emitSitemapDraw, layoutSitemap } from "./layout.js";
import { parseSitemapText } from "./text.js";
import { fillDeep, unresolved } from "../model/policy.js";
import { DEFAULT_FONT } from "../diagram/palette.js";
import { needsWideCoverage } from "../diagram/metrics.js";
import type { PageSpec, SitemapBuild, SitemapSpec } from "./types.js";

export * from "./types.js";
export { parseSitemapText } from "./text.js";
export { checkSitemap, DEFAULT_MAX_DEPTH } from "./check.js";
export { layoutSitemap, reflowSitemap, routeSitemap } from "./layout.js";

export function buildSitemap(spec: SitemapSpec): SitemapBuild {
  const warnings: string[] = [];
  const options = spec.options ?? {};

  // The compact form is an alternative INPUT, not a second model.
  let pages: PageSpec[] = spec.pages ?? [];
  if (spec.text) {
    if (pages.length) {
      warnings.push("Both `text` and `pages` were given — the text won. Pass one or the other.");
    }
    const parsed = parseSitemapText(spec.text);
    pages = parsed.pages;
    for (const w of parsed.warnings) warnings.push(w);
  }

  const maxDepth = Number.isFinite(options.maxDepth) ? Number(options.maxDepth) : DEFAULT_MAX_DEPTH;
  const checked = checkSitemap(pages, maxDepth);
  for (const w of checked.warnings) warnings.push(w);

  // Inter has no CJK/Hangul glyphs: Figma keeps the characters and draws
  // nothing, so the page comes out blank with no error anywhere.
  if (!options.font) {
    const sample: string[] = [];
    for (const p of checked.pages) {
      if (needsWideCoverage(`${p.label ?? ""} ${p.detail ?? ""}`)) sample.push(p.id);
    }
    if (sample.length) {
      warnings.push(
        `Labels on ${sample.slice(0, 6).join(", ")}${sample.length > 6 ? ` and ${sample.length - 6} more` : ""} use CJK/Hangul characters, which ${DEFAULT_FONT} cannot draw — Figma keeps the text but renders it BLANK. Pass options.font with a family that covers them (e.g. "Noto Sans KR", "Noto Sans JP"); check it exists first with figma_read get_fonts.`,
      );
    }
  }

  // The label references the rule; the DRAWING carries its value. Filling in
  // happens between the checker and the layout: the checker reads what was
  // written, the layout needs the text that will actually be measured, and the
  // stored model keeps the reference — which is what lets the page say later
  // which frames depend on this rule.
  const policies = options.policies ?? {};
  const missing = unresolved({ pages: checked.pages }, policies);
  if (missing.length) {
    warnings.push(
      `Nothing defines ${missing.map((n) => `\`@${n}\``).join(", ")}, so ${missing.length > 1 ? "those references are" : "that reference is"} drawn as written. Add ${missing.length > 1 ? "them" : "it"} to options.policies, or drop the \`@\`.`,
    );
  }
  const drawn = fillDeep({ pages: checked.pages }, policies) as { pages: PageSpec[] };

  const laid = layoutSitemap({ ...checked, pages: drawn.pages }, options, spec.subtitle ?? "");
  const title = spec.title || "Sitemap";
  const draw = emitSitemapDraw(
    laid,
    {
      title,
      subtitle: spec.subtitle ?? "",
      name: `Sitemap · ${title}`,
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
      pages: checked.pages,
      ...(spec.options ? { options: spec.options } : {}),
    },
    warnings,
    stats: {
      pages: checked.pages.length,
      leaves: laid.leaves,
      depth: laid.depth,
      sections: laid.sections,
      w: draw.w,
      h: draw.h,
    },
  };
}
