/// <reference types="@figma/plugin-typings" />
import { HandlerContext, requireNode, getNodeByIdSafe } from "../context.js";
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
  normalizeReactions,
  NormalizedReaction,
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

  const tally = { changed: 0, skippedBound: 0 };
  const stack: SceneNode[] = [...roots];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if ("fills" in n) {
      recolorPaintList(n as GeometryMixin, "fills", from, toRgb, tally);
    }
    if (includeStrokes && "strokes" in n) {
      recolorPaintList(n as GeometryMixin, "strokes", from, toRgb, tally);
    }
    if ("children" in n) stack.push(...(n as ChildrenMixin).children);
  }

  if (tally.skippedBound > 0) {
    ctx.warn(
      `${tally.skippedBound} matching paint(s) are bound to a color variable and were left as they are. Change the variable's value to recolor everything using that token, or rebind those layers to a different variable.`,
    );
    return tally;
  }
  return { changed: tally.changed };
}

/**
 * Recolor a node's fills/strokes array in place, adding to the tally.
 *
 * A paint bound to a color variable is skipped, not recolored. Figma renders a
 * bound paint from the variable, so `{...paint, color}` kept
 * boundVariables.color and changed nothing on screen while the op counted it
 * as changed. Stripping the binding instead would make the colour change, but
 * a bulk recolor over a subtree would then quietly detach every design token
 * it touched — the kind of damage nobody notices until the theme changes. So
 * the op stays honest the other way: it counts those paints as skipped and
 * says how to change them on purpose.
 */
function recolorPaintList(
  node: GeometryMixin,
  field: "fills" | "strokes",
  from: string | undefined,
  toRgb: { r: number; g: number; b: number },
  tally: { changed: number; skippedBound: number },
): void {
  const paints = node[field];
  if (paints === figma.mixed || !Array.isArray(paints)) return;
  let changed = 0;
  const next = paints.map((paint) => {
    if (paint.type !== "SOLID") return paint;
    if (!shouldRecolor(paint.color, from)) return paint;
    if ((paint as SolidPaint).boundVariables?.color) {
      tally.skippedBound++;
      return paint;
    }
    changed++;
    return { ...paint, color: toRgb };
  });
  if (changed > 0) node[field] = next as Paint[];
  tally.changed += changed;
}

/**
 * set_gradient: build a GradientPaint with sensible default gradientTransform
 * (packaging the tricky affine matrix) and set it on fills or strokes.
 */
export async function setGradient(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const node = await requireNode(p.nodeId ?? p.id);
  // Singular and plural both land ("fill"/"fills", "stroke"/"strokes") —
  // the docs spell it "stroke". Anything else is a param error, not a silent
  // guess: before this, target:"stroke" quietly repainted the FILLS, the
  // exact opposite of what was asked.
  const targetRaw =
    p.target === undefined || p.target === null
      ? "fills"
      : String(p.target).toLowerCase();
  const target: "fills" | "strokes" | null =
    targetRaw === "fill" || targetRaw === "fills"
      ? "fills"
      : targetRaw === "stroke" || targetRaw === "strokes"
        ? "strokes"
        : null;
  if (!target) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      `set_gradient target must be "fill"/"fills" or "stroke"/"strokes" (got ${JSON.stringify(p.target)}).`,
      'Omit target to paint fills, or pass target:"stroke" for the border.',
    );
  }
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

/**
 * set_reactions: replace a node's prototype reactions (click→navigate wiring).
 * Normalizes the flexible {trigger, action} input into Figma Reaction[] and
 * verifies every NODE-action destination exists before writing — enum or
 * destination mistakes throw INVALID_PARAMS, never a silent no-op.
 */
export async function setReactions(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const node = await requireNode(p.nodeId ?? p.id);
  if (!("reactions" in node)) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      `Node type ${node.type} does not support reactions.`,
      "Wire reactions on a frame, instance, group, or shape (any SceneNode with prototype support).",
    );
  }

  let normalized: NormalizedReaction[];
  try {
    normalized = normalizeReactions(p.reactions);
  } catch (e) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      e instanceof Error ? e.message : String(e),
      'Pass reactions:[{trigger:{type:"ON_CLICK"}, action:{type:"NODE", destinationId, navigation:"NAVIGATE", transition?}}] — [] clears all.',
    );
  }

  for (const reaction of normalized) {
    for (const action of reaction.actions) {
      if (action.type !== "NODE") continue;
      const destId = String(action.destinationId);
      const dest = await getNodeByIdSafe(destId);
      if (!dest) {
        throw err(
          ErrorCode.INVALID_PARAMS,
          `Reaction destination "${destId}" does not exist.`,
          "Pass the id of an existing node (usually a top-level frame) as destinationId — get ids via getDocumentInfo or searchNodes.",
        );
      }
    }
  }

  // node.reactions is readonly under dynamic-page manifests — prefer the
  // setReactionsAsync API and fall back to assignment on older runtimes.
  const target = node as SceneNode & {
    setReactionsAsync?: (reactions: unknown) => Promise<void>;
    reactions?: unknown;
  };
  if (typeof target.setReactionsAsync === "function") {
    await target.setReactionsAsync(normalized);
  } else {
    target.reactions = normalized;
  }
  return {
    id: node.id,
    reactions: normalized.length,
    node: serializeNode(node, "compact"),
  };
}
