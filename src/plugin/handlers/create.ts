/// <reference types="@figma/plugin-typings" />
import { HandlerContext } from "../context.js";
import { resolveParent, insertInto } from "../insert.js";
import { toPaints, toEffects } from "../paints.js";
import { loadFontWithFallback, DEFAULT_FONT } from "../fonts.js";
import { serializeNode } from "../serialize.js";
import { applyTextAlign } from "./text.js";
import { err } from "../errors.js";
import { ErrorCode } from "../../shared/protocol.js";
import {
  resolveGeometry,
  needsParent,
  overflowsParent,
  wrapLineHeight,
  Box,
  Inset,
  GeometryRequest,
  InsertAt,
  normalizePadding,
  resolveUniformCornerRadius,
  usesTransparentContainerDefault,
} from "../layout-math.js";
import { isHexColor } from "../color-util.js";

type NodeType =
  | "FRAME"
  | "TEXT"
  | "RECTANGLE"
  | "ELLIPSE"
  | "LINE"
  | "COMPONENT"
  | "INSTANCE";

/**
 * Spec-based node creation. Supports inset/align geometry, insertAt z-order,
 * TEXT wrap, auto counterAxisSizingMode for child auto-layout under a fixed
 * parent, and clip-bounds / opacity warnings.
 */
export async function create(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const type = String(p.type ?? "FRAME").toUpperCase() as NodeType;
  const parent = await resolveParent(p.parentId);
  const parentBox = parentSize(parent);

  const geoReq: GeometryRequest = {
    x: numOr(p.x),
    y: numOr(p.y),
    w: numOr(p.w ?? p.width),
    h: numOr(p.h ?? p.height),
    inset: p.inset as Inset | undefined,
    align: p.align as GeometryRequest["align"],
  };
  if (needsParent(geoReq) && !parentBox) {
    ctx.warn(
      "inset/align requested but parent has no measurable size; used raw coordinates.",
    );
  }

  const node = await createNode(type, p);
  if (typeof p.name === "string") node.name = p.name;

  // Figma creates FRAME/COMPONENT nodes with a white fill. Most frames an
  // agent creates are structural auto-layout wrappers, so that default turns
  // innocent wrappers into large white slabs that cover their background and
  // hide light text. Omitted fill now means transparent; visible surfaces must
  // opt in with `fill`/`fills` (or bind a token immediately afterwards).
  if (usesTransparentContainerDefault(type, p) && "fills" in node) {
    (node as GeometryMixin).fills = [];
  }

  // Insert into parent first so parent-relative sizing/layout applies.
  insertInto(parent, node, p.insertAt as InsertAt | undefined);

  if (type === "TEXT") {
    await applyText(node as TextNode, ctx, parent);
  }

  applyGeometry(node, geoReq, parentBox, parent, type);
  applyVisuals(node, p, ctx, type);

  if ((type === "FRAME" || type === "COMPONENT") && p.layoutMode) {
    applyAutoLayout(node as FrameNode, p, parent, ctx);
  }

  // layoutAlign/layoutGrow govern how THIS node behaves as a child of an
  // auto-layout parent (e.g. STRETCH → fill the cross axis / full-width).
  // They apply to any node type, so they live outside applyAutoLayout (which
  // only runs for frames that are themselves auto-layouts). Without this,
  // `create({ layoutAlign: "STRETCH" })` was silently dropped while
  // `modify(id, { layoutAlign: "STRETCH" })` worked — the root cause of
  // buttons/inputs rendering hug-width instead of full-width.
  applyChildLayout(node, p);

  warnIfClipped(node, parent, ctx);
  warnIfLooksInvisible(node, p, parent, ctx);

  const out: Record<string, unknown> = {
    id: node.id,
    node: serializeNode(node, "compact"),
  };
  const fr = (ctx as unknown as { fontResolution?: unknown }).fontResolution;
  if (fr) out.font = fr;
  return out;
}

async function createNode(
  type: NodeType,
  p: Record<string, unknown>,
): Promise<SceneNode> {
  switch (type) {
    case "FRAME":
      return figma.createFrame();
    case "TEXT":
      return figma.createText();
    case "RECTANGLE":
      return figma.createRectangle();
    case "ELLIPSE":
      return figma.createEllipse();
    case "LINE":
      return figma.createLine();
    case "COMPONENT":
      return figma.createComponent();
    case "INSTANCE": {
      const compId = String(p.componentId ?? "");
      const comp = await figma.getNodeByIdAsync(compId);
      if (!comp || comp.type !== "COMPONENT") {
        throw err(
          ErrorCode.NODE_NOT_FOUND,
          `componentId "${compId}" is not a COMPONENT.`,
          "Use find_component / find_or_create_component to obtain a component id first.",
        );
      }
      return (comp as ComponentNode).createInstance();
    }
    default:
      throw err(
        ErrorCode.INVALID_PARAMS,
        `Unsupported create type "${String(type)}".`,
        "Use FRAME/TEXT/RECTANGLE/ELLIPSE/LINE/COMPONENT/INSTANCE.",
      );
  }
}

export function parentSize(parent: BaseNode): { w: number; h: number } | null {
  if ("width" in parent && "height" in parent) {
    return {
      w: (parent as LayoutMixin).width,
      h: (parent as LayoutMixin).height,
    };
  }
  return null;
}

function numOr(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

async function applyText(
  node: TextNode,
  ctx: HandlerContext,
  parent: BaseNode,
): Promise<void> {
  const p = ctx.params;
  // Accept both the flat fontFamily/fontStyle spelling and the Figma-native
  // fontName:{family,style} object. Previously only the flat form was read, so
  // create({ fontName:{family:"X"} }) was silently ignored — the font fell back
  // to Inter AND requestedFont reported Inter instead of the family asked for.
  const fontName = (p.fontName ?? {}) as { family?: unknown; style?: unknown };
  const family =
    typeof p.fontFamily === "string"
      ? p.fontFamily
      : typeof fontName.family === "string"
        ? fontName.family
        : DEFAULT_FONT.family;
  const style =
    typeof p.fontStyle === "string"
      ? p.fontStyle
      : typeof fontName.style === "string"
        ? fontName.style
        : DEFAULT_FONT.style;
  const res = await loadFontWithFallback({ family, style });
  node.fontName = res.resolvedFont;
  if (res.substituted && res.reason) ctx.warn(res.reason);

  if (typeof p.fontSize === "number") node.fontSize = p.fontSize;
  if (typeof p.characters === "string") node.characters = p.characters;
  else if (typeof p.text === "string") node.characters = p.text;

  // Content alignment inside the text box (textAlignHorizontal/Vertical). This
  // is what "center the text" means; `align` positions the whole node instead.
  applyTextAlign(node, p);

  if (p.wrap === true) {
    node.textAutoResize = "HEIGHT";
    node.layoutAlign = "STRETCH";
    const size = typeof node.fontSize === "number" ? node.fontSize : 16;
    node.lineHeight = { value: wrapLineHeight(size), unit: "PIXELS" };
    if (!parentHasFixedWidth(parent)) {
      ctx.warn(
        "wrap:true set but parent has no fixed width; wrapped text may not constrain. Set the parent to a fixed width.",
      );
    }
  }

  (ctx as unknown as { fontResolution?: unknown }).fontResolution = {
    requestedFont: res.requestedFont,
    resolvedFont: res.resolvedFont,
    reason: res.reason,
  };
}

function parentHasFixedWidth(parent: BaseNode): boolean {
  if (!("width" in parent)) return false;
  if (!("layoutMode" in parent)) return true;
  const f = parent as FrameNode;
  return f.layoutMode === "NONE" || f.counterAxisSizingMode === "FIXED";
}

function applyGeometry(
  node: SceneNode,
  geoReq: GeometryRequest,
  parentBox: { w: number; h: number } | null,
  parent: BaseNode,
  type: NodeType,
): void {
  if (!("x" in node)) return;
  const layout = node as LayoutMixin;
  const box: Box = parentBox
    ? resolveGeometry(geoReq, parentBox)
    : {
        x: geoReq.x ?? 0,
        y: geoReq.y ?? 0,
        w: geoReq.w ?? layout.width,
        h: geoReq.h ?? layout.height,
      };

  const wantW = geoReq.w !== undefined || hasHInset(geoReq.inset);
  const wantH = geoReq.h !== undefined || hasVInset(geoReq.inset);
  const canResize = "resize" in node && type !== "LINE";
  if (canResize && (wantW || wantH)) {
    const w = Math.max(0.01, wantW ? box.w : layout.width);
    let h = Math.max(0.01, wantH ? box.h : layout.height);
    if (type === "TEXT" && (node as TextNode).textAutoResize === "HEIGHT") {
      h = (node as TextNode).height;
    }
    (node as unknown as { resize(w: number, h: number): void }).resize(w, h);
  }

  const managed =
    "layoutMode" in parent && (parent as FrameNode).layoutMode !== "NONE";
  if (!managed) {
    layout.x = box.x;
    layout.y = box.y;
  }
}

function hasHInset(inset?: Inset): boolean {
  return (
    !!inset && (typeof inset.left === "number" || typeof inset.right === "number")
  );
}
function hasVInset(inset?: Inset): boolean {
  return (
    !!inset && (typeof inset.top === "number" || typeof inset.bottom === "number")
  );
}

function applyVisuals(
  node: SceneNode,
  p: Record<string, unknown>,
  ctx: HandlerContext,
  type: NodeType,
): void {
  if (p.fills !== undefined && "fills" in node) {
    (node as GeometryMixin).fills = toPaints(p.fills);
    warnTokenLiteral(p.fills, ctx);
  } else if (
    typeof p.fill === "string" &&
    isHexColor(p.fill) &&
    "fills" in node
  ) {
    (node as GeometryMixin).fills = toPaints(p.fill);
  }
  if (p.strokes !== undefined && "strokes" in node) {
    (node as GeometryMixin).strokes = toPaints(p.strokes);
  }
  if (typeof p.strokeWeight === "number" && "strokeWeight" in node) {
    (node as MinimalStrokesMixin).strokeWeight = p.strokeWeight;
  }
  if (p.effects !== undefined && "effects" in node) {
    (node as BlendMixin).effects = toEffects(p.effects);
  }
  applyCornerRadii(node, p);
  if (typeof p.opacity === "number" && "opacity" in node) {
    (node as BlendMixin).opacity = p.opacity;
    if (type === "FRAME" && p.opacity < 1) {
      ctx.warn(
        "opacity < 1 on a FRAME dims its entire subtree; use figma.overlay({ color, opacity, parentId }) for a scrim rectangle.",
      );
    }
  }
}

function warnTokenLiteral(fills: unknown, ctx: HandlerContext): void {
  const arr = Array.isArray(fills) ? fills : [fills];
  for (const f of arr) {
    if (typeof f === "string" && isHexColor(f)) {
      ctx.warn(
        "Using a raw hex fill; if a matching design token exists, prefer apply_variable for theme-awareness.",
      );
      return;
    }
  }
}

function applyAutoLayout(
  node: FrameNode,
  p: Record<string, unknown>,
  parent: BaseNode,
  ctx: HandlerContext,
): void {
  const mode = String(p.layoutMode).toUpperCase();
  if (mode === "HORIZONTAL" || mode === "VERTICAL") node.layoutMode = mode;
  if (typeof p.itemSpacing === "number") node.itemSpacing = p.itemSpacing;
  const pad = normalizePadding(p);
  if (typeof pad.left === "number") node.paddingLeft = pad.left;
  if (typeof pad.right === "number") node.paddingRight = pad.right;
  if (typeof pad.top === "number") node.paddingTop = pad.top;
  if (typeof pad.bottom === "number") node.paddingBottom = pad.bottom;
  if (typeof p.primaryAxisSizingMode === "string") {
    node.primaryAxisSizingMode = p.primaryAxisSizingMode as "FIXED" | "AUTO";
  }
  if (typeof p.counterAxisSizingMode === "string") {
    node.counterAxisSizingMode = p.counterAxisSizingMode as "FIXED" | "AUTO";
  } else if (parentHasFixedWidth(parent)) {
    node.counterAxisSizingMode = "FIXED";
    ctx.warn(
      "Auto-layout child under a fixed parent defaulted to counterAxisSizingMode:FIXED. Set it explicitly to override.",
    );
  }
  // How this frame aligns its OWN children (e.g. center a button's label).
  if (typeof p.primaryAxisAlignItems === "string") {
    node.primaryAxisAlignItems = p.primaryAxisAlignItems as
      | "MIN"
      | "MAX"
      | "CENTER"
      | "SPACE_BETWEEN";
  }
  if (typeof p.counterAxisAlignItems === "string") {
    node.counterAxisAlignItems = p.counterAxisAlignItems as
      | "MIN"
      | "MAX"
      | "CENTER"
      | "BASELINE";
  }
}

/**
 * Apply the child-in-auto-layout properties (`layoutAlign`, `layoutGrow`) that
 * decide how a node stretches/grows inside an auto-layout parent. Mirrors the
 * same handling in the `modify` handler so create and modify stay in sync.
 * Guarded by `"layoutAlign" in node` so it is a no-op for nodes that can never
 * be auto-layout children.
 */
function applyChildLayout(node: SceneNode, p: Record<string, unknown>): void {
  if ("layoutAlign" in node && typeof p.layoutAlign === "string") {
    (node as LayoutMixin).layoutAlign = p.layoutAlign as
      | "MIN"
      | "CENTER"
      | "MAX"
      | "STRETCH"
      | "INHERIT";
  }
  if ("layoutGrow" in node && typeof p.layoutGrow === "number") {
    (node as LayoutMixin).layoutGrow = p.layoutGrow;
  }
}

function warnIfClipped(
  node: SceneNode,
  parent: BaseNode,
  ctx: HandlerContext,
): void {
  if (!("clipsContent" in parent) || !(parent as FrameNode).clipsContent) return;
  const pb = parentSize(parent);
  if (!pb || !("x" in node)) return;
  const layout = node as LayoutMixin;
  const box: Box = {
    x: layout.x,
    y: layout.y,
    w: "width" in node ? layout.width : 0,
    h: "height" in node ? layout.height : 0,
  };
  if (overflowsParent(box, pb)) {
    ctx.warn(
      `Node will be clipped by its parent (bounds ${round(box.x)},${round(box.y)} ${round(box.w)}×${round(box.h)} exceed parent ${round(pb.w)}×${round(pb.h)}).`,
    );
  }
}

/**
 * Nudge the agent when a freshly-created node will hug-width where full-width
 * was almost certainly intended. Transparent structural frames are normal and
 * intentionally do not trigger a warning.
 */
function warnIfLooksInvisible(
  node: SceneNode,
  p: Record<string, unknown>,
  parent: BaseNode,
  ctx: HandlerContext,
): void {
  // A child of a vertical auto-layout parent that didn't ask for STRETCH
  //    and isn't a full-width helper will hug its content (the button bug).
  if (
    (node.type === "FRAME" ||
      node.type === "COMPONENT" ||
      node.type === "INSTANCE") &&
    parent &&
    "layoutMode" in parent &&
    (parent as FrameNode).layoutMode === "VERTICAL" &&
    "layoutAlign" in node &&
    (node as LayoutMixin).layoutAlign !== "STRETCH" &&
    p.layoutAlign === undefined &&
    p.width === undefined &&
    p.w === undefined &&
    p.inset === undefined
  ) {
    ctx.warn(
      "Child of a vertical layout without layoutAlign:\"STRETCH\" or an explicit width will hug its content (not full-width). Add layoutAlign:\"STRETCH\" for buttons/inputs/cards.",
    );
  }
}

function applyCornerRadii(
  node: SceneNode,
  p: Record<string, unknown>,
): void {
  const uniform = resolveUniformCornerRadius(p);
  if (uniform !== undefined && "cornerRadius" in node) {
    (node as RectangleNode).cornerRadius = uniform;
  }

  for (const key of [
    "topLeftRadius",
    "topRightRadius",
    "bottomRightRadius",
    "bottomLeftRadius",
  ] as const) {
    if (typeof p[key] === "number" && key in node) {
      (node as unknown as Record<typeof key, number>)[key] = p[key] as number;
    }
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
