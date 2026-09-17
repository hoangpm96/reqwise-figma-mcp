/**
 * Server-side half of the sitemap op: the tidy-tree pass and the containment
 * lines are computed here, the plugin only draws.
 */
import { buildSitemap, type SitemapSpec } from "../shared/sitemap/index.js";
import type { AnyOperation } from "../shared/protocol.js";
import { validateSitemapSpec } from "./validate.js";

export type OpCall = (op: AnyOperation, params: Record<string, unknown>) => Promise<unknown>;

export interface SitemapResult {
  frameId?: string;
  name?: string;
  nodes?: Record<string, string>;
  box?: { x: number; y: number; w: number; h: number };
  dryRun?: boolean;
  warnings: string[];
  stats: {
    pages: number;
    leaves: number;
    depth: number;
    sections: number;
    w: number;
    h: number;
  };
}

/**
 * Check the tree, lay it out, then draw it. Findings are reported whether or
 * not the drawing happens — a branch four clicks from the front door still
 * draws, because seeing it on the page is how the gap gets closed.
 */
export async function runSitemap(
  rawSpec: unknown,
  call: OpCall,
  sink?: string[],
  /** Redraw into this existing frame instead of making a new one. */
  into?: string,
): Promise<SitemapResult> {
  const spec = validateSitemapSpec(rawSpec) as unknown as SitemapSpec;
  const built = buildSitemap(spec);
  if (sink) for (const w of built.warnings) if (!sink.includes(w)) sink.push(w);

  if (spec.options?.dryRun) {
    return { dryRun: true, warnings: built.warnings, stats: built.stats };
  }

  // Frame plumbing, not layout, so it is attached here: the drawing carries
  // the model it was made from (the frame stores it, so the next change can be
  // a patch), and the id of the frame to redraw into when there is one.
  const draw = {
    ...built.draw,
    source: built.model,
    ...(into ? { intoFrameId: into } : {}),
  };
  const raw = await call("create_sitemap", draw as unknown as Record<string, unknown>);
  // The dispatch layer returns the plugin result bare, but wraps it as
  // `{ result, warnings }` the moment the plugin emitted any warning.
  const { value, warnings: pluginWarnings } = unwrapWarned(raw);
  const warnings = built.warnings.slice();
  for (const w of pluginWarnings) if (!warnings.includes(w)) warnings.push(w);
  if (sink) for (const w of pluginWarnings) if (!sink.includes(w)) sink.push(w);

  return { ...((value ?? {}) as Partial<SitemapResult>), warnings, stats: built.stats };
}

function unwrapWarned(raw: unknown): { value: unknown; warnings: string[] } {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    if ("result" in o && Array.isArray(o.warnings)) {
      return { value: o.result, warnings: o.warnings.map(String) };
    }
  }
  return { value: raw, warnings: [] };
}
