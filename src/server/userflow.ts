/**
 * Server-side half of the userflow op.
 *
 * The layout (dagre + orthogonal routing) runs HERE, not in the plugin: it is
 * pure computation over the graph, so it stays testable without a Figma window
 * and keeps the plugin bundle free of a graph-layout library. The plugin only
 * receives finished coordinates — the same split as loadIcon, where the server
 * resolves the SVG and the plugin just places it.
 */
import { buildUserflow, type UserflowSpec } from "../shared/userflow/index.js";
import type { AnyOperation } from "../shared/protocol.js";
import { validateUserflowSpec } from "./validate.js";

export type OpCall = (op: AnyOperation, params: Record<string, unknown>) => Promise<unknown>;

export interface UserflowResult {
  frameId?: string;
  name?: string;
  nodes?: Record<string, string>;
  box?: { x: number; y: number; w: number; h: number };
  linkedScreens?: Record<string, string>;
  dryRun?: boolean;
  warnings: string[];
  stats: { nodes: number; edges: number; returnEdges: number; w: number; h: number };
}

/**
 * Check the graph, lay it out, then draw it. Findings are reported whether or
 * not the drawing happens — a flow with a one-way question or an unreachable
 * screen still draws, because seeing it is how the gap gets fixed.
 */
export async function runUserflow(
  rawSpec: unknown,
  call: OpCall,
  sink?: string[],
  /** Redraw into this existing frame instead of making a new one. */
  into?: string,
): Promise<UserflowResult> {
  const spec = validateUserflowSpec(rawSpec) as unknown as UserflowSpec;
  const built = buildUserflow(spec);
  if (sink) for (const w of built.warnings) if (!sink.includes(w)) sink.push(w);

  if (spec.options?.dryRun) {
    return { dryRun: true, warnings: built.warnings, stats: built.stats };
  }

  // Frame plumbing, not layout: the drawing carries the model it was made from
  // (the frame stores it, so the next change can be a patch), and the id of the
  // frame to redraw into when there is one.
  const draw = {
    ...built.draw,
    source: built.model,
    ...(into ? { intoFrameId: into } : {}),
  };
  const raw = await call("create_userflow", draw as unknown as Record<string, unknown>);

  // The dispatch layer returns the plugin result bare, but wraps it as
  // `{ result, warnings }` the moment the plugin emitted any warning. Spreading
  // that shape blindly buries `frameId` one level down AND drops the plugin's
  // warnings — which is exactly how a failing linkScreens pass went silent.
  const { value, warnings: pluginWarnings } = unwrapWarned(raw);
  const warnings = built.warnings.slice();
  for (const w of pluginWarnings) if (!warnings.includes(w)) warnings.push(w);
  if (sink) for (const w of pluginWarnings) if (!sink.includes(w)) sink.push(w);

  return {
    ...((value ?? {}) as Partial<UserflowResult>),
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
