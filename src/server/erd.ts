/**
 * Server-side half of the ERD op: the layout (dagre + row-anchored routing)
 * runs here, the plugin only draws.
 */
import { buildErd, type ErdSpec } from "../shared/erd/index.js";
import type { AnyOperation } from "../shared/protocol.js";
import { validateErdSpec } from "./validate.js";

export type OpCall = (op: AnyOperation, params: Record<string, unknown>) => Promise<unknown>;

export interface ErdResult {
  frameId?: string;
  name?: string;
  entities?: Record<string, string>;
  box?: { x: number; y: number; w: number; h: number };
  dryRun?: boolean;
  warnings: string[];
  stats: {
    entities: number;
    attributes: number;
    relations: number;
    manyToMany: number;
    w: number;
    h: number;
  };
}

/**
 * Check the model, lay it out, then draw it. Findings are reported whether or
 * not the drawing happens — a table with no primary key still draws, because
 * seeing it is how it gets fixed.
 */
export async function runErd(rawSpec: unknown, call: OpCall, sink?: string[], into?: string): Promise<ErdResult> {
  const spec = validateErdSpec(rawSpec) as unknown as ErdSpec;
  const built = buildErd(spec);
  if (sink) for (const w of built.warnings) if (!sink.includes(w)) sink.push(w);

  if (spec.options?.dryRun) {
    return { dryRun: true, warnings: built.warnings, stats: built.stats };
  }

  // Frame plumbing, not layout, so it is attached here: the drawing carries
  // the model it was made from (the frame stores it, so the next change can
  // be a patch), and the id of the frame to redraw into when there is one.
  const draw = {
    ...built.draw,
    source: built.model,
    ...(into ? { intoFrameId: into } : {}),
  };
  const raw = await call("create_erd", draw as unknown as Record<string, unknown>);
  const { value, warnings: pluginWarnings } = unwrapWarned(raw);
  const warnings = built.warnings.slice();
  for (const w of pluginWarnings) if (!warnings.includes(w)) warnings.push(w);
  if (sink) for (const w of pluginWarnings) if (!sink.includes(w)) sink.push(w);

  return { ...((value ?? {}) as Partial<ErdResult>), warnings, stats: built.stats };
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
