/// <reference types="@figma/plugin-typings" />
import { HandlerContext, requireNode, isParentNode } from "../context.js";
import { resolveParent, insertInto } from "../insert.js";
import { toPaints, toEffects } from "../paints.js";
import { loadNodeFonts, loadFontWithFallback, DEFAULT_FONT } from "../fonts.js";
import { serializeNode } from "../serialize.js";
import { applyTextAlign } from "./text.js";
import { err, nodeNotFound } from "../errors.js";
import { ErrorCode } from "../../shared/protocol.js";
import {
  InsertAt,
  normalizePadding,
  resolveUniformCornerRadius,
} from "../layout-math.js";
import { isHexColor } from "../color-util.js";

/**
 * General property setter: fills/strokes/effects, auto-layout, text, geometry.
 * Re-applies textAutoResize after any reparent to dodge the Figma quirk where
 * moving a text node can reset its sizing behaviour.
 */
export async function modify(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const node = await requireNode(p.nodeId ?? p.id);
  const props = (p.props ?? p) as Record<string, unknown>;

  if (props.name !== undefined && typeof props.name === "string") {
    node.name = props.name;
  }

  // Text props first (need font loaded before characters).
  if (node.type === "TEXT") {
    await modifyText(node as TextNode, props, ctx);
  }

  if (props.fills !== undefined && "fills" in node) {
    (node as GeometryMixin).fills = toPaints(props.fills);
  } else if (
    typeof props.fill === "string" &&
    isHexColor(props.fill) &&
    "fills" in node
  ) {
    (node as GeometryMixin).fills = toPaints(props.fill);
  }
  if (props.strokes !== undefined && "strokes" in node) {
    (node as GeometryMixin).strokes = toPaints(props.strokes);
  }
  if (typeof props.strokeWeight === "number" && "strokeWeight" in node) {
    (node as MinimalStrokesMixin).strokeWeight = props.strokeWeight;
  }
  if (props.effects !== undefined && "effects" in node) {
    (node as BlendMixin).effects = toEffects(props.effects);
  }
  if (typeof props.opacity === "number" && "opacity" in node) {
    (node as BlendMixin).opacity = props.opacity;
  }
  applyCornerRadii(node, props);
  if (typeof props.visible === "boolean") node.visible = props.visible;
  if (typeof props.rotation === "number" && "rotation" in node) {
    (node as LayoutMixin).rotation = props.rotation;
  }

  // Auto-layout props.
  if ("layoutMode" in node) {
    applyLayoutProps(node as FrameNode, props);
  }

  // Geometry.
  if (
    (typeof props.x === "number" || typeof props.y === "number") &&
    "x" in node
  ) {
    if (typeof props.x === "number") (node as LayoutMixin).x = props.x;
    if (typeof props.y === "number") (node as LayoutMixin).y = props.y;
  }
  // Accept both w/h and width/height (create takes both; modify used to accept
  // only w/h, so modify(id,{width,height}) silently dropped the resize).
  const reqW = typeof props.w === "number" ? props.w : (typeof props.width === "number" ? props.width : undefined);
  const reqH = typeof props.h === "number" ? props.h : (typeof props.height === "number" ? props.height : undefined);
  if ((reqW !== undefined || reqH !== undefined) && "resize" in node) {
    const l = node as LayoutMixin;
    const w = reqW !== undefined ? reqW : l.width;
    const h = reqH !== undefined ? reqH : l.height;
    (node as unknown as { resize(w: number, h: number): void }).resize(
      Math.max(0.01, w),
      Math.max(0.01, h),
    );
  }

  // Re-apply text sizing after any potential reparent quirk.
  if (node.type === "TEXT" && typeof props.textAutoResize === "string") {
    (node as TextNode).textAutoResize = props.textAutoResize as
      | "NONE"
      | "WIDTH_AND_HEIGHT"
      | "HEIGHT"
      | "TRUNCATE";
  }

  return { id: node.id, node: serializeNode(node, "compact") };
}

async function modifyText(
  node: TextNode,
  props: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<void> {
  const fontName = (props.fontName ?? {}) as { family?: unknown; style?: unknown };
  const hasFamily = typeof props.fontFamily === "string" || typeof fontName.family === "string";
  const hasStyle = typeof props.fontStyle === "string" || typeof fontName.style === "string";
  if (hasFamily || hasStyle) {
    const family =
      typeof props.fontFamily === "string"
        ? props.fontFamily
        : typeof fontName.family === "string"
          ? fontName.family
          : DEFAULT_FONT.family;
    const style =
      typeof props.fontStyle === "string"
        ? props.fontStyle
        : typeof fontName.style === "string"
          ? fontName.style
          : DEFAULT_FONT.style;
    const res = await loadFontWithFallback({ family, style });
    node.fontName = res.resolvedFont;
    if (res.substituted && res.reason) ctx.warn(res.reason);
  } else {
    await loadNodeFonts(node);
  }
  if (typeof props.fontSize === "number") node.fontSize = props.fontSize;
  if (typeof props.characters === "string") node.characters = props.characters;
  else if (typeof props.text === "string") node.characters = props.text;
  applyTextAlign(node, props);
}

function applyLayoutProps(node: FrameNode, props: Record<string, unknown>): void {
  const mode =
    typeof props.layoutMode === "string"
      ? props.layoutMode.toUpperCase()
      : undefined;
  if (mode === "HORIZONTAL" || mode === "VERTICAL" || mode === "NONE") {
    node.layoutMode = mode;
  }
  if (typeof props.itemSpacing === "number") node.itemSpacing = props.itemSpacing;
  const pad = normalizePadding(props);
  if (typeof pad.left === "number") node.paddingLeft = pad.left;
  if (typeof pad.right === "number") node.paddingRight = pad.right;
  if (typeof pad.top === "number") node.paddingTop = pad.top;
  if (typeof pad.bottom === "number") node.paddingBottom = pad.bottom;
  if (typeof props.primaryAxisSizingMode === "string") {
    node.primaryAxisSizingMode = props.primaryAxisSizingMode as "FIXED" | "AUTO";
  }
  if (typeof props.counterAxisSizingMode === "string") {
    node.counterAxisSizingMode = props.counterAxisSizingMode as "FIXED" | "AUTO";
  }
  if (typeof props.primaryAxisAlignItems === "string") {
    node.primaryAxisAlignItems = props.primaryAxisAlignItems as
      | "MIN"
      | "MAX"
      | "CENTER"
      | "SPACE_BETWEEN";
  }
  if (typeof props.counterAxisAlignItems === "string") {
    node.counterAxisAlignItems = props.counterAxisAlignItems as
      | "MIN"
      | "MAX"
      | "CENTER"
      | "BASELINE";
  }
  if (typeof props.layoutAlign === "string") {
    node.layoutAlign = props.layoutAlign as
      | "MIN"
      | "CENTER"
      | "MAX"
      | "STRETCH"
      | "INHERIT";
  }
  if (typeof props.layoutGrow === "number") node.layoutGrow = props.layoutGrow;
}

function applyCornerRadii(
  node: SceneNode,
  props: Record<string, unknown>,
): void {
  const uniform = resolveUniformCornerRadius(props);
  if (uniform !== undefined && "cornerRadius" in node) {
    (node as RectangleNode).cornerRadius = uniform;
  }
  for (const key of [
    "topLeftRadius",
    "topRightRadius",
    "bottomRightRadius",
    "bottomLeftRadius",
  ] as const) {
    if (typeof props[key] === "number" && key in node) {
      (node as unknown as Record<typeof key, number>)[key] = props[key] as number;
    }
  }
}

export async function deleteNode(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const node = await requireNode(p.nodeId ?? p.id);
  const force = p.force === true;
  if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
    const instances = await (node as ComponentNode).getInstancesAsync?.();
    const count = instances ? instances.length : 0;
    if (count > 0 && !force) {
      throw err(
        ErrorCode.COMPONENT_IN_USE,
        `Component "${node.name}" has ${count} instance(s).`,
        "Deleting it will detach or break those instances. Re-run with force:true to proceed.",
      );
    }
  }
  const id = node.id;
  node.remove();
  // Verify the removal actually took effect instead of reporting a blind
  // success — node.remove() can be a silent no-op for some nodes (e.g. a
  // component still referenced), which previously returned {deleted:true}
  // while the node lived on.
  if (!node.removed) {
    throw err(
      ErrorCode.INTERNAL,
      `Node "${id}" could not be removed (still present after remove()).`,
      "It may be a published/locked component or otherwise protected. Delete it in the Figma UI, or detach its instances first.",
    );
  }
  return { id, deleted: true };
}

export async function move(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const node = await requireNode(p.nodeId ?? p.id);
  if (typeof p.x === "number" && "x" in node) (node as LayoutMixin).x = p.x;
  if (typeof p.y === "number" && "y" in node) (node as LayoutMixin).y = p.y;
  if (p.parentId !== undefined) {
    const parent = await resolveParent(p.parentId);
    insertInto(parent, node, p.insertAt as InsertAt | undefined);
  } else if (p.insertAt !== undefined && node.parent && isParentNode(node.parent)) {
    insertInto(node.parent, node, p.insertAt as InsertAt);
  }
  return { id: node.id, node: serializeNode(node, "sparse") };
}

export async function resize(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const node = await requireNode(p.nodeId ?? p.id);
  if (!("resize" in node)) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      `Node type ${node.type} cannot be resized.`,
    );
  }
  const l = node as LayoutMixin;
  const w = typeof p.w === "number" ? p.w : typeof p.width === "number" ? p.width : l.width;
  const h = typeof p.h === "number" ? p.h : typeof p.height === "number" ? p.height : l.height;
  (node as unknown as { resize(w: number, h: number): void }).resize(
    Math.max(0.01, w),
    Math.max(0.01, h),
  );
  return { id: node.id, node: serializeNode(node, "sparse") };
}

export async function group(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const ids = Array.isArray(p.nodeIds) ? p.nodeIds : [];
  if (ids.length === 0) {
    throw err(ErrorCode.INVALID_PARAMS, "group requires nodeIds[].");
  }
  const nodes: SceneNode[] = [];
  for (const id of ids) nodes.push(await requireNode(id));
  const parent = nodes[0]!.parent ?? figma.currentPage;
  const g = figma.group(nodes, parent as BaseNode & ChildrenMixin);
  if (typeof p.name === "string") g.name = p.name;
  return { id: g.id, node: serializeNode(g, "compact") };
}

export async function ungroup(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const node = await requireNode(p.nodeId ?? p.id);
  if (node.type !== "GROUP" && node.type !== "FRAME") {
    throw err(
      ErrorCode.INVALID_PARAMS,
      `Only GROUP/FRAME can be ungrouped (got ${node.type}).`,
    );
  }
  const children = figma.ungroup(node as GroupNode);
  return { ids: children.map((c) => c.id) };
}

export async function flatten(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const ids: string[] = Array.isArray(p.nodeIds)
    ? p.nodeIds
    : [String(p.nodeId ?? p.id)];
  const nodes: SceneNode[] = [];
  for (const id of ids) nodes.push(await requireNode(id));
  const parent = nodes[0]!.parent as (BaseNode & ChildrenMixin) | null;
  const vector = figma.flatten(nodes, parent ?? undefined);
  return { id: vector.id, node: serializeNode(vector, "sparse") };
}

export async function setSelection(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const ids: string[] = Array.isArray(p.nodeIds)
    ? p.nodeIds
    : p.nodeId
      ? [String(p.nodeId)]
      : [];
  const nodes: SceneNode[] = [];
  for (const id of ids) {
    const n = await figma.getNodeByIdAsync(id);
    if (n && n.type !== "PAGE" && n.type !== "DOCUMENT") {
      nodes.push(n as SceneNode);
    }
  }
  figma.currentPage.selection = nodes;
  return { selection: nodes.map((n) => n.id) };
}

export async function zoomToFit(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  if (p.nodeId || p.nodeIds) {
    const ids: string[] = Array.isArray(p.nodeIds)
      ? p.nodeIds
      : [String(p.nodeId)];
    const nodes: SceneNode[] = [];
    for (const id of ids) nodes.push(await requireNode(id));
    figma.viewport.scrollAndZoomIntoView(nodes);
    return { zoomed: nodes.map((n) => n.id) };
  }
  figma.viewport.scrollAndZoomIntoView(figma.currentPage.children);
  return { zoomed: "page" };
}
