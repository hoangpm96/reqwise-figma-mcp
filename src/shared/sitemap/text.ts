/**
 * The compact form of a sitemap.
 *
 *   crm "CRM"
 *     dash "Dashboard"
 *     contacts "Liên hệ" section
 *       list "Danh sách" screen:contacts-list,contacts-empty
 *       detail "Chi tiết liên hệ" screen:contact-detail / chỉ sales xem được
 *     settings "Cài đặt"
 *       portal "Cổng thanh toán" external
 *
 * INDENTATION IS THE MODEL. A sitemap edge is containment, so the thing that
 * says "this page lives under that one" is the thing every reader already uses
 * to say it — the shape a nav menu has on the page and a folder tree has on
 * disk. There is no arrow token in this grammar and no `edges` array behind
 * it, which is how this kind stays a sitemap instead of becoming a second,
 * worse userflow.
 *
 * The unit of indentation does not matter (two spaces, four, tabs) as long as
 * it is consistent: deeper than the line above means child, back to a column
 * already in use means sibling of that level, and a dedent landing BETWEEN two
 * columns in use is REPORTED rather than guessed at — that is the one case
 * where attaching the page to the nearest candidate would silently file it in
 * the wrong branch of somebody's IA.
 *
 * Line grammar: `id ["Label"] [kind] [cls] [screen:<a>,<b>,…] [/ detail]`
 *
 * `screen:` and not `@`, deliberately: `@name` is a policy reference
 * everywhere else in this repo, and one sigil with two meanings is a poor
 * trade in the one grammar where the reader is already counting spaces.
 */
import { lines, splitDetail, takeQuoted, takeWords, unknownLine } from "../diagram/text-util.js";
import type { PageSpec } from "./types.js";

export interface ParsedSitemap {
  pages: PageSpec[];
  warnings: string[];
}

const KINDS = ["page", "section", "modal", "external"] as const;
const SCREEN = /(?:^|\s)screen:([^\s]+)/;
/** `screen:01,02` — one page is usually several artboards; see PageSpec. */
const SCREEN_SEP = ",";
/**
 * Every other compact form in this repo joins two ids with an arrow, so an
 * arrow is what a writer's hands produce here too — and read as words it would
 * quietly declare a page called `a` with two bits of junk after it. §4 of the
 * shared rules is the reason this is a check and not a paragraph: where the
 * correct way is the opposite of the familiar way, prose loses to habit.
 */
const ARROW = /(?:^|\s)(-->>|-->|->>|--\)|->|<--|<-|~>|=>|\+>|:>)(?:\s|$)/;

export function parseSitemapText(src: string): ParsedSitemap {
  const pages: PageSpec[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  /** The open ancestors, outermost first, with strictly increasing indents. */
  const stack: Array<{ indent: number; id: string }> = [];
  /** Every indent column a page has actually been written at. */
  const columns = new Set<number>([0]);

  for (const l of lines(src)) {
    if (isHeader(l.text)) {
      warnings.push(
        `sitemap text, line ${l.no}: a leading "sitemap" header line is not part of the model — skipped; title/subtitle are their own fields.`,
      );
      continue;
    }

    const arrow = ARROW.exec(l.text);
    if (arrow) {
      warnings.push(
        `sitemap text, line ${l.no}: "${arrow[1]}" — skipped. A sitemap line has no arrow: its edges are CONTAINMENT (this page lives under that one), which is what the indentation says, and there is nothing here for an arrow to mean. If you meant "the user goes from here to there", that is navigation and belongs in figma_diagram type:"userflow".`,
      );
      continue;
    }

    while (stack.length && l.indent <= stack[stack.length - 1]!.indent) stack.pop();
    const parent = stack.length ? stack[stack.length - 1]!.id : undefined;

    let text = l.text;
    const screenHit = SCREEN.exec(text);
    const screens = (screenHit?.[1] ?? "")
      .split(SCREEN_SEP)
      .map((v) => v.trim())
      .filter(Boolean);
    if (screenHit) {
      text = (text.slice(0, screenHit.index) + text.slice(screenHit.index + screenHit[0].length)).trim();
    }

    const { head, detail } = splitDetail(text);
    const { value: label, rest } = takeQuoted(head);
    const { cls, kind, rest: words } = takeWords(rest, KINDS);
    const id = words.shift();
    if (!id) {
      unknownLine(warnings, "sitemap", l);
      continue;
    }
    for (const junk of words) {
      warnings.push(`sitemap text, line ${l.no}: "${junk}" is not a kind or a class — ignored.`);
    }
    if (seen.has(id)) {
      warnings.push(
        `sitemap text, line ${l.no}: page id "${id}" was already declared — the later line was dropped. A page appears ONCE in a containment tree; a page genuinely reachable from two places is NAVIGATION, which belongs in a userflow.`,
      );
      continue;
    }

    if (misaligned(columns, l.indent)) {
      warnings.push(
        `sitemap text, line ${l.no}: "${id}" is indented ${l.indent} space(s), which lines up with no level in use (${[...columns].sort((a, b) => a - b).join(", ")}) — it was filed under ${parent ? `"${parent}"` : "the top level"}. Line it up with its siblings, or the page ends up in the wrong branch.`,
      );
    }

    seen.add(id);
    columns.add(l.indent);
    pages.push({
      id,
      ...(label ? { label } : {}),
      ...(parent ? { parent } : {}),
      ...(kind && kind !== "page" ? { kind: kind as PageSpec["kind"] } : {}),
      ...(cls ? { cls } : {}),
      ...(screens.length ? { screenId: screens.length === 1 ? screens[0]! : screens } : {}),
      ...(detail ? { detail } : {}),
    });
    stack.push({ indent: l.indent, id });
  }

  return { pages, warnings };
}

/**
 * Is this indent strictly between two columns already in use?
 *
 * A column DEEPER than every one so far is simply the next level down, and the
 * first child of a level has to be allowed to invent it. What cannot be read
 * is a line that sits between two established levels: it is either a dedent
 * that overshot or an indent that fell short, and the two have different
 * parents.
 */
function misaligned(columns: Set<number>, indent: number): boolean {
  if (columns.has(indent)) return false;
  let below = false;
  let above = false;
  for (const c of columns) {
    if (c < indent) below = true;
    if (c > indent) above = true;
  }
  return below && above;
}

/**
 * A leading `sitemap "Title"` line is what a writer reaches for out of habit.
 * It is not part of the model — `title`/`subtitle` are their own fields — and
 * reading it as content would draw the title as the root PAGE, which then
 * counts as a level in the depth rule and shows up as a page the flows never
 * visit in the cross-check.
 */
function isHeader(text: string): boolean {
  return /^sitemap\b\s*["']/.test(text.trim());
}
