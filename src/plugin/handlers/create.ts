/// <reference types="@figma/plugin-typings" />
import { HandlerContext, getNodeByIdSafe } from "../context.js";
import { resolveParent, insertInto, isParentNode, type ParentNode } from "../insert.js";
import { toPaints, toEffects } from "../paints.js";
import { loadFontWithFallback, DEFAULT_FONT } from "../fonts.js";
import { serializeNode } from "../serialize.js";
import { applyTextAlign } from "./text.js";
import {
  resolveTextStyle,
  applyTextStyleToNode,
  resolveEffectStyle,
  applyEffectStyleToNode,
  parseLineHeight,
  parseLetterSpacing,
} from "./styles.js";
import {
  findVariableByName,
  bindVariableToField,
  expandBindableField,
} from "./tokens.js";
import { err } from "../errors.js";
import { ErrorCode } from "../../shared/protocol.js";
import {
  resolveGeometry,
  needsParent,
  overflowsParent,
  defaultLineHeight,
  Box,
  Inset,
  GeometryRequest,
  InsertAt,
  normalizePadding,
  resolveUniformCornerRadius,
  usesTransparentContainerDefault,
} from "../layout-math.js";
import { isHexColor, isRgbObject } from "../color-util.js";
import { flowCoversScreen, readFlowMarks } from "../flow-mark.js";
import { setArrowPolyline, setPolyline, setStrokeGroup, toPoints } from "../vector-path.js";
import { isDiagramFrameName, isDiagramLayerName } from "../diagram-mark.js";
import { fitArtwork } from "../fit-artwork.js";
import { keepClearOnCanvas } from "../keep-clear.js";

type NodeType =
  | "FRAME"
  | "TEXT"
  | "RECTANGLE"
  | "ELLIPSE"
  | "LINE"
  | "VECTOR"
  | "POLYGON"
  | "STAR"
  | "COMPONENT"
  | "INSTANCE"
  | "ICON";

/**
 * Spec-based node creation. Supports inset/align geometry, insertAt z-order,
 * TEXT wrap, auto counterAxisSizingMode for child auto-layout under a fixed
 * parent, clip-bounds / opacity warnings, and a nested `children` array that
 * builds a whole subtree in one call.
 */
export async function create(ctx: HandlerContext): Promise<unknown> {
  const node = await createTree(ctx);
  const out: Record<string, unknown> = {
    id: node.id,
    node: serializeNode(node, "compact"),
  };
  const fr = (ctx as unknown as { fontResolution?: unknown }).fontResolution;
  if (fr) out.font = fr;
  return out;
}

/**
 * Build a node (and its `children` subtree) and hand back the LIVE node —
 * no serialization.
 *
 * `serializeNode` reads a couple of dozen properties, and in the Figma plugin
 * sandbox every property read crosses into the editor. Doing that for each of
 * the ~250 layers a diagram is made of, and for every nested child of a
 * `create({ children: [...] })` call, is pure waste whenever the caller does
 * not read the result — which is every diagram handler: they collect ids from
 * `frame.children` afterwards. It also matters more than the numbers suggest:
 * when Figma throttles a background tab, each awaited round trip is what the
 * throttle taxes.
 */
export async function createTree(
  ctx: HandlerContext,
  parent?: ParentNode,
  /**
   * Rebuild INTO this node instead of making a new one, keeping its id.
   *
   * The id is the whole point. A COMPONENT cannot be deleted through the
   * Plugin API — remove() is a silent no-op — so the only way to change a
   * generated component without abandoning every instance a designer has
   * already placed is to rewrite the one they are pointing at. Instances bind
   * by id, so a replacement built alongside is a new component and their
   * screens keep the old one.
   *
   * The caller clears the children; everything else goes through the same
   * pipeline as a fresh build, so tokens, text styles and effects cannot
   * drift between the create path and the rebuild path.
   */
  into?: SceneNode,
): Promise<BaseNode & { id: string }> {
  const node = await buildNode(ctx, ctx.params, parent, into);

  // Nested children: build the subtree declaratively in one call. Each child
  // is created through the SAME pipeline (token binding, text style, layout),
  // parented to the node we just made. Without this the `children` array was
  // silently dropped, so `create({ children:[...] })` specs came out
  // empty. Children are created in array order (index 0 first),
  // so z-order matches declaration order.
  const kids = ctx.params.children;
  if (Array.isArray(kids)) {
    try {
      for (const raw of kids) {
        if (raw && typeof raw === "object") {
          // The node we just made IS the parent: no lookup for the subtree either.
          await createTree(
            childCtx(ctx, raw as Record<string, unknown>, node.id),
            isParentNode(node) ? node : undefined,
          );
        }
      }
    } catch (err) {
      // The parent is already on the canvas at this point — a failing child
      // would leave a half-built subtree behind. Remove what this call made
      // (never an `into` rebuild — that node pre-exists and is the user's).
      if (!into && typeof (node as SceneNode).remove === "function") {
        try {
          (node as SceneNode).remove();
        } catch {
          /* already gone */
        }
      }
      throw err;
    }
  }
  // Placed only now: a hugging frame has its real size once its children exist.
  if (!into) keepClearOnCanvas(node as SceneNode, ctx.params, ctx);
  return node;
}

/**
 * Derive a child HandlerContext: a fresh params object with `parentId` forced
 * to the parent we just created, sharing the parent's warning sink and progress
 * callback so nested warnings still surface. `parentId`/`children` from the
 * child spec are handled by the recursion itself, not inherited from the outer
 * spec.
 */
function childCtx(
  parent: HandlerContext,
  childSpec: Record<string, unknown>,
  parentId: string,
): HandlerContext {
  return {
    params: { ...childSpec, parentId },
    warnings: parent.warnings,
    progress: parent.progress,
    warn: parent.warn,
  };
}

/**
 * Create a single node from a spec (no `children` handling — that lives in
 * `create`). Returns the live node so the caller can parent children into it.
 */
async function buildNode(
  ctx: HandlerContext,
  p: Record<string, unknown>,
  known?: ParentNode,
  into?: SceneNode,
): Promise<SceneNode> {
  const type = String(p.type ?? "FRAME").toUpperCase() as NodeType;
  // A caller that already holds the live parent hands it over. Looking it up
  // again is `figma.getNodeByIdAsync` — a round trip INTO the editor — and a
  // diagram is ~250 layers, so it was ~250 of them per drawing. That is the
  // cost a throttled background tab multiplies, and how a 300ms draw became a
  // 30s timeout when nobody was looking at the Figma window.
  const parent = known ?? (await resolveParent(p.parentId));
  // Measured before the node is inserted: a group grows to fit whatever is
  // put in it, so afterwards its size and origin include the new node sitting
  // at its creation position.
  const parentBox = parentSize(parent);
  const origin = childOrigin(parent);

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

  // Resolve token bindings and text style BEFORE creating the node so a bad
  // token/style name fails fast instead of leaving an orphan half-styled node.
  const tokenBindings = await resolveTokenBindings(p);
  const textStyle =
    type === "TEXT" && typeof p.textStyle === "string"
      ? await resolveTextStyle(p.textStyle)
      : null;
  // Same fail-fast rule for elevation. Resolving it here means a wrong name is
  // an error the caller can act on, rather than a card that silently ships
  // flat — which is what `effectStyle` did while nothing read the key at all.
  const effectStyle =
    typeof p.effectStyle === "string" ? await resolveEffectStyle(p.effectStyle) : null;

  const node = into ?? (await createNode(type, p));
  if (typeof p.name === "string") node.name = p.name;

  // Figma creates FRAME/COMPONENT nodes with a white fill. Most frames an
  // agent creates are structural auto-layout wrappers, so that default turns
  // innocent wrappers into large white slabs that cover their background and
  // hide light text. Omitted fill now means transparent; visible surfaces must
  // opt in with `fill`/`fills` (or bind a token immediately afterwards).
  if (usesTransparentContainerDefault(type, p) && "fills" in node) {
    (node as GeometryMixin).fills = [];
  }

  // Insert into parent first so parent-relative sizing/layout applies. A
  // rebuild is already where it belongs — re-inserting would move it to the
  // end of its parent and lose its place in the variant grid.
  if (!into) insertInto(parent, node, p.insertAt as InsertAt | undefined);

  if (type === "TEXT") {
    await applyText(node as TextNode, ctx, parent);
    if (textStyle) {
      if (typeof p.fontSize === "number" || typeof p.fontFamily === "string") {
        ctx.warn(
          `textStyle "${textStyle.name}" overrides the fontSize/fontFamily also passed in this spec.`,
        );
      }
      await applyTextStyleToNode(node as TextNode, textStyle);
    }
  }

  applyGeometry(node, geoReq, parentBox, origin, parent, type);
  await applyVectorPath(node, p, type, ctx);
  applyVisuals(node, p, ctx, type);
  if (type === "ICON") {
    const size = typeof p.size === "number" ? p.size : node.width;
    fitArtwork(node, size);
  }
  if (effectStyle) {
    if (p.effects !== undefined) {
      ctx.warn(
        `effectStyle "${effectStyle.name}" overrides the raw effects also passed in this spec.`,
      );
    }
    await applyEffectStyleToNode(node, effectStyle);
  }

  if ((type === "FRAME" || type === "COMPONENT") && p.layoutMode) {
    applyAutoLayout(node as FrameNode, p, parent, ctx);
  }

  // layoutAlign/layoutGrow govern how THIS node behaves as a child of an
  // auto-layout parent (e.g. STRETCH → fill the cross axis / full-width).
  // They apply to any node type, so they live outside applyAutoLayout (which
  // only runs for frames that are themselves auto-layouts). Without this,
  // `create({ layoutAlign: "STRETCH" })` was silently dropped — the root cause
  // of buttons/inputs rendering hug-width instead of full-width. modify has
  // the same non-frame branch.
  applyChildLayout(node, p);

  // Token bindings go last so they land on final paints/layout (autoLayout
  // must exist before paddings/itemSpacing can bind).
  for (const b of tokenBindings) {
    bindVariableToField(node, b.field, b.variable);
  }
  if (type === "ICON") await bindArtworkInk(node, p);

  // Rotation last: it is stored in relativeTransform, so setting it before
  // x/y/resize would be undone by them. Creating a rotated node used to need a
  // second modify() round-trip; now one create is enough.
  if (typeof p.rotation === "number" && "rotation" in node) {
    (node as LayoutMixin).rotation = p.rotation;
  }

  warnIfClipped(node, parent, ctx);
  warnAboutUserflow(node, parent, ctx);
  warnIfLooksInvisible(node, p, parent, ctx);
  warnIfWrapperFillMatchesParent(node, parent, ctx);

  // TEXT with no color source renders in Figma's native pure black (#000000),
  // the classic "unfinished wireframe" look. A textStyle usually carries a
  // color, and an explicit fill / $token fill is a color; anything else means
  // the caller forgot. Warn (don't force a value — we don't know the palette).
  if (type === "TEXT" && !textStyle) {
    const hasFillLiteral =
      p.fills !== undefined ||
      (typeof p.fill === "string" && (p.fill as string).length > 0) ||
      isRgbObject(p.fill);
    const hasFillToken = tokenBindings.some((b) => b.field === "fills");
    if (!hasFillLiteral && !hasFillToken) {
      ctx.warn(
        "TEXT created without a color — it will render pure black (#000000), which looks like an unfinished wireframe. Set fill:\"$color/ink\" (or a hex), or apply a textStyle that carries a color. See figma_docs(section=\"style\").",
      );
    }
  }

  return node;
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
    case "VECTOR":
      return figma.createVector();
    case "POLYGON": {
      const poly = figma.createPolygon();
      // pointCount 4 is the userflow diamond; 3 is the default triangle.
      if (typeof p.pointCount === "number") poly.pointCount = Math.max(3, Math.round(p.pointCount));
      return poly;
    }
    case "STAR": {
      const star = figma.createStar();
      if (typeof p.pointCount === "number") star.pointCount = Math.max(3, Math.round(p.pointCount));
      if (typeof p.innerRadius === "number") star.innerRadius = p.innerRadius;
      return star;
    }
    case "COMPONENT":
      return figma.createComponent();
    case "INSTANCE": {
      const compId = String(p.componentId ?? "");
      const comp = await getNodeByIdSafe(compId);
      if (!comp || comp.type !== "COMPONENT") {
        throw err(
          ErrorCode.NODE_NOT_FOUND,
          `componentId "${compId}" is not a COMPONENT.`,
          "Use find_component / find_or_create_component to obtain a component id first.",
        );
      }
      return (comp as ComponentNode).createInstance();
    }
    case "ICON": {
      const svg = typeof p.svg === "string" ? p.svg : "";
      if (!svg) {
        throw err(
          ErrorCode.INVALID_PARAMS,
          "type:\"ICON\" needs an svg string.",
          "Put the Lucide markup on the spec. generate already does this.",
        );
      }
      return figma.createNodeFromSvg(svg);
    }
    default:
      throw err(
        ErrorCode.INVALID_PARAMS,
        `Unsupported create type "${String(type)}".`,
        "Use FRAME/TEXT/RECTANGLE/ELLIPSE/LINE/VECTOR/POLYGON/STAR/COMPONENT/INSTANCE/ICON.",
      );
  }
}

/**
 * Where a parent's own top-left sits in the coordinate space its children's
 * x/y are written in. A frame starts its children at 0,0, but a GROUP or
 * BOOLEAN_OPERATION is not a coordinate space at all: its children are placed
 * in the nearest frame's coordinates, so the group's own x/y is the origin.
 * Treating it as 0,0 put `inset:{left:8}` inside a group at x=500 at x=8 —
 * outside the group, on top of whatever sat at the frame's left edge.
 */
export function childOrigin(parent: BaseNode): { x: number; y: number } {
  if (
    (parent.type === "GROUP" || parent.type === "BOOLEAN_OPERATION") &&
    "x" in parent
  ) {
    return { x: (parent as GroupNode).x, y: (parent as GroupNode).y };
  }
  return { x: 0, y: 0 };
}

/**
 * resolveGeometry, then shifted into the parent's child coordinates on the
 * axes that inset/align placed. A plain x/y is left raw on purpose: inside a
 * group Figma already reads it in frame coordinates, and every read tool
 * reports it that way, so an agent copying a position back gets it unchanged.
 */
export function resolveInParent(
  req: GeometryRequest,
  parentBox: { w: number; h: number },
  origin: { x: number; y: number },
): Box {
  const box = resolveGeometry(req, parentBox);
  const i = req.inset ?? {};
  const a = req.align;
  if (typeof i.left === "number" || typeof i.right === "number" || a === "center-x" || a === "center") {
    box.x += origin.x;
  }
  if (typeof i.top === "number" || typeof i.bottom === "number" || a === "center-y" || a === "center") {
    box.y += origin.y;
  }
  return box;
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

  // Font size: honor an explicit value; otherwise default to 16 (a real UI body
  // size) instead of Figma's native 12px, which reads as a cramped wireframe.
  // A textStyle, applied after this in create(), still overrides freely.
  const sizeGiven = typeof p.fontSize === "number";
  if (sizeGiven) node.fontSize = p.fontSize as number;
  else if (typeof p.textStyle !== "string") node.fontSize = 16;

  if (typeof p.characters === "string") node.characters = p.characters;
  else if (typeof p.text === "string") node.characters = p.text;

  // Content alignment inside the text box (textAlignHorizontal/Vertical). This
  // is what "center the text" means; `align` positions the whole node instead.
  applyTextAlign(node, p);

  // letterSpacing was previously never read on create — a raw value passed here
  // was silently dropped. Honor it (still overridden by a textStyle applied
  // after this in create()).
  if (p.letterSpacing !== undefined) {
    node.letterSpacing = parseLetterSpacing(p.letterSpacing);
  }

  // Line height: honor an explicit value (previously also dropped on create);
  // otherwise derive it from the size for ALL text, not only wrapped. Skip when
  // a textStyle drives typography.
  if (p.lineHeight !== undefined) {
    node.lineHeight = parseLineHeight(p.lineHeight);
  } else if (typeof p.textStyle !== "string") {
    const size = typeof node.fontSize === "number" ? node.fontSize : 16;
    node.lineHeight = { value: defaultLineHeight(size), unit: "PIXELS" };
  }

  // An explicit textAutoResize from the spec is honoured on its own. It used
  // to be reachable ONLY via wrap:true, so every caller that set it directly
  // (with a width, expecting the text to grow downwards) got a hugging
  // single line that the parent then clipped.
  if (typeof p.textAutoResize === "string") {
    const mode = p.textAutoResize.toUpperCase();
    if (mode === "NONE" || mode === "HEIGHT" || mode === "WIDTH_AND_HEIGHT") {
      node.textAutoResize = mode as "NONE" | "HEIGHT" | "WIDTH_AND_HEIGHT";
    } else {
      ctx.warn(`textAutoResize "${p.textAutoResize}" is not NONE|HEIGHT|WIDTH_AND_HEIGHT; ignored.`);
    }
  }

  if (p.wrap === true) {
    node.textAutoResize = "HEIGHT";
    node.layoutAlign = "STRETCH";
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
  origin: { x: number; y: number },
  parent: BaseNode,
  type: NodeType,
): void {
  if (!("x" in node)) return;
  const layout = node as LayoutMixin;
  const box: Box = parentBox
    ? resolveInParent(geoReq, parentBox, origin)
    : {
        x: geoReq.x ?? 0,
        y: geoReq.y ?? 0,
        w: geoReq.w ?? layout.width,
        h: geoReq.h ?? layout.height,
      };

  const wantW = geoReq.w !== undefined || hasHInset(geoReq.inset);
  const wantH = geoReq.h !== undefined || hasVInset(geoReq.inset);
  // A LINE resizes too — its height must stay 0. Without this branch every
  // created LINE kept Figma's native 100px length and `w` was silently dropped.
  if (type === "LINE" && wantW && "resize" in node) {
    (node as unknown as { resize(w: number, h: number): void }).resize(
      Math.max(0.01, box.w),
      0,
    );
  }
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

/**
 * VECTOR geometry. `points: [[x,y], ...]` is the friendly form — coordinates in
 * PARENT space, exactly like x/y elsewhere — and it is normalized here into a
 * node-local path plus an x/y offset, so callers never juggle two coordinate
 * systems. `closed: true` closes the path (a filled arrow head); otherwise it
 * stays an open polyline for stroking, and `endArrow: true` caps its last
 * point with an arrow head so the head belongs to the line. Raw `vectorPaths`
 * are passed through for curves and anything this shorthand cannot express.
 */
async function applyVectorPath(
  node: SceneNode,
  p: Record<string, unknown>,
  type: NodeType,
  ctx: HandlerContext,
): Promise<void> {
  if (type !== "VECTOR") {
    if (p.points !== undefined) {
      ctx.warn(`points was ignored on a ${type} node — it only applies to type:"VECTOR".`);
    }
    return;
  }
  const vector = node as VectorNode;
  const raw = p.points;
  if (Array.isArray(raw)) {
    const pts = toPoints(raw);
    if (pts.length < 2) {
      ctx.warn("VECTOR points needs at least two [x,y] pairs — nothing was drawn.");
      return;
    }
    // `endArrow` puts the head on the line itself, as a cap on its last
    // vertex, so the arrow is ONE layer that a person can drag by the end.
    // `endArrow: true` is a filled head (a call); "line" is the open one a
    // reply or an async message carries.
    if (p.endArrow === true) await setArrowPolyline(vector, pts);
    else if (p.endArrow === "line") await setArrowPolyline(vector, pts, "ARROW_LINES");
    else setPolyline(vector, pts, p.closed === true);
    return;
  }
  // Several separate strokes in one vector — a crow's foot, a fork mark.
  if (Array.isArray(p.strokeGroup)) {
    const group = p.strokeGroup
      .map((s) => toPoints(s))
      .filter((s) => s.length >= 2);
    if (!group.length) {
      ctx.warn("strokeGroup needs at least one stroke of two [x,y] pairs — nothing was drawn.");
      return;
    }
    await setStrokeGroup(vector, group);
    return;
  }
  if (Array.isArray(p.vectorPaths)) {
    vector.vectorPaths = p.vectorPaths as VectorPaths;
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
  // A `fill` literal beats an EMPTY `fills`: `fills: []` means "no default
  // white", and a colour named next to it is the colour meant. The other order
  // drew the design-system style board with every button, badge and field
  // transparent. A `$token` fill already won this way — it binds after this
  // runs. Hex OR the Figma {r,g,b[,a]} shape both count — the object form used
  // to fall through here and be silently dropped.
  const fillLiteral =
    (typeof p.fill === "string" && isHexColor(p.fill)) || isRgbObject(p.fill);
  const emptyFills = Array.isArray(p.fills) && p.fills.length === 0;
  if (p.fills !== undefined && !(fillLiteral && emptyFills) && "fills" in node) {
    (node as GeometryMixin).fills = toPaints(p.fills);
    warnTokenLiteral(p.fills, ctx);
  } else if (fillLiteral && "fills" in node) {
    (node as GeometryMixin).fills = toPaints(p.fill);
  }
  const strokeLiteral =
    (typeof p.stroke === "string" && isHexColor(p.stroke)) || isRgbObject(p.stroke);
  if (p.strokes !== undefined && "strokes" in node) {
    (node as GeometryMixin).strokes = toPaints(p.strokes);
  } else if (strokeLiteral && "strokes" in node) {
    // `stroke: "$token"` was honoured and `stroke: "#hex"` silently dropped —
    // every outline on the style board went missing.
    (node as GeometryMixin).strokes = toPaints(p.stroke);
  }
  if (typeof p.strokeWeight === "number" && "strokeWeight" in node) {
    (node as MinimalStrokesMixin).strokeWeight = p.strokeWeight;
  }
  // Per-side weights, after strokeWeight (which resets all four). A filled or
  // underlined text field is its bottom edge only, and that edge is how a
  // person finds the field.
  for (const side of ["strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight"] as const) {
    if (typeof p[side] === "number" && side in node) {
      (node as unknown as Record<string, number>)[side] = p[side] as number;
    }
  }
  // Stroke detail: previously dropped on create, so an arrow head or a dashed
  // divider had to be faked with extra nodes. LINE/VECTOR carry strokeCap.
  if (typeof p.strokeAlign === "string" && "strokeAlign" in node) {
    (node as MinimalStrokesMixin).strokeAlign =
      p.strokeAlign as "CENTER" | "INSIDE" | "OUTSIDE";
  }
  if (typeof p.strokeCap === "string" && "strokeCap" in node) {
    (node as unknown as { strokeCap: StrokeCap }).strokeCap = p.strokeCap as StrokeCap;
  }
  if (typeof p.strokeJoin === "string" && "strokeJoin" in node) {
    (node as unknown as { strokeJoin: StrokeJoin }).strokeJoin = p.strokeJoin as StrokeJoin;
  }
  if (Array.isArray(p.dashPattern) && "dashPattern" in node) {
    (node as unknown as { dashPattern: readonly number[] }).dashPattern =
      p.dashPattern.filter((v): v is number => typeof v === "number");
  }
  if (p.effects !== undefined && "effects" in node) {
    (node as BlendMixin).effects = toEffects(p.effects);
  }
  applyCornerRadii(node, p);
  // clipsContent was read nowhere, so `create({ clipsContent: false })` was a
  // silent no-op and every frame kept Figma's clipping default — content that
  // deliberately overhangs (badges, shadows, a diagram's arrows) got cut off.
  if (typeof p.clipsContent === "boolean" && "clipsContent" in node) {
    (node as FrameNode).clipsContent = p.clipsContent;
  }
  if (typeof p.opacity === "number" && "opacity" in node) {
    (node as BlendMixin).opacity = p.opacity;
    if (type === "FRAME" && p.opacity < 1) {
      ctx.warn(
        "opacity < 1 on a FRAME dims its entire subtree; use figma.overlay({ color, opacity, parentId }) for a scrim rectangle.",
      );
    }
  }
}

interface TokenBinding {
  field: string;
  tokenName: string;
  variable: Variable;
}

/**
 * Collect design-token bindings from the create spec: `fill`/`stroke` values
 * written as "$token/name", plus an explicit `tokens: {field: tokenName}` map
 * (friendly fields like cornerRadius/padding expand to their bindable parts).
 * Every token must resolve to an existing variable — a miss throws
 * INVALID_PARAMS before any node is created.
 */
/**
 * Lucide icons paint on descendant vectors, not the wrapper FRAME. Binding
 * `stroke` on the wrapper would draw a box around the glyph. `ink` is the
 * token that recolors every existing solid fill/stroke inside the artwork.
 */
async function bindArtworkInk(node: SceneNode, p: Record<string, unknown>): Promise<void> {
  if (typeof p.ink !== "string" || !p.ink.startsWith("$")) return;
  const variable = await findVariableByName(p.ink.slice(1));
  if (!variable) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      `No variable named "${p.ink.slice(1)}" (for icon ink). Nothing was created.`,
      "Run setup_tokens first, or check the token name via figma_read get_variables.",
    );
  }
  const stack: SceneNode[] = [node];
  while (stack.length) {
    const n = stack.pop()!;
    if ("strokes" in n) {
      const strokes = (n as GeometryMixin).strokes;
      if (Array.isArray(strokes) && strokes.some((s) => s.type === "SOLID" && s.visible !== false)) {
        bindVariableToField(n, "strokes", variable);
      }
    }
    if ("fills" in n && n !== node) {
      const fills = (n as GeometryMixin).fills;
      if (Array.isArray(fills) && fills.some((f) => f.type === "SOLID" && f.visible !== false)) {
        bindVariableToField(n, "fills", variable);
      }
    }
    if ("children" in n) stack.push(...(n as ChildrenMixin).children);
  }
}

async function resolveTokenBindings(
  p: Record<string, unknown>,
): Promise<TokenBinding[]> {
  const wanted: Array<{ field: string; tokenName: string }> = [];
  if (typeof p.fill === "string" && p.fill.startsWith("$")) {
    wanted.push({ field: "fills", tokenName: p.fill.slice(1) });
  }
  if (typeof p.stroke === "string" && p.stroke.startsWith("$")) {
    wanted.push({ field: "strokes", tokenName: p.stroke.slice(1) });
  }
  if (typeof p.tokens === "object" && p.tokens !== null) {
    for (const [field, raw] of Object.entries(
      p.tokens as Record<string, unknown>,
    )) {
      const tokenName = String(raw).replace(/^\$/, "");
      for (const f of expandBindableField(field)) {
        wanted.push({ field: f, tokenName });
      }
    }
  }

  const out: TokenBinding[] = [];
  for (const w of wanted) {
    const variable = await findVariableByName(w.tokenName);
    if (!variable) {
      throw err(
        ErrorCode.INVALID_PARAMS,
        `No variable named "${w.tokenName}" (for field "${w.field}"). Nothing was created.`,
        "Run setup_tokens / create_variable first, or check the token name via figma_read get_variables.",
      );
    }
    out.push({ ...w, variable });
  }
  return out;
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
  // itemSpacing: honor an explicit value (0 included, e.g. seamless lists);
  // otherwise default to 8 rather than Figma's native 0, which glues children
  // edge-to-edge. Warn so the caller can pick a scale value (8/12/16/24…) or 0.
  if (typeof p.itemSpacing === "number") {
    node.itemSpacing = p.itemSpacing;
  } else {
    node.itemSpacing = 8;
    ctx.warn(
      "Auto-layout created without itemSpacing — defaulted the gap to 8px so children aren't glued together. Set itemSpacing on the 4px scale (8/12/16/24…), or 0 for a seamless list.",
    );
  }
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
  // Wrapping. A spec that says layoutWrap and gets ignored produces a single
  // row that runs straight out of its frame and is clipped — which is what a
  // 36-swatch colour specimen did, showing about a third of the palette.
  if (typeof p.layoutWrap === "string") {
    const wrap = p.layoutWrap.toUpperCase();
    if (wrap === "WRAP" || wrap === "NO_WRAP") {
      if (node.layoutMode === "HORIZONTAL") {
        node.layoutWrap = wrap as "WRAP" | "NO_WRAP";
      } else {
        ctx.warn(
          `layoutWrap is only valid on a HORIZONTAL auto-layout; ignored on this ${node.layoutMode} frame.`,
        );
      }
    }
  }
  // Only meaningful once the frame actually wraps: the gap BETWEEN rows.
  if (typeof p.counterAxisSpacing === "number") {
    if (node.layoutWrap === "WRAP") node.counterAxisSpacing = p.counterAxisSpacing;
    else ctx.warn("counterAxisSpacing needs layoutWrap:\"WRAP\"; ignored.");
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
 * decide how a node stretches/grows inside an auto-layout parent. modify has
 * the same handling for non-frame nodes; keep the two in sync.
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
  // Under auto-layout the parent decides where its children go, and it does it
  // AFTER this call — a child measured here is still at its creation position,
  // so every row of a table looked like it was about to be clipped.
  if ("layoutMode" in parent && (parent as FrameNode).layoutMode !== "NONE") return;
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

/**
 * A screen is about to be drawn. Two questions belong to the USER, not to us,
 * and both are cheap to ask now and expensive to answer later:
 *
 *  - no userflow on the page yet → should the flow be mapped FIRST? Screens
 *    drawn before anyone agreed on the flow are the ones that get redrawn.
 *  - a userflow exists but does not contain this screen → should it be
 *    updated in the same pass, so flow and design stop drifting apart?
 *
 * We only surface the question. The tool never draws or edits a flow on its
 * own initiative, and never blocks the screen being drawn now.
 */
function warnAboutUserflow(node: SceneNode, parent: BaseNode, ctx: HandlerContext): void {
  if (parent.type !== "PAGE") return;
  if (node.type !== "FRAME" && node.type !== "COMPONENT") return;
  if (!("width" in node) || node.width < 320 || node.height < 320) return;
  // Our own diagram frames and their layers are not screens.
  if (isDiagramLayerName(node.name) || isDiagramFrameName(node.name)) return;

  const marks = readFlowMarks(parent as PageNode);
  if (!marks.length) {
    ctx.warn(
      'No userflow on this page. ASK THE USER before drawing more screens: "map the userflow first, then draw the UI?" — figma_diagram type:"userflow" takes the screens/decisions/error cases from your own reading of the spec. Drawing screens first is how the flow ends up contradicting them.',
    );
    return;
  }
  if (flowCoversScreen(marks, node.name)) return;
  const titles = marks.map((m) => `"${m.title}"`).join(", ");
  ctx.warn(
    `This page already has a userflow (${titles}) and the screen just drawn is not in it. ASK THE USER whether to add the new screen(s) to the flow in the same pass — figma_diagram with update: the flow's frameId plus a patch that adds the node and its edges, which redraws it in place and leaves nothing to delete.`,
  );
}

/**
 * Warn when a node's solid fill exactly matches its container parent's solid
 * fill — a white-on-white (or bg-on-bg) wrapper that reads as a floating slab
 * instead of sitting on the surface. Structural wrappers should stay
 * transparent; only distinct surfaces (cards, inputs) need their own fill.
 */
function warnIfWrapperFillMatchesParent(
  node: SceneNode,
  parent: BaseNode,
  ctx: HandlerContext,
): void {
  if (node.type !== "FRAME" && node.type !== "COMPONENT") return;
  // A notation label knocks out the line it sits on: the matching fill IS the
  // point of it, so the hint is a false positive on our own diagrams.
  if (isDiagramLayerName(node.name)) return;
  // A stroked card on the same background is a deliberate, readable surface —
  // the "slab" problem is a fill with no edge, not an outlined one.
  if ("strokes" in node && (node as GeometryMixin).strokes.length > 0) return;
  const nodeHex = firstSolidHex(node);
  const parentHex = firstSolidHex(parent);
  if (!nodeHex || !parentHex) return;
  if (nodeHex.toLowerCase() === parentHex.toLowerCase()) {
    ctx.warn(
      `"${node.name}" has the same fill (${nodeHex}) as its container — a same-colour wrapper reads as a slab. Leave structural wrappers transparent (fills:[]); give only distinct surfaces their own fill.`,
    );
  }
}

/** The hex of a node's first fully-opaque SOLID fill, or null. */
function firstSolidHex(node: BaseNode): string | null {
  if (!("fills" in node)) return null;
  const fills = (node as GeometryMixin).fills;
  if (fills === figma.mixed || !Array.isArray(fills)) return null;
  for (const f of fills) {
    if (f.type === "SOLID" && f.visible !== false && (f.opacity ?? 1) >= 0.999) {
      const { r, g, b } = f.color;
      const to = (c: number) =>
        Math.round(c * 255)
          .toString(16)
          .padStart(2, "0");
      return `#${to(r)}${to(g)}${to(b)}`;
    }
  }
  return null;
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
