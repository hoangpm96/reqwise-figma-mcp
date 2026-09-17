/**
 * Server-side half of the sequence op: the layout (columns, rows, activation
 * bars, fragment boxes) runs here, the plugin only draws.
 */
import { buildSequence, type SequenceSpec } from "../shared/sequence/index.js";
import type { AnyOperation } from "../shared/protocol.js";
import { validateSequenceSpec } from "./validate.js";

export type OpCall = (op: AnyOperation, params: Record<string, unknown>) => Promise<unknown>;

export interface SequenceResult {
  frameId?: string;
  name?: string;
  participants?: Record<string, string>;
  box?: { x: number; y: number; w: number; h: number };
  dryRun?: boolean;
  warnings: string[];
  stats: {
    participants: number;
    messages: number;
    returns: number;
    fragments: number;
    w: number;
    h: number;
  };
}

/**
 * Check the exchange, lay it out, then draw it. Findings are reported whether
 * or not the drawing happens — a call nobody answers still draws, because
 * seeing it is how the gap gets filled.
 */
export async function runSequence(
  rawSpec: unknown,
  call: OpCall,
  sink?: string[],
  /** Redraw into this existing frame instead of making a new one. */
  into?: string,
): Promise<SequenceResult> {
  const spec = validateSequenceSpec(rawSpec) as unknown as SequenceSpec;
  const built = buildSequence(spec);
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
  const raw = await call("create_sequence", draw as unknown as Record<string, unknown>);
  const { value, warnings: pluginWarnings } = unwrapWarned(raw);
  const warnings = built.warnings.slice();
  for (const w of pluginWarnings) if (!warnings.includes(w)) warnings.push(w);
  if (sink) for (const w of pluginWarnings) if (!sink.includes(w)) sink.push(w);

  return { ...((value ?? {}) as Partial<SequenceResult>), warnings, stats: built.stats };
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
