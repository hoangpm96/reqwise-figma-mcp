/**
 * Does the information architecture match the designs that actually exist?
 *
 * The third question a page of diagrams can be asked, and the one nothing
 * could answer until now:
 *
 *   `warnings`     is this model a legal diagram of its kind
 *   `consistency`  do the diagrams contradict EACH OTHER
 *   `coverage`     do they match the ARTBOARDS on the canvas      ← here
 *
 * Two directions, and unlike `ia-drift` both are worth having, because a
 * sitemap is meant to be the whole product rather than one journey through it:
 *
 *   IA → canvas   a page with no artboard. Design progress, read against the
 *                 structure of the product instead of a list of file names.
 *   canvas → IA   an artboard no page claims. Either a screen drawn with no
 *                 home, or a hole in the IA.
 *
 * The second direction is only sane because a page names ALL its artboards —
 * itself and its states. Without that it would report every empty state, every
 * validation-error frame and every loading frame as an orphan, which is the
 * same false positive `ia-drift` had to be shaped around. So it stays silent
 * until the author is actually using `screenId`, and `sitemap-coverage.test.ts`
 * pins that silence.
 *
 * Neither direction is a `warning`. A page with no design yet is not a defect
 * in the model — it is a fact about a project in progress, and reporting it as
 * a finding would train people to ignore findings.
 */
import { nameMatchesScreenId } from "./screen-id.js";
import { artboardsOf } from "../sitemap/check.js";
import type { StoredDiagram } from "./facts.js";

/** A frame on the page that is not a diagram — a screen, as far as we know. */
export interface ArtboardRef {
  nodeId: string;
  name: string;
}

export interface Coverage {
  /** Pages whose artboards are not on the canvas (yet). */
  undesigned: Array<{ page: string; frame: string; nodeId: string; wanted: string[] }>;
  /** Artboards no page in any sitemap claims. */
  orphans: Array<{ name: string; nodeId: string }>;
  /** How much of the IA has a design, for a one-line answer. */
  stats: { pages: number; designed: number; artboards: number; claimed: number };
}

export function checkCoverage(
  diagrams: StoredDiagram[],
  artboards: ArtboardRef[],
): Coverage | null {
  const pages: Array<{ id: string; name: string; frame: string; nodeId: string; wanted: string[] }> = [];
  for (const d of diagrams) {
    if (d.kind !== "sitemap") continue;
    const spec = d.spec as { pages?: unknown } | undefined;
    if (!spec || typeof spec !== "object" || !Array.isArray(spec.pages)) continue;
    for (const raw of spec.pages) {
      if (!raw || typeof raw !== "object") continue;
      const p = raw as { id?: unknown; label?: unknown; screenId?: string | string[] };
      const id = typeof p.id === "string" ? p.id : "";
      if (!id) continue;
      pages.push({
        id,
        name: (typeof p.label === "string" && p.label.trim()) || id,
        frame: d.title || d.nodeId,
        nodeId: d.nodeId,
        wanted: artboardsOf(p),
      });
    }
  }

  // No sitemap, or one that names no artboard at all: there is nothing to
  // compare, and saying "7 pages have no design" about an author who has not
  // opted into the back-reference is noise, not news.
  if (!pages.length || !pages.some((p) => p.wanted.length)) return null;

  const undesigned: Coverage["undesigned"] = [];
  const claimed = new Set<string>();
  let designed = 0;

  for (const p of pages) {
    // A page that names no artboard is not "undesigned" — it is unmapped, and
    // the author may simply not have got to it. Only a page that SAYS which
    // artboard it is can be missing one.
    if (!p.wanted.length) continue;
    const hits = artboards.filter((a) => p.wanted.some((id) => nameMatchesScreenId(a.name, id)));
    // Its states still belong to it, designed or not — an empty-state frame
    // drawn before the page itself is not an orphan.
    for (const a of hits) claimed.add(a.nodeId);
    // The FIRST artboard is the page itself; the rest are states of it. A page
    // whose only design is its empty state has not been designed, and counting
    // any hit as "designed" reported it done with nothing left to do.
    const self = p.wanted[0]!;
    if (!artboards.some((a) => nameMatchesScreenId(a.name, self))) {
      undesigned.push({ page: p.name, frame: p.frame, nodeId: p.nodeId, wanted: p.wanted });
      continue;
    }
    designed++;
  }

  const orphans = artboards
    .filter((a) => !claimed.has(a.nodeId))
    .map((a) => ({ name: a.name, nodeId: a.nodeId }));

  return {
    undesigned,
    orphans,
    stats: {
      pages: pages.length,
      designed,
      artboards: artboards.length,
      claimed: claimed.size,
    },
  };
}

/**
 * The same answer as a sentence, for a caller that wants to print one line
 * rather than walk the arrays.
 */
export function coverageSummary(c: Coverage): string {
  const parts = [`${c.stats.designed}/${c.stats.pages} pages have a design`];
  if (c.undesigned.length) {
    parts.push(
      `no artboard for ${list(c.undesigned.map((u) => `"${u.page}"`))}`,
    );
  }
  if (c.orphans.length) {
    parts.push(
      `${c.orphans.length} artboard(s) belong to no page (${list(c.orphans.slice(0, 6).map((o) => `"${o.name}"`))})`,
    );
  }
  return `${parts.join("; ")}.`;
}

function list(values: string[]): string {
  if (values.length === 1) return values[0]!;
  return `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]}`;
}
