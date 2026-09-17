/**
 * One palette for every diagram, so a userflow and an activity diagram read as
 * the same document. The classes carry MEANING, not decoration: green is the
 * happy path, red is a failure, amber an edge case.
 */
import type { FlowClass } from "./types.js";

export const PALETTE: Record<FlowClass, { fill: string; stroke: string }> = {
  happy: { fill: "#d4edda", stroke: "#28a745" },
  error: { fill: "#f8d7da", stroke: "#dc3545" },
  edge: { fill: "#fff3cd", stroke: "#ffc107" },
  plain: { fill: "#ffffff", stroke: "#000f22" },
  decision: { fill: "#e8eef5", stroke: "#475569" },
};

export const DEFAULT_FONT = "Inter";

export const INK = "#000f22";
export const MUTED = "#5b6675";
export const RETURN_GRAY = "#8a94a6";
export const ERROR_RED = "#c0392b";
export const EDGE_AMBER = "#b7791f";

/**
 * An arrow takes the colour of what it points AT — a red arrow means "this
 * leads to the failure", which is the thing a reader scans for. A return path
 * (cancel / retry / back) is always grey: it is scaffolding, not the story.
 */
export function edgeColor(
  o: { back: boolean; kind: "forward" | "return" },
  targetCls: FlowClass | undefined,
  colorByTarget: boolean,
): string {
  if (o.back || o.kind === "return") return RETURN_GRAY;
  if (colorByTarget && targetCls === "error") return ERROR_RED;
  if (colorByTarget && targetCls === "edge") return EDGE_AMBER;
  return INK;
}
