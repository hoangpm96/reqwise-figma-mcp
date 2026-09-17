/**
 * Pure color conversions (hex ↔ Figma RGB(A) 0..1). NO figma globals.
 */

export interface RGB {
  r: number;
  g: number;
  b: number;
}
export interface RGBA extends RGB {
  a: number;
}

/** Parse "#rgb", "#rrggbb", "#rrggbbaa" (with/without #) → RGBA 0..1. */
export function hexToRgba(hex: string): RGBA {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (h.length === 4) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (h.length === 6) h += "ff";
  if (h.length !== 8 || /[^0-9a-fA-F]/.test(h)) {
    throw new Error(`Invalid hex color: "${hex}"`);
  }
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const a = parseInt(h.slice(6, 8), 16) / 255;
  return { r: clamp01(r), g: clamp01(g), b: clamp01(b), a: clamp01(a) };
}

export function hexToRgb(hex: string): RGB {
  const { r, g, b } = hexToRgba(hex);
  return { r, g, b };
}

export function rgbToHex(c: RGB): string {
  return "#" + byte(c.r) + byte(c.g) + byte(c.b);
}

export function rgbaToHex(c: RGBA): string {
  return "#" + byte(c.r) + byte(c.g) + byte(c.b) + byte(c.a);
}

function byte(n: number): string {
  const v = Math.round(clamp01(n) * 255);
  return v.toString(16).padStart(2, "0");
}

export function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * WCAG 2.x relative luminance of an sRGB color (channels 0..1).
 * https://www.w3.org/TR/WCAG21/#dfn-relative-luminance — linearize each channel,
 * then weight R/G/B by 0.2126 / 0.7152 / 0.0722.
 */
export function relativeLuminance(c: RGB): number {
  const lin = (v: number): number =>
    v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/**
 * WCAG contrast ratio between two colors, 1..21. Order-independent.
 * https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio — (L_lighter+0.05)/(L_darker+0.05).
 * This is the REAL readability metric; naive RGB distance is not.
 */
export function contrastRatio(a: RGB, b: RGB): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Composite a possibly-translucent foreground over an opaque background
 * (both 0..1), returning the resulting opaque RGB. Lets contrast be judged on
 * what the eye actually sees when fg alpha < 1.
 */
export function compositeOver(fg: RGBA, bg: RGB): RGB {
  const a = clamp01(fg.a);
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
  };
}

/** Is a string a hex color literal? */
export function isHexColor(s: string): boolean {
  return /^#?([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(s.trim());
}

/** Is a value an {r,g,b} object (the official Figma Plugin API color shape)? */
export function isRgbObject(v: unknown): v is { r: number; g: number; b: number; a?: number } {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.r === "number" &&
    typeof o.g === "number" &&
    typeof o.b === "number" &&
    (o.a === undefined || typeof o.a === "number")
  );
}

/**
 * Parse ANY accepted color spec → RGBA 0..1. Accepts:
 *   - hex string: "#rgb" | "#rrggbb" | "#rrggbbaa"
 *   - {r,g,b[,a]} with channels in 0..1 (official Figma Plugin API shape)
 *   - {r,g,b[,a]} with channels in 0..255 (CSS-style; auto-detected when any
 *     channel > 1, alpha stays 0..1)
 * Throws with a format hint on anything else — never silently substitutes a
 * color (a silent black default is how entire screens render wrong).
 */
export function parseColor(spec: unknown): RGBA {
  if (typeof spec === "string" && isHexColor(spec)) return hexToRgba(spec);
  if (isRgbObject(spec)) {
    const { r, g, b } = spec;
    const a = spec.a ?? 1;
    // Any channel above 1 ⇒ the caller used 0..255 ints; normalize.
    const scale = r > 1 || g > 1 || b > 1 ? 255 : 1;
    return {
      r: clamp01(r / scale),
      g: clamp01(g / scale),
      b: clamp01(b / scale),
      a: clamp01(a),
    };
  }
  throw new Error(
    `Invalid color: ${JSON.stringify(spec)}. Use "#rrggbb"/"#rrggbbaa" or {r,g,b[,a]} (0..1 or 0..255).`,
  );
}
