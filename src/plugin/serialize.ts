/// <reference types="@figma/plugin-typings" />
import { r2 } from "./num.js";
import { rgbToHex, rgbaToHex } from "./color-util.js";

export type Detail = "sparse" | "compact" | "full" | "design";

export interface SerializedNode {
  id: string;
  name: string;
  type: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  [k: string]: unknown;
}

/** Rounded {x,y,w,h} from a node, when it has geometry. */
function geom(node: BaseNode): Partial<SerializedNode> {
  const out: Partial<SerializedNode> = {};
  if ("x" in node) out.x = r2((node as LayoutMixin).x);
  if ("y" in node) out.y = r2((node as LayoutMixin).y);
  if ("width" in node) out.w = r2((node as LayoutMixin).width);
  if ("height" in node) out.h = r2((node as LayoutMixin).height);
  return out;
}

/** First solid fill as hex, if any. */
function primaryFillHex(node: BaseNode): string | undefined {
  if (!("fills" in node)) return undefined;
  const fills = (node as GeometryMixin).fills;
  if (fills === figma.mixed || !Array.isArray(fills)) return undefined;
  for (const f of fills) {
    if (f.type === "SOLID" && f.visible !== false) {
      return rgbToHex(f.color);
    }
  }
  return undefined;
}

/**
 * Serialize a single node at the requested detail level. Sparse keeps only
 * id/name/type/x/y/w/h; compact adds a few meaningful fields; full adds fills,
 * layout, text props. `design` is the rich mode used for design.md/component
 * intelligence: styles, variables, component props, constraints and effects.
 */
export function serializeNode(
  node: BaseNode,
  detail: Detail = "compact",
): SerializedNode {
  const base: SerializedNode = {
    id: node.id,
    name: node.name,
    type: node.type,
    ...geom(node),
  };
  if (detail === "sparse") return base;

  if ("visible" in node && !(node as SceneNode).visible) base.visible = false;
  if ("opacity" in node) {
    const o = (node as BlendMixin).opacity;
    if (o !== 1) base.opacity = r2(o);
  }
  if ("layoutMode" in node) {
    const f = node as FrameNode;
    if (f.layoutMode !== "NONE") {
      base.layoutMode = f.layoutMode;
      base.itemSpacing = f.itemSpacing;
      base.padding = {
        l: f.paddingLeft,
        r: f.paddingRight,
        t: f.paddingTop,
        b: f.paddingBottom,
      };
      base.primaryAxisSizingMode = f.primaryAxisSizingMode;
      base.counterAxisSizingMode = f.counterAxisSizingMode;
    }
    if (f.clipsContent) base.clipsContent = true;
  }
  if (node.type === "TEXT") {
    const t = node as TextNode;
    base.characters =
      t.characters.length > 120
        ? t.characters.slice(0, 120) + "…"
        : t.characters;
    base.textAutoResize = t.textAutoResize;
    const fs = t.fontSize;
    if (fs !== figma.mixed) base.fontSize = fs;
  }

  if (detail === "compact") {
    const hex = primaryFillHex(node);
    if (hex) base.fill = hex;
    if ("children" in node) {
      base.childCount = (node as ChildrenMixin).children.length;
    }
    return base;
  }

  // full / design
  const hex = primaryFillHex(node);
  if (hex) base.fill = hex;
  if ("strokes" in node && Array.isArray((node as GeometryMixin).strokes)) {
    const strokes = (node as GeometryMixin).strokes;
    if (strokes.length > 0) base.strokeCount = strokes.length;
  }
  if ("cornerRadius" in node) {
    const cr = (node as RectangleNode).cornerRadius;
    if (cr !== figma.mixed && cr !== 0) base.cornerRadius = cr;
  }
  if ("children" in node) {
    base.childCount = (node as ChildrenMixin).children.length;
  }
  if (detail !== "design") {
    return base;
  }

  addDesignFields(base, node);
  return base;
}

/**
 * Iterative (NOT recursive) depth-limited subtree serialization. Returns a
 * tree of nodes each with a `children` array up to `maxDepth`.
 */
export function serializeTree(
  root: BaseNode,
  detail: Detail,
  maxDepth: number,
): SerializedNode {
  interface Frame {
    node: BaseNode;
    depth: number;
    out: SerializedNode;
  }
  const rootOut = serializeNode(root, detail);
  const stack: Frame[] = [{ node: root, depth: 0, out: rootOut }];
  while (stack.length > 0) {
    const frame = stack.pop() as Frame;
    if (frame.depth >= maxDepth) continue;
    if (!("children" in frame.node)) continue;
    const kids = (frame.node as ChildrenMixin).children;
    const childOut: SerializedNode[] = [];
    for (const kid of kids) {
      const so = serializeNode(kid, detail);
      childOut.push(so);
      stack.push({ node: kid, depth: frame.depth + 1, out: so });
    }
    if (childOut.length > 0) frame.out.children = childOut;
  }
  return rootOut;
}

export function normalizeDetail(v: unknown): Detail {
  return v === "sparse" || v === "full" || v === "design" ? v : "compact";
}

/**
 * Read `componentPropertyDefinitions` without throwing.
 *
 * The Figma getter is only valid on a COMPONENT_SET or a *non-variant*
 * COMPONENT. On a variant COMPONENT (one whose parent is a COMPONENT_SET) the
 * getter throws — a variant has no definitions of its own; they live on the
 * parent set. So for a variant we read the field off the parent SET instead of
 * returning nothing, so callers still surface the component's real property
 * keys. Returns `null` only for non-component nodes. The property-key `in`
 * check is not enough on its own: the key exists on every COMPONENT, but
 * *reading* it throws for variants.
 */
export function readComponentPropertyDefinitions(node: BaseNode): Record<string, unknown> | null {
  const type = (node as { type?: string }).type;
  if (type !== "COMPONENT" && type !== "COMPONENT_SET") return null;
  let source: BaseNode = node;
  if (type === "COMPONENT") {
    const parent = (node as { parent?: BaseNode | null }).parent;
    if (parent?.type === "COMPONENT_SET") source = parent;
  }
  return plainValue(
    (source as { componentPropertyDefinitions?: unknown }).componentPropertyDefinitions,
  ) as Record<string, unknown>;
}

function addDesignFields(base: SerializedNode, node: BaseNode): void {
  const styleRefs = styleReferences(node);
  if (Object.keys(styleRefs).length > 0) base.styleRefs = styleRefs;

  const bound = plainBoundVariables((node as { boundVariables?: unknown }).boundVariables);
  if (bound && Object.keys(bound).length > 0) base.boundVariables = bound;

  if ("fills" in node) {
    const fills = compactPaints((node as GeometryMixin).fills);
    if (!Array.isArray(fills) || fills.length > 0) base.fills = fills;
  }
  if ("strokes" in node) {
    const strokes = compactPaints((node as GeometryMixin).strokes);
    if (!Array.isArray(strokes) || strokes.length > 0) base.strokes = strokes;
  }
  if ("effects" in node) {
    const effects = compactEffects((node as BlendMixin).effects);
    if (!Array.isArray(effects) || effects.length > 0) base.effects = effects;
  }
  if ("constraints" in node) base.constraints = plainValue((node as ConstraintMixin).constraints);

  if ("layoutAlign" in node) base.layoutAlign = (node as LayoutMixin).layoutAlign;
  if ("layoutGrow" in node) base.layoutGrow = (node as LayoutMixin).layoutGrow;
  if ("layoutPositioning" in node) base.layoutPositioning = (node as LayoutMixin).layoutPositioning;
  if ("componentPropertyReferences" in node) {
    const refs = (node as { componentPropertyReferences?: unknown }).componentPropertyReferences;
    if (refs) base.componentPropertyReferences = plainValue(refs);
  }

  const propDefs = readComponentPropertyDefinitions(node);
  if (propDefs) {
    base.componentPropertyDefinitions = propDefs;
  }
  if ("variantProperties" in node) {
    const variantProperties = (node as { variantProperties?: unknown }).variantProperties;
    if (variantProperties) base.variantProperties = plainValue(variantProperties);
  }
  if ("variantGroupProperties" in node) {
    base.variantGroupProperties = plainValue(
      (node as { variantGroupProperties?: unknown }).variantGroupProperties,
    );
  }
  if (node.type === "INSTANCE") {
    const inst = node as InstanceNode;
    base.componentProperties = plainValue(inst.componentProperties);
    base.exposedInstances = inst.exposedInstances?.map((n) => ({ id: n.id, name: n.name }));
  }

  if (node.type === "TEXT") {
    base.typography = compactTypography(node as TextNode);
  }
}

/**
 * Typography with Figma's defaults omitted: AUTO line-height, zero letter-
 * spacing, ORIGINAL case, NONE decoration, LEFT/TOP alignment. `mixed`
 * values survive as "mixed" (never equal to a default).
 */
function compactTypography(t: TextNode): Record<string, unknown> {
  const out: Record<string, unknown> = {
    fontName: plainValue(t.fontName),
    fontSize: plainValue(t.fontSize),
  };
  const lh = plainValue(t.lineHeight) as { unit?: string } | string;
  if (typeof lh === "string" || lh?.unit !== "AUTO") out.lineHeight = lh;
  const ls = plainValue(t.letterSpacing) as { value?: number } | string;
  if (typeof ls === "string" || ls?.value !== 0) out.letterSpacing = ls;
  if (t.textCase !== "ORIGINAL") out.textCase = plainValue(t.textCase);
  if (t.textDecoration !== "NONE") out.textDecoration = plainValue(t.textDecoration);
  if (t.textAlignHorizontal !== "LEFT") out.textAlignHorizontal = t.textAlignHorizontal;
  if (t.textAlignVertical !== "TOP") out.textAlignVertical = t.textAlignVertical;
  return out;
}

/**
 * Compact one Paint for serialization: colors as hex, defaults omitted
 * (visible:true, opacity:1, blendMode NORMAL). Raw Paint objects carry
 * full-precision floats per channel (~10x the tokens of a hex string).
 * Unknown paint types fall back to plainValue so nothing is silently lost.
 */
function compactPaint(p: Paint): Record<string, unknown> {
  const out: Record<string, unknown> = { type: p.type };
  if (p.visible === false) out.visible = false;
  if (p.opacity !== undefined && p.opacity !== 1) out.opacity = r2(p.opacity);
  if (p.blendMode && p.blendMode !== "NORMAL") out.blendMode = p.blendMode;
  const bound = plainBoundVariables((p as { boundVariables?: unknown }).boundVariables);
  if (bound && Object.keys(bound).length > 0) out.boundVariables = bound;
  if (p.type === "SOLID") {
    out.hex = rgbToHex(p.color);
    return out;
  }
  if (
    p.type === "GRADIENT_LINEAR" ||
    p.type === "GRADIENT_RADIAL" ||
    p.type === "GRADIENT_ANGULAR" ||
    p.type === "GRADIENT_DIAMOND"
  ) {
    out.stops = p.gradientStops.map((s) => ({ hex: rgbaToHex(s.color), pos: r2(s.position) }));
    out.gradientTransform = p.gradientTransform.map((row) => row.map(r2));
    return out;
  }
  if (p.type === "IMAGE") {
    out.scaleMode = p.scaleMode;
    if (p.imageHash) out.imageHash = p.imageHash;
    return out;
  }
  return { ...(plainValue(p) as Record<string, unknown>), ...out };
}

function compactPaints(value: unknown): unknown {
  if (!Array.isArray(value)) return plainValue(value);
  return value.map((p) => compactPaint(p as Paint));
}

function compactEffects(value: unknown): unknown {
  if (!Array.isArray(value)) return plainValue(value);
  return (value as Effect[]).map((e) => {
    const out: Record<string, unknown> = { type: e.type };
    if (e.visible === false) out.visible = false;
    if ("radius" in e && e.radius !== undefined) out.radius = r2(e.radius);
    if ("color" in e && e.color) out.hex = rgbaToHex(e.color);
    if ("offset" in e && e.offset) out.offset = { x: r2(e.offset.x), y: r2(e.offset.y) };
    if ("spread" in e && e.spread) out.spread = r2(e.spread);
    if ("blendMode" in e && e.blendMode !== "NORMAL") out.blendMode = e.blendMode;
    const bound = plainBoundVariables((e as { boundVariables?: unknown }).boundVariables);
    if (bound && Object.keys(bound).length > 0) out.boundVariables = bound;
    return out;
  });
}

function styleReferences(node: BaseNode): Record<string, unknown> {
  const refs: Record<string, unknown> = {};
  const o = node as {
    fillStyleId?: unknown;
    strokeStyleId?: unknown;
    textStyleId?: unknown;
    effectStyleId?: unknown;
    gridStyleId?: unknown;
  };
  for (const key of ["fillStyleId", "strokeStyleId", "textStyleId", "effectStyleId", "gridStyleId"] as const) {
    const value = plainValue(o[key]);
    if (value !== undefined && value !== "" && value !== "mixed") refs[key] = value;
  }
  return refs;
}

function plainBoundVariables(value: unknown): Record<string, unknown> | undefined {
  const out = plainValue(value);
  return out && typeof out === "object" && !Array.isArray(out) ? (out as Record<string, unknown>) : undefined;
}

export function plainValue(value: unknown, depth = 0): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (value === figma.mixed) return "mixed";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (depth > 5) return "[Object]";
  if (Array.isArray(value)) return value.map((v) => plainValue(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "function") continue;
      const pv = plainValue(v, depth + 1);
      if (pv !== undefined) out[k] = pv;
    }
    return out;
  }
  return String(value);
}
