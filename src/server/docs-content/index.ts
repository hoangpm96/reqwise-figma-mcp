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

export const DOC_SECTIONS = {
  rules: RULES,
  layout: LAYOUT,
  api: API,
  tokens: TOKENS,
  icons: ICONS,
  recipes: RECIPES,
} as const;

export type DocSection = keyof typeof DOC_SECTIONS;
export const DOC_SECTION_NAMES = Object.keys(DOC_SECTIONS) as DocSection[];

export function getDoc(section: string): string {
  const known = DOC_SECTIONS[section as DocSection];
  if (known) return known;
  return (
    `# Unknown docs section "${section}"\n\n` +
    `Available sections: ${DOC_SECTION_NAMES.join(", ")}.\n`
  );
}
