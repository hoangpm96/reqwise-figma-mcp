/// <reference types="@figma/plugin-typings" />
import { HandlerContext, requireNode } from "../context.js";
import { loadNodeFonts, loadFontWithFallback, DEFAULT_FONT } from "../fonts.js";
import { serializeNode } from "../serialize.js";
import { err } from "../errors.js";
import { ErrorCode } from "../../shared/protocol.js";

const H_ALIGNS = ["LEFT", "CENTER", "RIGHT", "JUSTIFIED"] as const;
const V_ALIGNS = ["TOP", "CENTER", "BOTTOM"] as const;
const TEXT_CASES = [
  "ORIGINAL",
  "UPPER",
  "LOWER",
  "TITLE",
  "SMALL_CAPS",
  "SMALL_CAPS_FORCED",
] as const;
const TEXT_DECORATIONS = ["NONE", "UNDERLINE", "STRIKETHROUGH"] as const;

/**
 * Apply text-alignment props to a TEXT node. `textAlignHorizontal` sets how the
 * CONTENT aligns inside the node's own box (Figma's real API), which is what an
 * agent means by "center the text" — distinct from `align`, which positions the
 * whole NODE within its parent. Values are validated and normalized (case-
 * insensitive) so a bad enum throws INVALID_PARAMS with a hint instead of being
 * silently dropped (the old behavior: no-op, response still {ok:true}). Shared
 * by both create() and modify() so the two stay in sync.
 */
export function applyTextAlign(
  node: TextNode,
  p: Record<string, unknown>,
): void {
  if (p.textAlignHorizontal !== undefined) {
    const v = normalizeEnum(p.textAlignHorizontal, H_ALIGNS, "textAlignHorizontal");
    node.textAlignHorizontal = v;
  }
  if (p.textAlignVertical !== undefined) {
    const v = normalizeEnum(p.textAlignVertical, V_ALIGNS, "textAlignVertical");
    node.textAlignVertical = v;
  }
}

/**
 * Apply remaining typography props that agents routinely set on create/modify
 * and that the serializer already reads back: lineHeight, letterSpacing,
 * textCase, textDecoration, paragraphSpacing.
 *
 * Same silent-drop class as textAlign — values were accepted in the response
 * shape (design detail) but never written, so agents saw {ok:true} while the
 * canvas kept Figma defaults. Shared by create() and modify().
 *
 * Accepted shapes (bad values throw INVALID_PARAMS, never no-op):
 * - lineHeight: number (PIXELS) | "AUTO" | "150%" | {unit, value?}
 * - letterSpacing: number (PIXELS) | "2%" | {unit, value}
 * - textCase / textDecoration: Figma enum strings (case-insensitive)
 * - paragraphSpacing: number (pixels between paragraphs)
 */
export function applyTextTypography(
  node: TextNode,
  p: Record<string, unknown>,
): void {
  if (p.lineHeight !== undefined) {
    node.lineHeight = parseLineHeight(p.lineHeight);
  }
  if (p.letterSpacing !== undefined) {
    node.letterSpacing = parseLetterSpacing(p.letterSpacing);
  }
  if (p.textCase !== undefined) {
    node.textCase = normalizeEnum(p.textCase, TEXT_CASES, "textCase");
  }
  if (p.textDecoration !== undefined) {
    node.textDecoration = normalizeEnum(
      p.textDecoration,
      TEXT_DECORATIONS,
      "textDecoration",
    );
  }
  if (p.paragraphSpacing !== undefined) {
    if (typeof p.paragraphSpacing !== "number" || !Number.isFinite(p.paragraphSpacing)) {
      throw err(
        ErrorCode.INVALID_PARAMS,
        `Invalid paragraphSpacing value ${JSON.stringify(p.paragraphSpacing)}.`,
        "Use a finite number of pixels (e.g. 8).",
      );
    }
    node.paragraphSpacing = p.paragraphSpacing;
  }
}

function parseLineHeight(raw: unknown): LineHeight {
  if (raw === "AUTO" || raw === "auto") return { unit: "AUTO" };
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return { unit: "PIXELS", value: raw };
  }
  if (typeof raw === "string") {
    const pct = parsePercentString(raw);
    if (pct !== null) return { unit: "PERCENT", value: pct };
  }
  if (raw && typeof raw === "object") {
    const o = raw as { unit?: unknown; value?: unknown };
    const unit =
      typeof o.unit === "string" ? o.unit.toUpperCase() : "";
    if (unit === "AUTO") return { unit: "AUTO" };
    if (
      (unit === "PIXELS" || unit === "PERCENT") &&
      typeof o.value === "number" &&
      Number.isFinite(o.value)
    ) {
      return { unit, value: o.value } as LineHeight;
    }
  }
  throw err(
    ErrorCode.INVALID_PARAMS,
    `Invalid lineHeight value ${JSON.stringify(raw)}.`,
    'Use a number (pixels), "AUTO", "150%", or {unit:"PIXELS"|"PERCENT"|"AUTO", value?}.',
  );
}

function parseLetterSpacing(raw: unknown): LetterSpacing {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return { unit: "PIXELS", value: raw };
  }
  if (typeof raw === "string") {
    const pct = parsePercentString(raw);
    if (pct !== null) return { unit: "PERCENT", value: pct };
    const n = Number(raw);
    if (Number.isFinite(n)) return { unit: "PIXELS", value: n };
  }
  if (raw && typeof raw === "object") {
    const o = raw as { unit?: unknown; value?: unknown };
    const unit =
      typeof o.unit === "string" ? o.unit.toUpperCase() : "";
    if (
      (unit === "PIXELS" || unit === "PERCENT") &&
      typeof o.value === "number" &&
      Number.isFinite(o.value)
    ) {
      return { unit, value: o.value } as LetterSpacing;
    }
  }
  throw err(
    ErrorCode.INVALID_PARAMS,
    `Invalid letterSpacing value ${JSON.stringify(raw)}.`,
    'Use a number (pixels), "2%", or {unit:"PIXELS"|"PERCENT", value}.',
  );
}

/** Parse "150%" / "150" → 150; null if not a percent form. */
function parsePercentString(raw: string): number | null {
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)\s*%$/);
  if (!m) return null;
  return Number(m[1]);
}

function normalizeEnum<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  field: string,
): T {
  const up = typeof raw === "string" ? raw.toUpperCase() : "";
  const match = allowed.find((a) => a === up);
  if (!match) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      `Invalid ${field} value ${JSON.stringify(raw)}.`,
      `Use one of: ${allowed.join(", ")}.`,
    );
  }
  return match;
}

/**
 * set_text: mixed-font-safe. When the target's fontName is figma.mixed, EVERY
 * font used across the node's ranges is loaded before characters are set —
 * porting the robust load-all-ranges ("prevail") strategy from
 * claude-talk-to-figma's setcharacters.js. The single-font fast path stays for
 * uniform text nodes. When a requested/existing font can't be loaded, a
 * fallback is used and reported as {requestedFont, resolvedFont, reason}.
 */
export async function setText(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const node = await requireNode(p.nodeId ?? p.id);
  if (node.type !== "TEXT") {
    throw err(
      ErrorCode.INVALID_PARAMS,
      `set_text target must be TEXT (got ${node.type}).`,
      "Use create({type:'TEXT'}) or select a text layer.",
    );
  }
  const text = node as TextNode;
  const content =
    typeof p.characters === "string"
      ? p.characters
      : typeof p.text === "string"
        ? p.text
        : typeof p.content === "string"
          ? p.content
          : undefined;
  if (content === undefined) {
    throw err(ErrorCode.INVALID_PARAMS, "set_text requires characters/text/content.");
  }

  const priorAutoResize = text.textAutoResize;
  const fallbacks: Array<{
    requestedFont: FontName;
    resolvedFont: FontName;
    reason: string;
  }> = [];

  const isMixed = text.fontName === figma.mixed;
  if (isMixed) {
    // Load EVERY font used across ranges (mixed-range safe). Load each range's
    // font(s) individually so an unavailable one is substituted per-range and
    // reported, instead of crashing the whole set.
    await loadAllRangeFonts(text, fallbacks, ctx);
  } else {
    // Fast path: uniform font. Load it through the fallback chain so a missing
    // family substitutes cleanly instead of throwing.
    const fn = text.fontName as FontName;
    const res = await loadFontWithFallback(fn);
    if (res.substituted && res.reason) {
      fallbacks.push({
        requestedFont: fn,
        resolvedFont: res.resolvedFont,
        reason: res.reason,
      });
      ctx.warn(res.reason);
      // Set the resolved font on the whole node so characters can be applied.
      text.fontName = res.resolvedFont;
    }
  }

  text.characters = content;
  // Setting characters can reset sizing behaviour under some autoResize modes;
  // re-assert the prior value.
  text.textAutoResize = priorAutoResize;

  const out: Record<string, unknown> = {
    id: text.id,
    node: serializeNode(text, "compact"),
  };
  if (fallbacks.length > 0) out.fontFallbacks = fallbacks;
  return out;
}

/**
 * Load every distinct font used across the node's character ranges. For each
 * range font we go through the fallback chain; when a substitution happens we
 * rewrite that exact range to the resolved font (so characters can be set) and
 * record the substitution. Uniform default is used when the node is empty.
 */
async function loadAllRangeFonts(
  text: TextNode,
  fallbacks: Array<{
    requestedFont: FontName;
    resolvedFont: FontName;
    reason: string;
  }>,
  ctx: HandlerContext,
): Promise<void> {
  const len = text.characters.length;
  if (len === 0) {
    // Nothing to sample; ensure at least the default font is loaded.
    await loadNodeFonts(text);
    return;
  }

  // Walk contiguous ranges by their font to substitute per-range if needed.
  let i = 0;
  while (i < len) {
    const rangeFont = text.getRangeFontName(i, i + 1);
    // Extend the run while the font is identical.
    let j = i + 1;
    while (j < len) {
      const f = text.getRangeFontName(j, j + 1);
      if (
        f === figma.mixed ||
        rangeFont === figma.mixed ||
        (f as FontName).family !== (rangeFont as FontName).family ||
        (f as FontName).style !== (rangeFont as FontName).style
      ) {
        break;
      }
      j++;
    }

    if (rangeFont !== figma.mixed) {
      const fn = rangeFont as FontName;
      const res = await loadFontWithFallback(fn);
      if (res.substituted && res.reason) {
        if (!fallbacks.some((fb) => fb.reason === res.reason)) {
          fallbacks.push({
            requestedFont: fn,
            resolvedFont: res.resolvedFont,
            reason: res.reason,
          });
          ctx.warn(res.reason);
        }
        // Rewrite this range to the resolved font so setting characters works.
        text.setRangeFontName(i, j, res.resolvedFont);
      }
    } else {
      // Shouldn't happen for a 1-char slice, but be defensive.
      const res = await loadFontWithFallback(DEFAULT_FONT);
      text.setRangeFontName(i, j, res.resolvedFont);
    }
    i = j;
  }
}
