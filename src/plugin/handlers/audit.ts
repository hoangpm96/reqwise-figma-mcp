/// <reference types="@figma/plugin-typings" />
import { HandlerContext, requireNode } from "../context.js";
import { r2 } from "../num.js";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface AuditRecord {
  id: string;
  name: string;
  type: string;
  declared: { x: number; y: number; w: number; h: number };
  rendered: { x: number; y: number; w: number; h: number } | null;
  overflowsParent: boolean;
  clippedBy: string | null;
  textTruncated: boolean;
  zIndexWarnings: string[];
  /** Non-blocking design/aesthetic hints (not correctness bugs). */
  styleWarnings: string[];
}

/** A record has something worth reporting (structural issue or style hint). */
function recordHasFinding(rec: AuditRecord): boolean {
  return (
    rec.overflowsParent ||
    rec.clippedBy !== null ||
    rec.textTruncated ||
    rec.zIndexWarnings.length > 0 ||
    rec.styleWarnings.length > 0
  );
}

function firstSolidFill(node: SceneNode): RGB | null {
  const fills = (node as GeometryMixin).fills;
  if (!Array.isArray(fills)) return null;
  for (const f of fills) {
    if (f && f.type === "SOLID" && f.visible !== false) return f.color;
  }
  return null;
}

/** Rough perceptual distance between two RGB (0..1 channels), 0 = identical. */
function colorDistance(a: RGB, b: RGB): number {
  return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
}

/** Nearest ancestor SOLID fill — the effective background behind a node. */
function ancestorFill(node: SceneNode): RGB | null {
  let cur: BaseNode | null = node.parent;
  while (cur) {
    if ("fills" in cur) {
      const c = firstSolidFill(cur as SceneNode);
      if (c) return c;
    }
    cur = cur.parent;
  }
  return null;
}

/**
 * Aesthetic heuristics — deliberately conservative to avoid false positives.
 * These are HINTS (styleWarnings), never counted as correctness issues.
 */
export function styleWarningsFor(
  node: SceneNode,
  siblings: readonly SceneNode[],
): string[] {
  const out: string[] = [];

  const container = node.type === "FRAME" || node.type === "COMPONENT";
  const surface = container && hasVisibleSurface(node);

  // 1. Visible UI controls/surfaces should declare a radius. Do not impose a
  //    radius on screens, backgrounds or structural transparent wrappers.
  const radius = numericCornerRadius(node);
  if (
    surface &&
    radius === 0 &&
    node.width >= 64 &&
    node.height >= 24 &&
    semanticRoundedSurface(node.name)
  ) {
    out.push(
      "Visible card/control has cornerRadius 0 — apply the design-system radius token (or set cornerRadius explicitly).",
    );
  }

  // 2. Similar sibling surfaces are almost always repeated controls/cards.
  //    Compare only near-identical dimensions so pills are not compared with
  //    their containing rows. A 3px+ deviation is visually noticeable.
  if (surface && radius !== null && node.width >= 64 && node.height >= 24) {
    const peerRadii = siblings
      .filter((s) => s.id !== node.id && hasVisibleSurface(s) && similarSize(node, s))
      .map(numericCornerRadius)
      .filter((r): r is number => r !== null);
    if (peerRadii.length >= 2) {
      const reference = median(peerRadii);
      if (Math.abs(radius - reference) >= 3) {
        out.push(
          `cornerRadius ${radius}px differs from similar siblings (typically ${reference}px) — bind the same radius token across the set.`,
        );
      }
    }
  }

  // 3. Visible content containers need breathing room. Auto-layout frames are
  //    checked from their declared padding; absolute-layout frames are checked
  //    from direct child insets. Buttons/inputs/pills intentionally center in
  //    a fixed height and are excluded from the all-sides rule.
  if (
    surface &&
    node.width >= 120 &&
    node.height >= 72 &&
    !isCompactControl(node.name) &&
    !isCanvasRoot(node)
  ) {
    const minPadding = declaredOrMeasuredMinPadding(node);
    if (minPadding !== null && minPadding < 12) {
      out.push(
        `Content is only ${r2(minPadding)}px from the container edge — use at least 12px padding (16–24px for cards/sections).`,
      );
    }
  }

  // 4. A child much narrower than stretched siblings in a vertical auto-layout
  //    usually means a forgotten layoutAlign:"STRETCH" (the hug-width button bug).
  const parent = node.parent;
  if (
    (node.type === "FRAME" ||
      node.type === "COMPONENT" ||
      node.type === "INSTANCE") &&
    !/(badge|icon|avatar|logo|mark|eyebrow|link|label|caption)/i.test(node.name) &&
    parent &&
    "layoutMode" in parent &&
    (parent as FrameNode).layoutMode === "VERTICAL" &&
    siblings.length >= 2 &&
    "layoutAlign" in node
  ) {
    const stretched = siblings.filter(
      (s) => "layoutAlign" in s && (s as LayoutMixin).layoutAlign === "STRETCH",
    ).length;
    const isStretched = (node as LayoutMixin).layoutAlign === "STRETCH";
    const maxSibW = Math.max(...siblings.map((s) => s.width));
    if (
      !isStretched &&
      stretched >= 1 &&
      maxSibW > 0 &&
      node.width < maxSibW * 0.6
    ) {
      out.push(
        "Much narrower than stretched siblings — likely missing layoutAlign:\"STRETCH\" (add it for full-width).",
      );
    }
  }

  // 5. Text whose color is nearly the same as its background is unreadable.
  if (node.type === "TEXT") {
    const fg = firstSolidFill(node);
    const bg = ancestorFill(node);
    if (fg && bg && colorDistance(fg, bg) < 0.12) {
      out.push(
        "Text color is nearly identical to its background — very low contrast, likely unreadable.",
      );
    }
  }

  return out;
}

function hasVisibleSurface(node: SceneNode): boolean {
  if (!("fills" in node)) return false;
  const fills = (node as GeometryMixin).fills;
  const hasFill = Array.isArray(fills) && fills.some((f) => f.visible !== false);
  const strokes = (node as GeometryMixin).strokes;
  const hasStroke = Array.isArray(strokes) && strokes.some((s) => s.visible !== false);
  return hasFill || hasStroke;
}

function numericCornerRadius(node: SceneNode): number | null {
  if (!("cornerRadius" in node)) return null;
  const radius = (node as RectangleNode).cornerRadius;
  return typeof radius === "number" ? radius : null;
}

function semanticRoundedSurface(name: string): boolean {
  return /(^|[\s/_-])(card|input|field|button|modal|dialog|sheet|preview|pill|badge|chip|toast)([\s/_-]|$)/i.test(
    name,
  );
}

function isCompactControl(name: string): boolean {
  return /(^|[\s/_-])(button|input|field|pill|badge|chip|tag|toggle|checkbox|radio|row|item)([\s/_-]|$)/i.test(
    name,
  );
}

function isCanvasRoot(node: SceneNode): boolean {
  return node.parent?.type === "PAGE";
}

function similarSize(a: SceneNode, b: SceneNode): boolean {
  const widthRatio = Math.max(a.width, b.width) / Math.max(1, Math.min(a.width, b.width));
  const heightRatio = Math.max(a.height, b.height) / Math.max(1, Math.min(a.height, b.height));
  return widthRatio <= 1.35 && heightRatio <= 1.35;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function declaredOrMeasuredMinPadding(node: SceneNode): number | null {
  if (!("children" in node)) return null;
  const frame = node as FrameNode;
  const children = (node as ChildrenMixin).children.filter(
    (c) =>
      c.visible !== false &&
      !/(background|decoration|overlay|scrim|backdrop|cover|hero image)/i.test(c.name),
  );
  if (children.length === 0) return null;

  if ("layoutMode" in node && frame.layoutMode !== "NONE") {
    return Math.min(
      frame.paddingLeft,
      frame.paddingRight,
      frame.paddingTop,
      frame.paddingBottom,
    );
  }

  const insets: number[] = [];
  for (const child of children) {
    // Ignore deliberately full-bleed/overflowing decoration-like children.
    if (child.x < 0 || child.y < 0) continue;
    const right = node.width - (child.x + child.width);
    const bottom = node.height - (child.y + child.height);
    if (right < 0 || bottom < 0) continue;
    insets.push(child.x, child.y, right, bottom);
  }
  return insets.length > 0 ? Math.min(...insets) : null;
}

function abox(node: SceneNode): Rect | null {
  const b = (node as SceneNode & { absoluteBoundingBox: Rect | null })
    .absoluteBoundingBox;
  return b ?? null;
}

function rectContains(outer: Rect, inner: Rect, eps = 0.5): boolean {
  return (
    inner.x >= outer.x - eps &&
    inner.y >= outer.y - eps &&
    inner.x + inner.width <= outer.x + outer.width + eps &&
    inner.y + inner.height <= outer.y + outer.height + eps
  );
}

/**
 * Detect a fixed-size (textAutoResize "NONE") or "TRUNCATE" text node whose
 * content does not fit its box — horizontally OR vertically. The old check only
 * compared rendered vs declared height, which is always equal for a fixed box,
 * so single-line horizontal overflow and clipped multi-line text slipped
 * through. We instead compare the box against the text's intrinsic size, which
 * Figma exposes without mutating the node.
 */
function isTextTruncated(
  t: TextNode,
  rendered: { width: number; height: number } | null,
): boolean {
  if (t.textAutoResize === "TRUNCATE") return true;
  if (t.textAutoResize !== "NONE") return false;

  const boxW = rendered?.width ?? t.width;
  const boxH = rendered?.height ?? t.height;

  // Intrinsic size the text WANTS if it could grow. Figma computes this from
  // the glyph layout; a mixed/unloaded font can throw, so guard defensively.
  try {
    const size = figma.getNodeById(t.id) as TextNode | null;
    if (size && typeof size.width === "number") {
      // WIDTH-auto height: measure the natural single-line/paragraph width.
      // If the fixed box is narrower/shorter than the text's own bounds by more
      // than a rounding epsilon, content is being clipped.
      const intrinsicH = size.height;
      if (intrinsicH > boxH + 0.5) return true;
    }
  } catch {
    /* fall through to the heuristic below */
  }

  // Heuristic fallback (no reliable intrinsic read): a long string crammed into
  // a short, single-line box is almost certainly clipped. ~0.5×fontSize per
  // character is a conservative lower bound on advance width. Mixed-size text
  // uses a typical body size for the estimate.
  const fontSize = typeof t.fontSize === "number" ? t.fontSize : 14;
  const approxTextW = t.characters.length * fontSize * 0.5;
  const oneLine = boxH < fontSize * 1.6;
  return oneLine && approxTextW > boxW + fontSize;
}

function isOverlayLike(node: SceneNode): boolean {
  if (node.type !== "RECTANGLE") return false;
  const name = node.name.toLowerCase();
  if (name.includes("overlay") || name.includes("scrim") || name.includes("backdrop")) {
    return true;
  }
  // Large semi-transparent dark rect also reads as an overlay.
  const op = (node as BlendMixin).opacity;
  return op < 1 && node.width > 100 && node.height > 100;
}

/**
 * layout_audit: walk the subtree (iterative) and compute per-node overflow /
 * clip / text-truncation / z-index issues. Returns records + a summary issues
 * list — the structured verify step.
 */
export async function layoutAudit(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const root = typeof p.nodeId === "string"
    ? await requireNode(p.nodeId)
    : (figma.currentPage.selection[0] ?? figma.currentPage);

  const verbose = p.verbose === true;
  const records: AuditRecord[] = [];
  const issues: string[] = [];
  const styleHints: string[] = [];

  interface Frame {
    node: SceneNode;
    clipAncestor: SceneNode | null;
    siblings: readonly SceneNode[];
    index: number;
  }
  const stack: Frame[] = [];
  if ("children" in root) {
    const kids = (root as ChildrenMixin).children;
    const clip = "clipsContent" in root && (root as FrameNode).clipsContent
      ? (root as SceneNode)
      : null;
    kids.forEach((k, i) =>
      stack.push({ node: k, clipAncestor: clip, siblings: kids, index: i }),
    );
  } else {
    stack.push({
      node: root as SceneNode,
      clipAncestor: null,
      siblings: [],
      index: 0,
    });
  }

  let processed = 0;
  while (stack.length > 0) {
    const frame = stack.pop()!;
    const node = frame.node;
    const parent = node.parent;
    const rendered = abox(node);

    // overflow vs parent
    let overflows = false;
    if (parent && "absoluteBoundingBox" in parent) {
      const pbox = abox(parent as SceneNode);
      if (pbox && rendered) overflows = !rectContains(pbox, rendered);
    }

    // clipped by nearest clipping ancestor
    let clippedBy: string | null = null;
    if (frame.clipAncestor && rendered) {
      const cbox = abox(frame.clipAncestor);
      if (cbox && !rectContains(cbox, rendered)) {
        clippedBy = frame.clipAncestor.id;
      }
    }

    // text truncation
    let textTruncated = false;
    if (node.type === "TEXT") {
      textTruncated = isTextTruncated(node as TextNode, rendered);
    }

    // z-index: overlay-like not topmost among siblings
    const zWarnings: string[] = [];
    if (isOverlayLike(node) && frame.siblings.length > 0) {
      const isTop = frame.index === frame.siblings.length - 1;
      if (!isTop) {
        zWarnings.push(
          `Overlay-like node is at z-index ${frame.index}/${frame.siblings.length - 1}; content above it will not be dimmed. Move to top.`,
        );
      }
    }

    const rec: AuditRecord = {
      id: node.id,
      name: node.name,
      type: node.type,
      declared: {
        x: r2(node.x),
        y: r2(node.y),
        w: r2(node.width),
        h: r2(node.height),
      },
      rendered: rendered
        ? {
            x: r2(rendered.x),
            y: r2(rendered.y),
            w: r2(rendered.width),
            h: r2(rendered.height),
          }
        : null,
      overflowsParent: overflows,
      clippedBy,
      textTruncated,
      zIndexWarnings: zWarnings,
      styleWarnings: styleWarningsFor(node, frame.siblings),
    };
    records.push(rec);

    if (overflows)
      issues.push(`${node.name} (${node.id}) overflows its parent bounds.`);
    if (clippedBy)
      issues.push(`${node.name} (${node.id}) is clipped by ${clippedBy}.`);
    if (textTruncated)
      issues.push(`Text "${node.name}" (${node.id}) is truncated/clipped.`);
    for (const z of zWarnings) issues.push(`${node.name}: ${z}`);
    for (const s of rec.styleWarnings)
      styleHints.push(`${node.name} (${node.id}): ${s}`);

    // descend
    if ("children" in node) {
      const kids = (node as ChildrenMixin).children;
      const nextClip =
        "clipsContent" in node && (node as FrameNode).clipsContent
          ? node
          : frame.clipAncestor;
      kids.forEach((k, i) =>
        stack.push({ node: k, clipAncestor: nextClip, siblings: kids, index: i }),
      );
    }

    processed++;
    if (processed % 50 === 0) ctx.progress(processed, processed, "auditing");
  }

  // Token-frugal by default: only return records that carry a finding, since
  // a clean subtree's full per-node dump is pure overhead (a 22-node audit was
  // ~2.7K tokens with issueCount:0). Pass verbose:true for the full dump.
  const reported = verbose ? records : records.filter(recordHasFinding);

  return {
    root: root.id,
    nodeCount: records.length,
    reportedCount: reported.length,
    verbose,
    records: reported,
    summary: {
      issues,
      issueCount: issues.length,
      styleHints,
      styleHintCount: styleHints.length,
    },
  };
}
