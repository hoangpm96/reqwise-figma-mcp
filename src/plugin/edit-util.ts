/**
 * Pure edit-in-place helpers. NO figma globals — every function here operates
 * on plain data so it is unit-testable without the plugin runtime. The figma
 * handlers (instance-overrides.ts, paint-edit.ts) wrap these to touch the API.
 */
import { hexToRgb, hexToRgba, RGB, RGBA } from "./color-util.js";

// ---------------------------------------------------------------------------
// Recolor matching (set_selection_colors)
// ---------------------------------------------------------------------------

/** A near-comparison tolerance for 0..1 color channels (≈1/255). */
export const COLOR_EPSILON = 0.004;

/** Are two 0..1 RGB colors equal within COLOR_EPSILON per channel? */
export function rgbNearlyEqual(a: RGB, b: RGB, eps = COLOR_EPSILON): boolean {
  return (
    Math.abs(a.r - b.r) <= eps &&
    Math.abs(a.g - b.g) <= eps &&
    Math.abs(a.b - b.b) <= eps
  );
}

/**
 * Decide whether a SOLID fill/stroke of color `current` should be recolored,
 * given an optional `from` filter. When `from` is undefined every solid color
 * matches; when provided only colors near that hex match.
 */
export function shouldRecolor(current: RGB, from?: string): boolean {
  if (from === undefined) return true;
  return rgbNearlyEqual(current, hexToRgb(from));
}

// ---------------------------------------------------------------------------
// Gradient transform defaults (set_gradient)
// ---------------------------------------------------------------------------

export type GradientKind = "LINEAR" | "RADIAL" | "ANGULAR" | "DIAMOND";

const GRADIENT_TYPE_MAP: Record<GradientKind, string> = {
  LINEAR: "GRADIENT_LINEAR",
  RADIAL: "GRADIENT_RADIAL",
  ANGULAR: "GRADIENT_ANGULAR",
  DIAMOND: "GRADIENT_DIAMOND",
};

/** Map the friendly gradient kind → Figma paint type. Throws on unknown. */
export function gradientPaintType(kind: string): string {
  const k = String(kind).toUpperCase() as GradientKind;
  const mapped = GRADIENT_TYPE_MAP[k];
  if (!mapped) {
    throw new Error(
      `Unknown gradient type "${kind}". Use LINEAR|RADIAL|ANGULAR|DIAMOND.`,
    );
  }
  return mapped;
}

/**
 * Sensible default gradientTransform. Figma's transform is a 2x3 affine matrix
 * mapping the paint's [0..1]² gradient space onto the node. Identity
 * ([[1,0,0],[0,1,0]]) gives a left→right linear gradient; radial/angular/diamond
 * read the same identity as a centered gradient, which is what agents expect.
 * This is the matrix agents most often get wrong, so we package it.
 */
export function defaultGradientTransform(_kind: string): number[][] {
  return [
    [1, 0, 0],
    [0, 1, 0],
  ];
}

/** Validate a caller-supplied transform is a 2x3 numeric matrix. */
export function isValidGradientTransform(t: unknown): t is number[][] {
  return (
    Array.isArray(t) &&
    t.length === 2 &&
    t.every(
      (row) =>
        Array.isArray(row) &&
        row.length === 3 &&
        row.every((n) => typeof n === "number" && isFinite(n)),
    )
  );
}

export interface NormalizedStop {
  position: number;
  color: RGBA;
}

/**
 * Normalize gradient stops: parse hex → RGBA, apply optional per-stop opacity,
 * clamp position to 0..1, and fill in evenly-spaced positions when omitted.
 * Requires ≥1 stop.
 */
export function normalizeGradientStops(stops: unknown): NormalizedStop[] {
  if (!Array.isArray(stops) || stops.length === 0) {
    throw new Error("set_gradient requires a non-empty stops[] array.");
  }
  const n = stops.length;
  return stops.map((raw, i) => {
    const s = (raw ?? {}) as Record<string, unknown>;
    const pos =
      typeof s.position === "number"
        ? clampUnit(s.position)
        : n > 1
          ? i / (n - 1)
          : 0;
    const color =
      typeof s.color === "string"
        ? hexToRgba(s.color)
        : { r: 0, g: 0, b: 0, a: 1 };
    if (typeof s.opacity === "number") color.a = clampUnit(s.opacity);
    return { position: pos, color };
  });
}

function clampUnit(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// ---------------------------------------------------------------------------
// Effect normalization (set_effects)
// ---------------------------------------------------------------------------

export type EffectType =
  | "DROP_SHADOW"
  | "INNER_SHADOW"
  | "LAYER_BLUR"
  | "BACKGROUND_BLUR";

export interface NormalizedShadow {
  type: "DROP_SHADOW" | "INNER_SHADOW";
  color: RGBA;
  offset: { x: number; y: number };
  radius: number;
  spread: number;
  visible: boolean;
  blendMode: string;
}

export interface NormalizedBlur {
  type: "LAYER_BLUR" | "BACKGROUND_BLUR";
  radius: number;
  visible: boolean;
}

export type NormalizedEffect = NormalizedShadow | NormalizedBlur;

const SHADOW_TYPES = new Set(["DROP_SHADOW", "INNER_SHADOW"]);
const BLUR_TYPES = new Set(["LAYER_BLUR", "BACKGROUND_BLUR"]);

/**
 * Normalize ONE effect spec into a Figma-shaped Effect object. Shadows require
 * {color, offset, spread}; blurs require only {radius}. This packages the shape
 * agents commonly get wrong (e.g. supplying offset/color on a blur, or omitting
 * spread/blendMode on a shadow).
 */
export function normalizeEffect(spec: unknown): NormalizedEffect {
  const s = (spec ?? {}) as Record<string, unknown>;
  const type = String(s.type ?? "DROP_SHADOW").toUpperCase();

  if (typeof s.radius !== "number" || !isFinite(s.radius) || s.radius < 0) {
    throw new Error(
      `Effect "${type}" requires a non-negative numeric radius.`,
    );
  }
  const visible = s.visible !== false;

  if (SHADOW_TYPES.has(type)) {
    const color =
      typeof s.color === "string"
        ? hexToRgba(s.color)
        : { r: 0, g: 0, b: 0, a: 0.25 };
    const off = (s.offset ?? {}) as { x?: unknown; y?: unknown };
    const offset = {
      x: typeof off.x === "number" ? off.x : 0,
      y: typeof off.y === "number" ? off.y : 2,
    };
    return {
      type: type as "DROP_SHADOW" | "INNER_SHADOW",
      color,
      offset,
      radius: s.radius,
      spread: typeof s.spread === "number" ? s.spread : 0,
      visible,
      blendMode: typeof s.blendMode === "string" ? s.blendMode : "NORMAL",
    };
  }

  if (BLUR_TYPES.has(type)) {
    return {
      type: type as "LAYER_BLUR" | "BACKGROUND_BLUR",
      radius: s.radius,
      visible,
    };
  }

  throw new Error(
    `Unknown effect type "${type}". Use DROP_SHADOW|INNER_SHADOW|LAYER_BLUR|BACKGROUND_BLUR.`,
  );
}

/** Normalize a list (or single) effect spec. */
export function normalizeEffects(spec: unknown): NormalizedEffect[] {
  // An empty array is a deliberate "clear all effects" — the validator already
  // allows it, so accept it here too (previously this threw, a validator/plugin
  // mismatch) and let the caller assign node.effects = [].
  if (Array.isArray(spec) && spec.length === 0) return [];
  const list = Array.isArray(spec) ? spec : [spec];
  return list.map(normalizeEffect);
}

// ---------------------------------------------------------------------------
// Instance override diff shape (get/set_instance_overrides)
// ---------------------------------------------------------------------------

export interface OverrideSummary {
  sourceInstanceId: string;
  mainComponentId: string | null;
  /** Ids (relative to the instance) whose properties were overridden. */
  overriddenNodeIds: string[];
  /** componentProperties snapshot (name → value). */
  componentProperties: Record<string, unknown>;
  /** exposed nested instances, by id. */
  exposedInstanceIds: string[];
}

/**
 * Build the portable override-summary shape returned by get_instance_overrides
 * and consumed by set_instance_overrides. Pure — takes already-extracted data
 * so it can be tested without the figma runtime.
 */
export function buildOverrideSummary(input: {
  sourceInstanceId: string;
  mainComponentId: string | null;
  overriddenNodeIds: string[];
  componentProperties: Record<string, unknown>;
  exposedInstanceIds: string[];
}): OverrideSummary {
  return {
    sourceInstanceId: input.sourceInstanceId,
    mainComponentId: input.mainComponentId,
    overriddenNodeIds: [...input.overriddenNodeIds],
    componentProperties: { ...input.componentProperties },
    exposedInstanceIds: [...input.exposedInstanceIds],
  };
}

/**
 * Flatten Figma componentProperties (each value is {type, value, ...}) into a
 * plain name→value map suitable for setProperties(). Skips INSTANCE_SWAP-only
 * metadata that cannot be re-applied blindly is left to the caller.
 */
export function flattenComponentProperties(
  props: Record<string, { type?: string; value?: unknown }> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!props) return out;
  for (const [name, def] of Object.entries(props)) {
    if (def && typeof def === "object" && "value" in def) {
      out[name] = (def as { value: unknown }).value;
    }
  }
  return out;
}
