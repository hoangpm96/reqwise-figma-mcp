/// <reference types="@figma/plugin-typings" />
import { HandlerContext, requireNode } from "../context.js";
import { serializeNode } from "../serialize.js";
import { err } from "../errors.js";
import { ErrorCode } from "../../shared/protocol.js";
import { isHexColor, hexToRgb } from "../color-util.js";
import {
  shouldRecolor,
  gradientPaintType,
  defaultGradientTransform,
  isValidGradientTransform,
  normalizeGradientStops,
  normalizeEffects,
} from "../edit-util.js";

/**
 * Roots to walk: an explicit node subtree, or every node in the current
 * selection.
 */
async function resolveRoots(nodeId: unknown): Promise<SceneNode[]> {
  if (typeof nodeId === "string" && nodeId.length > 0) {
    return [await requireNode(nodeId)];
  }
  const sel = figma.currentPage.selection;
  return [...sel];
}

/**
 * set_selection_colors: recursively recolor SOLID fills (and strokes unless
 * disabled) across the node subtree or current selection. Iterative stack walk,
 * never unbounded recursion. When `from` is provided only fills matching that
 * hex are replaced; otherwise all solid fills become `to`.
 */
export async function setSelectionColors(
  ctx: HandlerContext,
): Promise<unknown> {
  const p = ctx.params;
  const to = String(p.to ?? "");
  if (!isHexColor(to)) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      `set_selection_colors requires a valid "to" hex color (got "${p.to}").`,
      'Pass to:"#rrggbb".',
    );
  }
  const from = typeof p.from === "string" ? p.from : undefined;
  if (from !== undefined && !isHexColor(from)) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      `"from" must be a hex color when provided (got "${from}").`,
      'Omit "from" to recolor all solid fills, or pass from:"#rrggbb".',
    );
  }
  const includeStrokes = p.includeStrokes !== false; // default true
  const toRgb = hexToRgb(to);

  const roots = await resolveRoots(p.nodeId);
  if (roots.length === 0) {
    return {
      changed: 0,
      hint: "Selection empty — select node(s) in Figma or pass nodeId.",
    };
  }

  let changed = 0;
  const stack: SceneNode[] = [...roots];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if ("fills" in n) {
      changed += recolorPaintList(n as GeometryMixin, "fills", from, toRgb);
    }
    if (includeStrokes && "strokes" in n) {
      changed += recolorPaintList(n as GeometryMixin, "strokes", from, toRgb);
    }
    if ("children" in n) stack.push(...(n as ChildrenMixin).children);
  }

  return { changed };
}

/** Recolor a node's fills/strokes array in place; returns count changed. */
function recolorPaintList(
  node: GeometryMixin,
  field: "fills" | "strokes",
  from: string | undefined,
  toRgb: { r: number; g: number; b: number },
): number {
  const paints = node[field];
  if (paints === figma.mixed || !Array.isArray(paints)) return 0;
  let changed = 0;
  const next = paints.map((paint) => {
    if (paint.type !== "SOLID") return paint;
    if (!shouldRecolor(paint.color, from)) return paint;
    changed++;
    return { ...paint, color: toRgb };
  });
  if (changed > 0) node[field] = next as Paint[];
  return changed;
}

/**
 * set_gradient: build a GradientPaint with sensible default gradientTransform
 * (packaging the tricky affine matrix) and set it on fills or strokes.
 */
export async function setGradient(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const node = await requireNode(p.nodeId ?? p.id);
  const target = p.target === "strokes" ? "strokes" : "fills";
  if (!(target in node)) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      `Node type ${node.type} has no ${target}.`,
      "Pick a node that supports paints (frame, rectangle, text, ...).",
    );
  }

  let paintType: string;
  try {
    paintType = gradientPaintType(String(p.type ?? "LINEAR"));
  } catch (e) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      e instanceof Error ? e.message : String(e),
      "Use type: LINEAR|RADIAL|ANGULAR|DIAMOND.",
    );
  }

  let stops;
  try {
    stops = normalizeGradientStops(p.stops);
  } catch (e) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      e instanceof Error ? e.message : String(e),
      'Pass stops:[{position:0..1, color:"#rrggbb", opacity?}].',
    );
  }

  let transform: number[][];
  if (p.transform !== undefined) {
    if (!isValidGradientTransform(p.transform)) {
      throw err(
        ErrorCode.INVALID_PARAMS,
        "transform must be a 2x3 numeric matrix [[a,b,c],[d,e,f]].",
        "Omit transform to use the sensible default for this gradient type.",
      );
    }
    transform = p.transform;
  } else {
    transform = defaultGradientTransform(paintType);
  }

  const paint = {
    type: paintType,
    gradientTransform: transform as unknown as Transform,
    gradientStops: stops.map((s) => ({
      position: s.position,
      color: s.color,
    })) as ColorStop[],
  } as GradientPaint;

  (node as GeometryMixin)[target] = [paint];
  return {
    id: node.id,
    target,
    type: paintType,
    stops: stops.length,
    node: serializeNode(node, "compact"),
  };
}

/**
 * set_effects: normalize a list of effect specs into Figma Effect[] (shadows
 * carry color/offset/spread/blendMode; blurs carry only radius) and set them on
 * the node. Packages the effect shape agents commonly get wrong.
 */
export async function setEffects(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const node = await requireNode(p.nodeId ?? p.id);
  if (!("effects" in node)) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      `Node type ${node.type} does not support effects.`,
      "Pick a node with a fill/blend surface (frame, rectangle, text, ...).",
    );
  }

  let normalized;
  try {
    normalized = normalizeEffects(p.effects);
  } catch (e) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      e instanceof Error ? e.message : String(e),
      'Pass effects:[{type:"DROP_SHADOW", color:"#000", offset:{x,y}, radius, spread?}] or {type:"LAYER_BLUR", radius}.',
    );
  }

  (node as BlendMixin).effects = normalized as unknown as Effect[];
  return {
    id: node.id,
    effects: normalized.length,
    node: serializeNode(node, "compact"),
  };
}
