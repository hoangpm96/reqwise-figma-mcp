/**
 * Server-side half of the state op: the layout (dagre for the rank order, the
 * shared orthogonal router for the transitions) runs here, the plugin only
 * draws.
 */
import { buildState, type StateSpec } from "../shared/state/index.js";
import type { AnyOperation } from "../shared/protocol.js";
import { validateStateSpec } from "./validate.js";

export type OpCall = (op: AnyOperation, params: Record<string, unknown>) => Promise<unknown>;

export interface StateResult {
  frameId?: string;
  name?: string;
  nodes?: Record<string, string>;
  box?: { x: number; y: number; w: number; h: number };
  dryRun?: boolean;
  warnings: string[];
  stats: {
    states: number;
    transitions: number;
    finals: number;
    selfTransitions: number;
    w: number;
    h: number;
  };
}

/**
 * Check the machine, lay it out, then draw it. Findings are reported whether
 * or not the drawing happens — a state nothing can leave still draws, because
 * seeing it on the page is how the gap gets closed.
 */
export async function runState(
  rawSpec: unknown,
  call: OpCall,
  sink?: string[],
  /** Redraw into this existing frame instead of making a new one. */
  into?: string,
): Promise<StateResult> {
  const spec = validateStateSpec(rawSpec) as unknown as StateSpec;
  const built = buildState(spec);
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
  const raw = await call("create_state", draw as unknown as Record<string, unknown>);
  // The dispatch layer returns the plugin result bare, but wraps it as
  // `{ result, warnings }` the moment the plugin emitted any warning.
  const { value, warnings: pluginWarnings } = unwrapWarned(raw);
  const warnings = built.warnings.slice();
  for (const w of pluginWarnings) if (!warnings.includes(w)) warnings.push(w);
  if (sink) for (const w of pluginWarnings) if (!sink.includes(w)) sink.push(w);

  return { ...((value ?? {}) as Partial<StateResult>), warnings, stats: built.stats };
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
