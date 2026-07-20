/// <reference types="@figma/plugin-typings" />
import { HandlerContext, requireNode } from "../context.js";
import { loadNodeFonts, loadFontWithFallback, DEFAULT_FONT } from "../fonts.js";
import { serializeNode } from "../serialize.js";
import { err } from "../errors.js";
import { ErrorCode } from "../../shared/protocol.js";

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
