/// <reference types="@figma/plugin-typings" />
import { HandlerContext, requireNode } from "../context.js";
import { serializeNode } from "../serialize.js";
import { err } from "../errors.js";
import { ErrorCode } from "../../shared/protocol.js";
import { loadFontWithFallback, DEFAULT_FONT } from "../fonts.js";
import { toEffects } from "../paints.js";

/**
 * Text-style ops: the typography half of a design system. setup_text_styles
 * upserts the ramp (Title 01/02, Body, ...) as local Figma text styles;
 * set_text_style applies one to a TEXT node by name. Mirrors the token flow:
 * define once with setup_*, consume by NAME everywhere.
 */

/** Numeric CSS-ish weight → Figma font style name. */
const WEIGHT_NAMES: Record<number, string> = {
  100: "Thin",
  200: "Extra Light",
  300: "Light",
  400: "Regular",
  500: "Medium",
  600: "Semi Bold",
  700: "Bold",
  800: "Extra Bold",
  900: "Black",
};

interface TextStyleSpec {
  name: string;
  family: string;
  style: string;
  fontSize: number;
  lineHeight?: LineHeight;
  letterSpacing?: LetterSpacing;
  description?: string;
}

/**
 * Parse "150%" | number(px) | "auto" | {unit, value} into a Figma LineHeight.
 * Bad shapes throw (never silently dropped).
 */
export function parseLineHeight(v: unknown): LineHeight {
  if (v === "auto" || v === "AUTO") return { unit: "AUTO" };
  if (typeof v === "number" && isFinite(v) && v >= 0) {
    return { unit: "PIXELS", value: v };
  }
  if (typeof v === "string") {
    const m = v.trim().match(/^(\d+(?:\.\d+)?)%$/);
    if (m) return { unit: "PERCENT", value: Number(m[1]) };
  }
  if (typeof v === "object" && v !== null && "unit" in v) {
    const o = v as { unit: unknown; value?: unknown };
    const unit = String(o.unit).toUpperCase();
    if (unit === "AUTO") return { unit: "AUTO" };
    if ((unit === "PIXELS" || unit === "PERCENT") && typeof o.value === "number") {
      return { unit, value: o.value } as LineHeight;
    }
  }
  throw new Error(
    `Invalid lineHeight ${JSON.stringify(v)}. Use a number (px), "150%", "auto", or {unit, value}.`,
  );
}

/** Parse number(px) | "2%" | {unit, value} into a Figma LetterSpacing. */
export function parseLetterSpacing(v: unknown): LetterSpacing {
  if (typeof v === "number" && isFinite(v)) return { unit: "PIXELS", value: v };
  if (typeof v === "string") {
    const m = v.trim().match(/^(-?\d+(?:\.\d+)?)%$/);
    if (m) return { unit: "PERCENT", value: Number(m[1]) };
  }
  if (typeof v === "object" && v !== null && "unit" in v) {
    const o = v as { unit: unknown; value?: unknown };
    const unit = String(o.unit).toUpperCase();
    if ((unit === "PIXELS" || unit === "PERCENT") && typeof o.value === "number") {
      return { unit, value: o.value } as LetterSpacing;
    }
  }
  throw new Error(
    `Invalid letterSpacing ${JSON.stringify(v)}. Use a number (px), "2%", or {unit, value}.`,
  );
}

/** Normalize one ramp entry; throws on missing name/size or bad enums. */
function normalizeTextStyleSpec(spec: unknown): TextStyleSpec {
  const s = (typeof spec === "object" && spec !== null ? spec : {}) as Record<
    string,
    unknown
  >;
  const name = typeof s.name === "string" ? s.name.trim() : "";
  if (!name) {
    throw new Error('Each text style needs a non-empty "name" (e.g. "Title 01").');
  }
  const fontSize = s.fontSize ?? s.size;
  if (typeof fontSize !== "number" || !isFinite(fontSize) || fontSize <= 0) {
    throw new Error(`Text style "${name}" needs a positive numeric fontSize.`);
  }

  const family =
    typeof s.fontFamily === "string"
      ? s.fontFamily
      : typeof s.family === "string"
        ? s.family
        : DEFAULT_FONT.family;

  // Style precedence: explicit fontStyle/style string > numeric weight > Regular.
  let style =
    typeof s.fontStyle === "string"
      ? s.fontStyle
      : typeof s.style === "string"
        ? s.style
        : "";
  if (!style && s.weight !== undefined) {
    const w = Number(s.weight);
    const mapped = WEIGHT_NAMES[w];
    if (!mapped) {
      throw new Error(
        `Text style "${name}": unknown weight ${JSON.stringify(s.weight)}. Use 100–900 (hundreds) or a style name like "Medium".`,
      );
    }
    style = mapped;
  }
  if (!style) style = DEFAULT_FONT.style;

  const out: TextStyleSpec = { name, family, style, fontSize };
  if (s.lineHeight !== undefined) out.lineHeight = parseLineHeight(s.lineHeight);
  if (s.letterSpacing !== undefined) {
    out.letterSpacing = parseLetterSpacing(s.letterSpacing);
  }
  if (typeof s.description === "string") out.description = s.description;
  return out;
}

/**
 * setup_text_styles: upsert local text styles by name (idempotent, like
 * setupTokens). Fonts resolve through the fallback chain; substitutions are
 * surfaced as warnings, invalid specs throw INVALID_PARAMS.
 */
export async function setupTextStyles(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const raw = Array.isArray(p.styles) ? p.styles : p.styles;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      "setup_text_styles requires a non-empty styles array.",
      'Pass styles:[{name:"Title 01", fontSize:40, weight:700, lineHeight:"120%"}].',
    );
  }

  let specs: TextStyleSpec[];
  try {
    specs = raw.map(normalizeTextStyleSpec);
  } catch (e) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      e instanceof Error ? e.message : String(e),
      'Each entry: {name, fontSize, fontFamily?, weight?|fontStyle?, lineHeight?, letterSpacing?, description?}.',
    );
  }
  const seen = new Set<string>();
  for (const s of specs) {
    if (seen.has(s.name)) {
      throw err(
        ErrorCode.INVALID_PARAMS,
        `Duplicate text style name "${s.name}" in one setup_text_styles call.`,
        "Give each ramp entry a unique name.",
      );
    }
    seen.add(s.name);
  }

  const existing = await figma.getLocalTextStylesAsync();
  const byName = new Map(existing.map((st) => [st.name, st]));
  const created: string[] = [];
  const updated: string[] = [];
  const results: Array<Record<string, unknown>> = [];

  for (const spec of specs) {
    const res = await loadFontWithFallback({
      family: spec.family,
      style: spec.style,
    });
    if (res.substituted && res.reason) ctx.warn(`${spec.name}: ${res.reason}`);

    let style = byName.get(spec.name);
    if (style) {
      updated.push(spec.name);
    } else {
      style = figma.createTextStyle();
      style.name = spec.name;
      byName.set(spec.name, style);
      created.push(spec.name);
    }
    style.fontName = res.resolvedFont;
    style.fontSize = spec.fontSize;
    if (spec.lineHeight !== undefined) style.lineHeight = spec.lineHeight;
    if (spec.letterSpacing !== undefined) {
      style.letterSpacing = spec.letterSpacing;
    }
    if (spec.description !== undefined) style.description = spec.description;

    results.push({
      id: style.id,
      name: style.name,
      font: res.resolvedFont,
      fontSize: spec.fontSize,
    });
  }

  return { created, updated, styles: results };
}

/**
 * setup_effect_styles: upsert local EFFECT styles (elevation ramp) by name,
 * idempotent like setupTextStyles. This is what makes elevation TOKENIZABLE —
 * previously effect styles could be counted but never created, so every kit
 * came out flat (effect:0). Each entry: {name, effects:[<shadow|blur>...],
 * description?}. Effects reuse the same shape as create({effects}).
 */
export async function setupEffectStyles(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const raw = Array.isArray(p.styles) ? p.styles : undefined;
  if (!raw || raw.length === 0) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      "setup_effect_styles requires a non-empty styles array.",
      'Pass styles:[{name:"elevation/card", effects:[{type:"DROP_SHADOW", color:"#1C202412", offset:{x:0,y:1}, radius:2}, {type:"DROP_SHADOW", color:"#1C20240F", offset:{x:0,y:4}, radius:12, spread:-2}]}].',
    );
  }

  interface EffectStyleSpec {
    name: string;
    effects: Effect[];
    description?: string;
  }
  let specs: EffectStyleSpec[];
  try {
    specs = raw.map((r): EffectStyleSpec => {
      const o = (r ?? {}) as Record<string, unknown>;
      const name = typeof o.name === "string" ? o.name.trim() : "";
      if (!name) throw new Error("Each effect style needs a non-empty name.");
      if (!Array.isArray(o.effects) || o.effects.length === 0) {
        throw new Error(`Effect style "${name}" needs a non-empty effects array.`);
      }
      const effects = toEffects(o.effects); // validates each shadow/blur spec
      const spec: EffectStyleSpec = { name, effects };
      if (typeof o.description === "string") spec.description = o.description;
      return spec;
    });
  } catch (e) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      e instanceof Error ? e.message : String(e),
      'Each entry: {name, effects:[{type:"DROP_SHADOW", color, offset:{x,y}, radius, spread?} | {type:"LAYER_BLUR", radius}], description?}.',
    );
  }

  const seen = new Set<string>();
  for (const s of specs) {
    if (seen.has(s.name)) {
      throw err(
        ErrorCode.INVALID_PARAMS,
        `Duplicate effect style name "${s.name}" in one call.`,
        "Give each elevation level a unique name.",
      );
    }
    seen.add(s.name);
  }

  const existing = await figma.getLocalEffectStylesAsync();
  const byName = new Map(existing.map((st) => [st.name, st]));
  const created: string[] = [];
  const updated: string[] = [];
  const results: Array<Record<string, unknown>> = [];

  for (const spec of specs) {
    let style = byName.get(spec.name);
    if (style) {
      updated.push(spec.name);
    } else {
      style = figma.createEffectStyle();
      style.name = spec.name;
      byName.set(spec.name, style);
      created.push(spec.name);
    }
    style.effects = spec.effects;
    if (spec.description !== undefined) style.description = spec.description;
    results.push({ id: style.id, name: style.name, effects: spec.effects.length });
  }

  return { created, updated, styles: results };
}

/**
 * Resolve a local text style by id or (case-insensitive) name. Misses throw
 * INVALID_PARAMS listing the available names so the caller can self-correct.
 */
export async function resolveTextStyle(nameOrId: unknown): Promise<TextStyle> {
  const query = typeof nameOrId === "string" ? nameOrId.trim() : "";
  if (!query) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      "A text style name (or id) is required.",
      'Example: "Title 01". List styles via figma_read get_styles.',
    );
  }
  const styles = await figma.getLocalTextStylesAsync();
  const byId = styles.find((s) => s.id === query);
  if (byId) return byId;
  const lower = query.toLowerCase();
  const exact = styles.filter((s) => s.name.toLowerCase() === lower);
  if (exact.length === 1) return exact[0]!;
  const partial = styles.filter((s) => s.name.toLowerCase().includes(lower));
  if (partial.length === 1) return partial[0]!;

  const candidates = (partial.length > 1 ? partial : styles)
    .slice(0, 10)
    .map((s) => s.name);
  throw err(
    ErrorCode.INVALID_PARAMS,
    partial.length > 1
      ? `Text style "${query}" is ambiguous (${partial.length} matches).`
      : `No local text style named "${query}".`,
    candidates.length > 0
      ? `Candidates: ${candidates.join(", ")}.`
      : "No local text styles exist yet — create the ramp with setup_text_styles first.",
  );
}

/** Apply a resolved text style to a TEXT node (dynamic-page safe). */
export async function applyTextStyleToNode(
  node: TextNode,
  style: TextStyle,
): Promise<void> {
  // The style's font must be loaded before Figma accepts the assignment.
  await figma.loadFontAsync(style.fontName);
  const n = node as TextNode & {
    setTextStyleIdAsync?: (id: string) => Promise<void>;
  };
  if (typeof n.setTextStyleIdAsync === "function") {
    await n.setTextStyleIdAsync(style.id);
  } else {
    node.textStyleId = style.id;
  }
}

/**
 * set_text_style: apply a local text style (by name or id) to a TEXT node.
 * The draw-time counterpart of setup_text_styles.
 */
export async function setTextStyle(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const node = await requireNode(p.nodeId ?? p.id);
  if (node.type !== "TEXT") {
    throw err(
      ErrorCode.INVALID_PARAMS,
      `set_text_style targets TEXT nodes; "${node.name}" is ${node.type}.`,
      "Pass the id of the text layer itself, not its container.",
    );
  }
  const style = await resolveTextStyle(p.style ?? p.styleName ?? p.styleId);
  await applyTextStyleToNode(node as TextNode, style);
  return {
    id: node.id,
    styleId: style.id,
    styleName: style.name,
    node: serializeNode(node, "compact"),
  };
}

/**
 * Resolve a local EFFECT style by name (or id), the elevation counterpart of
 * resolveTextStyle.
 *
 * This existed nowhere, which is why `effectStyle` in a create() spec was a
 * silent no-op for as long as the key has been passed: the spec looked right,
 * the styles were created, and every "elevated" card rendered flat. A dropped
 * key produces a perfectly valid node, so nothing downstream can notice.
 */
export async function resolveEffectStyle(nameOrId: unknown): Promise<EffectStyle> {
  const query = typeof nameOrId === "string" ? nameOrId.trim() : "";
  if (!query) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      "An effect style name (or id) is required.",
      'Example: "elevation/2". List styles via figma_read get_styles.',
    );
  }
  const styles = await figma.getLocalEffectStylesAsync();
  const byId = styles.find((s) => s.id === query);
  if (byId) return byId;
  const lower = query.toLowerCase();
  const exact = styles.filter((s) => s.name.toLowerCase() === lower);
  if (exact.length === 1) return exact[0]!;

  throw err(
    ErrorCode.INVALID_PARAMS,
    `No local effect style named "${query}".`,
    styles.length > 0
      ? `Candidates: ${styles.slice(0, 10).map((s) => s.name).join(", ")}.`
      : "No local effect styles exist yet — create the ramp with setup_effect_styles first.",
  );
}

/** Apply a resolved effect style to a node (dynamic-page safe). */
export async function applyEffectStyleToNode(
  node: SceneNode,
  style: EffectStyle,
): Promise<void> {
  const n = node as SceneNode & {
    setEffectStyleIdAsync?: (id: string) => Promise<void>;
    effectStyleId?: string;
  };
  if (typeof n.setEffectStyleIdAsync === "function") {
    await n.setEffectStyleIdAsync(style.id);
  } else if ("effectStyleId" in node) {
    n.effectStyleId = style.id;
  }
}
