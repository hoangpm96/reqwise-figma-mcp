/**
 * Server-side half of the activity op.
 *
 * Same split as the userflow: the layout (dagre for rank order, lane-
 * constrained placement, corridor routing) runs HERE, so it stays testable
 * without a Figma window and the plugin bundle stays free of a graph-layout
 * library. The plugin only receives finished coordinates.
 */
import { buildActivity, type ActivitySpec } from "../shared/activity/index.js";
import type { AnyOperation } from "../shared/protocol.js";
import { validateActivitySpec } from "./validate.js";

export type OpCall = (op: AnyOperation, params: Record<string, unknown>) => Promise<unknown>;

export interface ActivityResult {
  frameId?: string;
  name?: string;
  nodes?: Record<string, string>;
  lanes?: Record<string, string>;
  box?: { x: number; y: number; w: number; h: number };
  dryRun?: boolean;
  warnings: string[];
  stats: {
    lanes: number;
    nodes: number;
    edges: number;
    handoffs: number;
    returnEdges: number;
    w: number;
    h: number;
  };
}

/**
 * Check the process, lay it out, then draw it. Findings are reported whether
 * or not the drawing happens — a process with an unowned step or an unlabelled
 * handoff still draws, because seeing it is how the gap gets fixed.
 */
export async function runActivity(
  rawSpec: unknown,
  call: OpCall,
  sink?: string[],
  /** Redraw into this existing frame instead of making a new one. */
  into?: string,
): Promise<ActivityResult> {
  const spec = validateActivitySpec(rawSpec) as unknown as ActivitySpec;
  const built = buildActivity(spec);
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
  const raw = await call("create_activity", draw as unknown as Record<string, unknown>);

  // The dispatch layer returns the plugin result bare, but wraps it as
  // `{ result, warnings }` the moment the plugin emitted any warning.
  // Spreading that shape blindly buries `frameId` AND drops the warnings.
  const { value, warnings: pluginWarnings } = unwrapWarned(raw);
  const warnings = built.warnings.slice();
  for (const w of pluginWarnings) if (!warnings.includes(w)) warnings.push(w);
  if (sink) for (const w of pluginWarnings) if (!sink.includes(w)) sink.push(w);

  return {
    ...((value ?? {}) as Partial<ActivityResult>),
    warnings,
    stats: built.stats,
  };
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
