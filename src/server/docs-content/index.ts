/**
 * figma_docs content. Each section is real, concise markdown that teaches the
 * calling AI the new API surface + the safe-by-default semantics. These are
 * the "error messages teach the AI" philosophy applied to documentation.
 */
import { RULES } from "./rules.md.js";
import { LAYOUT } from "./layout.md.js";
import { API } from "./api.md.js";
import { TOKENS } from "./tokens.md.js";
import { ICONS } from "./icons.md.js";
import { RECIPES } from "./recipes.md.js";
import { STYLE } from "./style.md.js";
import { USERFLOW } from "./userflow.md.js";
import { ACTIVITY } from "./activity.md.js";
import { ERD } from "./erd.md.js";
import { SEQUENCE } from "./sequence.md.js";
import { SITEMAP } from "./sitemap.md.js";
import { STATE } from "./state.md.js";

export const DOC_SECTIONS = {
  rules: RULES,
  layout: LAYOUT,
  api: API,
  tokens: TOKENS,
  icons: ICONS,
  recipes: RECIPES,
  style: STYLE,
  userflow: USERFLOW,
  activity: ACTIVITY,
  erd: ERD,
  sequence: SEQUENCE,
  sitemap: SITEMAP,
  state: STATE,
} as const;

export type DocSection = keyof typeof DOC_SECTIONS;
export const DOC_SECTION_NAMES = Object.keys(DOC_SECTIONS) as DocSection[];

export type DocLevel = "full" | "cheat";

export function getDoc(section: string, level: DocLevel = "full"): string {
  const known = DOC_SECTIONS[section as DocSection];
  if (!known) {
    return (
      `# Unknown docs section "${section}"\n\n` +
      `Available sections: ${DOC_SECTION_NAMES.join(", ")}.\n`
    );
  }
  const text = stripEditionMarkers(known);
  return level === "cheat" ? cheatSheet(section, text) : text;
}

/** Edition markers are for the open-source export, not for the reader. */
function stripEditionMarkers(md: string): string {
  return md.replace(new RegExp("^<!-- @" + "pro:(begin|end) -->\\n", "gm"), "");
}

/**
 * The call shape and nothing else: the `## Shape` block plus the field tables
 * under it, which is all an agent needs when it already knows what it is
 * drawing. Sliced out of the same markdown rather than written twice — a
 * second copy of the field list is a second copy to drift.
 *
 * A section with no `## Shape` heading (the prose ones: rules, style) has no
 * short form, so it comes back whole with a line saying so.
 */
function cheatSheet(section: string, full: string): string {
  const start = full.indexOf("\n## Shape");
  if (start < 0) {
    return `${full}\n\n> (No short form for "${section}" — this section is prose, not a call shape.)\n`;
  }
  const head = full.slice(0, full.indexOf("\n", 1) + 1);
  const rest = full.slice(start + 1);
  // Keep `## Shape` and the `### field` tables that follow it; stop at the
  // next top-level heading, which is where the prose starts again.
  const nextTop = rest.indexOf("\n## ", 1);
  const body = nextTop < 0 ? rest : rest.slice(0, nextTop + 1);
  return (
    `${head}\n${body}\n` +
    `> Short form (\`level:"cheat"\`). The findings this kind reports, the notation traps and ` +
    `the layout notes are in the full section: figma_docs({ section: "${section}" }).\n`
  );
}
