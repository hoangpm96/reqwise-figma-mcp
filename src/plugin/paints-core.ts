/**
 * Pure paint/effect spec parsing — NO figma globals, NO plugin-typings
 * reference, so it is unit-testable from the server-side test program.
 * paints.ts wraps these with the real Figma types for handler use.
 *
 * Output shapes are structurally identical to Figma's SolidPaint /
 * GradientPaint / DropShadowEffect / BlurEffect.
 */
import { hexToRgba, isHexColor, isRgbObject, parseColor } from "./color-util.js";
import { err } from "./errors.js";
import { ErrorCode } from "../shared/protocol.js";

export interface RGBAOut {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface SolidPaintOut {
  type: "SOLID";
  color: { r: number; g: number; b: number };
  opacity: number;
  visible?: boolean;
}

export interface GradientPaintOut {
  type: "GRADIENT_LINEAR" | "GRADIENT_RADIAL" | "GRADIENT_ANGULAR" | "GRADIENT_DIAMOND";
  gradientTransform: number[][];
  gradientStops: Array<{ position: number; color: RGBAOut }>;
}

export type PaintOut = SolidPaintOut | GradientPaintOut;

export interface ShadowEffectOut {
  type: "DROP_SHADOW" | "INNER_SHADOW";
  color: RGBAOut;
  offset: { x: number; y: number };
  radius: number;
  spread: number;
  visible: boolean;
  blendMode: "NORMAL";
}

export interface BlurEffectOut {
  type: "LAYER_BLUR" | "BACKGROUND_BLUR";
  radius: number;
  visible: boolean;
}

export type EffectOut = ShadowEffectOut | BlurEffectOut;

/** parseColor with the thrown Error upgraded to a HandlerError + usage hint. */
export function requireColor(spec: unknown, where: string): RGBAOut {
  try {
    return parseColor(spec);
  } catch (e) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      `${where}: ${(e as Error).message}`,
      'Colors accept "#rrggbb"/"#rrggbbaa" hex strings or {r,g,b[,a]} objects (0..1 like the Figma Plugin API, or 0..255).',
    );
  }
}

/**
 * Build a paint from a spec. Accepts:
 *   "#rrggbb" | "#rrggbbaa"                        → solid
 *   {r,g,b[,a]}                                     → solid (Figma-API shape)
 *   {type:"SOLID", color:"#.."|{r,g,b}, opacity?}  → solid
 *   {type:"GRADIENT_LINEAR"|..., stops|gradientStops:[{position,color}], ...}
 * Unparseable colors THROW — a silent fallback paints entire screens black.
 */
export function toPaintCore(spec: unknown): PaintOut {
  if (typeof spec === "string" && isHexColor(spec)) {
    const { r, g, b, a } = hexToRgba(spec);
    return { type: "SOLID", color: { r, g, b }, opacity: a };
  }
  // Bare {r,g,b} object (no type field) — the official Figma color shape.
  if (isRgbObject(spec)) {
    const { r, g, b, a } = requireColor(spec, "fill");
    return { type: "SOLID", color: { r, g, b }, opacity: a };
  }
  if (spec && typeof spec === "object") {
    const s = spec as Record<string, unknown>;
    const type = (s.type as string) ?? "SOLID";
    if (type === "SOLID") {
      const { r, g, b, a } = requireColor(s.color, "SOLID paint color");
      return {
        type: "SOLID",
        color: { r, g, b },
        opacity: typeof s.opacity === "number" ? s.opacity : a,
        visible: s.visible !== false,
      };
    }
    if (
      type === "GRADIENT_LINEAR" ||
      type === "GRADIENT_RADIAL" ||
      type === "GRADIENT_ANGULAR" ||
      type === "GRADIENT_DIAMOND"
    ) {
      const stopsIn = Array.isArray(s.stops)
        ? s.stops
        : Array.isArray(s.gradientStops)
          ? s.gradientStops
          : [];
      const gradientStops = stopsIn.map((st: unknown, i: number) => {
        const so = (st ?? {}) as Record<string, unknown>;
        const pos =
          typeof so.position === "number"
            ? so.position
            : stopsIn.length > 1
              ? i / (stopsIn.length - 1)
              : 0;
        const { r, g, b, a } = requireColor(so.color, `gradient stop ${i}`);
        return { position: pos, color: { r, g, b, a } };
      });
      const transform = (s.gradientTransform as number[][]) ?? [
        [1, 0, 0],
        [0, 1, 0],
      ];
      return { type, gradientTransform: transform, gradientStops };
    }
  }
  throw err(
    ErrorCode.INVALID_PARAMS,
    `Unsupported paint spec: ${JSON.stringify(spec)}`,
    'Use a hex string ("#rrggbb"), an {r,g,b} object, or {type:"SOLID"|"GRADIENT_LINEAR", ...}.',
  );
}

export function toPaintsCore(spec: unknown): PaintOut[] {
  if (Array.isArray(spec)) return spec.map(toPaintCore);
  return [toPaintCore(spec)];
}

/** Build an effect (drop/inner shadow, blur) from a spec. */
export function toEffectCore(spec: unknown): EffectOut {
  const s = (spec ?? {}) as Record<string, unknown>;
  const type = (s.type as string) ?? "DROP_SHADOW";
  if (type === "DROP_SHADOW" || type === "INNER_SHADOW") {
    // Omitted color → sensible default shadow; a PRESENT but malformed color throws.
    const { r, g, b, a } =
      s.color === undefined
        ? { r: 0, g: 0, b: 0, a: 0.25 }
        : requireColor(s.color, `${type} color`);
    const offset = (s.offset as { x: number; y: number }) ?? { x: 0, y: 2 };
    return {
      type,
      color: { r, g, b, a },
      offset,
      radius: typeof s.radius === "number" ? s.radius : 4,
      spread: typeof s.spread === "number" ? s.spread : 0,
      visible: s.visible !== false,
      blendMode: "NORMAL",
    };
  }
  if (type === "LAYER_BLUR" || type === "BACKGROUND_BLUR") {
    return {
      type,
      radius: typeof s.radius === "number" ? s.radius : 4,
      visible: s.visible !== false,
    };
  }
  throw err(
    ErrorCode.INVALID_PARAMS,
    `Unsupported effect type: ${String(type)}`,
    'Use {type:"DROP_SHADOW"|"INNER_SHADOW"|"LAYER_BLUR"|"BACKGROUND_BLUR", ...}.',
  );
}

export function toEffectsCore(spec: unknown): EffectOut[] {
  if (Array.isArray(spec)) return spec.map(toEffectCore);
  return [toEffectCore(spec)];
}
