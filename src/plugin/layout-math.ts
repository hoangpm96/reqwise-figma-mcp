/**
 * Pure layout math for `inset` / `align` resolution and z-order index
 * computation. NO figma globals referenced here — this module is imported
 * by handlers AND unit-tested in Node.
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Inset {
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
}

export interface Padding {
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
}

/**
 * Normalize every supported padding spelling into four optional sides.
 * Agents commonly use either `padding: 16`, `padding: {left: 16, ...}` or
 * Figma-native `paddingLeft`/`paddingRight`/`paddingTop`/`paddingBottom`.
 * Keeping this pure lets create/modify share identical behavior.
 */
export function normalizePadding(
  props: Record<string, unknown>,
): Padding {
  const out: Padding = {};
  if (typeof props.padding === "number") {
    out.left = out.right = out.top = out.bottom = props.padding;
  } else if (props.padding && typeof props.padding === "object") {
    const p = props.padding as Record<string, unknown>;
    // Both spellings: `{left,right,top,bottom}` is Figma's, and `{l,r,t,b}` is
    // what a READ of this node hands back — a caller who round-trips what they
    // read used to have their padding silently dropped.
    if (typeof p.left === "number") out.left = p.left;
    else if (typeof p.l === "number") out.left = p.l;
    if (typeof p.right === "number") out.right = p.right;
    else if (typeof p.r === "number") out.right = p.r;
    if (typeof p.top === "number") out.top = p.top;
    else if (typeof p.t === "number") out.top = p.t;
    if (typeof p.bottom === "number") out.bottom = p.bottom;
    else if (typeof p.b === "number") out.bottom = p.b;
  }

  // Flat Figma-native fields win when both spellings are present.
  if (typeof props.paddingLeft === "number") out.left = props.paddingLeft;
  if (typeof props.paddingRight === "number") out.right = props.paddingRight;
  if (typeof props.paddingTop === "number") out.top = props.paddingTop;
  if (typeof props.paddingBottom === "number") out.bottom = props.paddingBottom;
  return out;
}

/** True when a newly-created layout container should clear Figma's white fill. */
export function usesTransparentContainerDefault(
  type: string,
  props: Record<string, unknown>,
): boolean {
  return (
    (type === "FRAME" || type === "COMPONENT") &&
    props.fill === undefined &&
    props.fills === undefined
  );
}

/** Resolve uniform radius aliases in precedence order. */
export function resolveUniformCornerRadius(
  props: Record<string, unknown>,
): number | undefined {
  if (typeof props.cornerRadius === "number") return props.cornerRadius;
  if (typeof props.borderRadius === "number") return props.borderRadius;
  if (typeof props.radius === "number") return props.radius;
  return undefined;
}

export type Align = "center-x" | "center-y" | "center";

/** Requested geometry before parent-relative resolution. */
export interface GeometryRequest {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  inset?: Inset;
  align?: Align;
}

/**
 * Resolve a child box against its parent size using inset + align + explicit
 * dims. inset wins over explicit x/y/w on the axis it constrains; align
 * centers within whatever width/height ends up resolved. Parent origin is
 * treated as 0,0 (child coordinates are parent-relative).
 */
export function resolveGeometry(
  req: GeometryRequest,
  parent: { w: number; h: number },
): Box {
  const inset = req.inset ?? {};
  const hasL = typeof inset.left === "number";
  const hasR = typeof inset.right === "number";
  const hasT = typeof inset.top === "number";
  const hasB = typeof inset.bottom === "number";

  let w = typeof req.w === "number" ? req.w : 0;
  let h = typeof req.h === "number" ? req.h : 0;
  let x = typeof req.x === "number" ? req.x : 0;
  let y = typeof req.y === "number" ? req.y : 0;

  // Horizontal inset handling.
  if (hasL && hasR) {
    x = inset.left as number;
    w = Math.max(0, parent.w - (inset.left as number) - (inset.right as number));
  } else if (hasL) {
    x = inset.left as number;
  } else if (hasR) {
    // stretch from right edge: keep w, pin the right side
    x = Math.max(0, parent.w - (inset.right as number) - w);
  }

  // Vertical inset handling.
  if (hasT && hasB) {
    y = inset.top as number;
    h = Math.max(0, parent.h - (inset.top as number) - (inset.bottom as number));
  } else if (hasT) {
    y = inset.top as number;
  } else if (hasB) {
    y = Math.max(0, parent.h - (inset.bottom as number) - h);
  }

  // Alignment centers on axes NOT already pinned by a two-sided inset.
  const align = req.align;
  if (align === "center-x" || align === "center") {
    if (!(hasL && hasR)) x = round(parent.w / 2 - w / 2);
  }
  if (align === "center-y" || align === "center") {
    if (!(hasT && hasB)) y = round(parent.h / 2 - h / 2);
  }

  return { x: round(x), y: round(y), w: round(w), h: round(h) };
}

/** True when this geometry request needs a parent to resolve. */
export function needsParent(req: GeometryRequest): boolean {
  if (req.align) return true;
  const i = req.inset;
  if (!i) return false;
  return (
    typeof i.left === "number" ||
    typeof i.right === "number" ||
    typeof i.top === "number" ||
    typeof i.bottom === "number"
  );
}

export type InsertAt =
  | "top"
  | "bottom"
  | number
  | { above: string }
  | { below: string };

/**
 * Resolve a target child index in `parent.children` from an insertAt spec.
 * `childIds` is the ordered list of the parent's current children ids
 * (index 0 = bottom-most in Figma z-order). Returns the index to insert at.
 * "top" → end of array (front-most), "bottom" → 0.
 */
export function resolveInsertIndex(
  insertAt: InsertAt | undefined,
  childIds: readonly string[],
): number {
  const n = childIds.length;
  if (insertAt === undefined) return n; // default append (top)
  if (insertAt === "top") return n;
  if (insertAt === "bottom") return 0;
  if (typeof insertAt === "number") {
    return clampIndex(insertAt, n);
  }
  if ("above" in insertAt) {
    const idx = childIds.indexOf(insertAt.above);
    if (idx < 0) return n;
    return clampIndex(idx + 1, n);
  }
  if ("below" in insertAt) {
    const idx = childIds.indexOf(insertAt.below);
    if (idx < 0) return n;
    return clampIndex(idx, n);
  }
  return n;
}

function clampIndex(i: number, n: number): number {
  if (i < 0) return 0;
  if (i > n) return n;
  return i;
}

export function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Whether a child box overflows its parent bounds (child coords are
 * parent-relative, parent origin 0,0).
 */
export function overflowsParent(
  child: Box,
  parent: { w: number; h: number },
): boolean {
  return (
    child.x < -0.01 ||
    child.y < -0.01 ||
    child.x + child.w > parent.w + 0.01 ||
    child.y + child.h > parent.h + 0.01
  );
}

/**
 * Whether two axis-aligned boxes (same coordinate space) overlap with more than
 * a hairline of shared area. Touching edges do not count. Used to warn when a
 * newly-created page-level node lands on top of existing content (the classic
 * "created a COMPONENT without x/y → it dropped at (0,0) over a screen" trap).
 */
export function boxesOverlap(a: Box, b: Box): boolean {
  const EPS = 0.5;
  return (
    a.x < b.x + b.w - EPS &&
    a.x + a.w > b.x + EPS &&
    a.y < b.y + b.h - EPS &&
    a.y + a.h > b.y + EPS
  );
}

/**
 * Line height as a FUNCTION of font size, not a flat multiplier. Real type
 * ramps tighten line-height as size grows: body ~1.5, headings ~1.25, display
 * ~1.1. A single factor (the old 1.45) leaves large headings looking loose and
 * disconnected — one of the clearest "AI-drew-this" tells. Mirrors the
 * Tailwind/Radix size→leading curve.
 */
export function defaultLineHeight(fontSize: number): number {
  let factor: number;
  if (fontSize <= 14) factor = 1.45; // small/body text: needs air
  else if (fontSize <= 18) factor = 1.5; // body
  else if (fontSize <= 24) factor = 1.35; // subhead/heading
  else if (fontSize <= 32) factor = 1.25; // heading/title
  else if (fontSize <= 48) factor = 1.15; // display
  else factor = 1.05; // hero/oversized
  return round(fontSize * factor);
}

/** @deprecated kept for callers; use defaultLineHeight (size-aware). */
export const WRAP_LINE_HEIGHT_FACTOR = 1.45;

/** Back-compat alias — now size-aware rather than a flat 1.45×. */
export function wrapLineHeight(fontSize: number): number {
  return defaultLineHeight(fontSize);
}
