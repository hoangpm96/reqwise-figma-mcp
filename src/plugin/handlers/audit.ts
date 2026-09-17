/// <reference types="@figma/plugin-typings" />
import { HandlerContext, requireNode } from "../context.js";
import { r2 } from "../num.js";
import {
  contrastRatio,
  compositeOver,
  type RGB,
  type RGBA,
} from "../color-util.js";
import { isDiagramLayerName } from "../diagram-mark.js";
import { loadNodeFonts } from "../fonts.js";

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

/** First visible solid fill WITH its effective alpha (paint opacity × fill α). */
export function firstSolidFillRgba(node: SceneNode): RGBA | null {
  const fills = (node as GeometryMixin).fills;
  if (!Array.isArray(fills)) return null;
  for (const f of fills) {
    if (f && f.type === "SOLID" && f.visible !== false) {
      const opacity = typeof f.opacity === "number" ? f.opacity : 1;
      return { r: f.color.r, g: f.color.g, b: f.color.b, a: opacity };
    }
  }
  return null;
}

/** Nearest OPAQUE ancestor background (0..1), compositing translucent layers. */
export function effectiveBackground(node: SceneNode): RGB | null {
  const layers: RGBA[] = [];
  let cur: BaseNode | null = node.parent;
  while (cur) {
    if ("fills" in cur) {
      const c = firstSolidFillRgba(cur as SceneNode);
      if (c) {
        layers.push(c);
        if (c.a >= 0.999) break; // fully opaque — stop climbing
      }
    }
    cur = cur.parent;
  }
  if (layers.length === 0) return null;
  // Composite from the furthest opaque layer forward toward the node.
  let acc: RGB = { r: layers[layers.length - 1]!.r, g: layers[layers.length - 1]!.g, b: layers[layers.length - 1]!.b };
  for (let i = layers.length - 2; i >= 0; i--) acc = compositeOver(layers[i]!, acc);
  return acc;
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

  // A drawn diagram's own layers are notation, not design decisions: a table's
  // rows are full-bleed on purpose, a start pill's radius is its meaning. The
  // TEXT inside them is still checked — contrast has caught real bugs twice.
  if (isDiagramLayerName(node.name)) return out;

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
  //    Diagram layers are exempt: a start pill next to an action box differs on
  //    purpose, and that is notation, not a token that slipped.
  if (surface && radius !== null && node.width >= 64 && node.height >= 24 && !isDiagramLayerName(node.name)) {
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

  // 5. Text-vs-background contrast, judged by the REAL WCAG ratio (not RGB
  //    distance), through the true composited background and the text's alpha.
  if (node.type === "TEXT") {
    const fgRgba = firstSolidFillRgba(node);
    const bg = effectiveBackground(node);
    if (fgRgba && bg) {
      const fg = compositeOver(fgRgba, bg); // flatten translucent text
      const ratio = contrastRatio(fg, bg);
      const min = wcagMinRatio(node);
      if (ratio < min) {
        out.push(
          `Text contrast ${r2(ratio)}:1 is below the WCAG minimum ${min}:1 for this size — hard to read. Darken the text or lighten the background.`,
        );
      }
    }
  }

  return out;
}

/**
 * WCAG 1.4.3 threshold: 3:1 for "large" text (≥24px, or ≥18.66px bold),
 * otherwise 4.5:1. Bold is inferred from the font style/weight when available.
 */
export function wcagMinRatio(node: TextNode): number {
  const size = typeof node.fontSize === "number" ? node.fontSize : 16;
  const style =
    typeof node.fontName === "object" &&
    node.fontName &&
    "style" in node.fontName
      ? String((node.fontName as FontName).style)
      : "";
  const bold = /bold|black|heavy|semibold|extrabold/i.test(style);
  const isLarge = size >= 24 || (bold && size >= 18.66);
  return isLarge ? 3 : 4.5;
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
 * through. We instead compare the box against the text's intrinsic size.
 */
async function isTextTruncated(
  t: TextNode,
  rendered: { width: number; height: number } | null,
): Promise<boolean> {
  if (t.textAutoResize === "TRUNCATE") return true;
  if (t.textAutoResize !== "NONE") return false;

  const boxW = rendered?.width ?? t.width;
  const boxH = rendered?.height ?? t.height;

  // Intrinsic size the text WANTS if it could grow: clone the node, lift the
  // fixed height, and let Figma's glyph layout re-measure it. (This used to
  // re-fetch the SAME node through the synchronous figma.getNodeById — which
  // throws outright under this manifest's documentAccess:"dynamic-page" — and
  // read back the box's own fixed height, so the branch could never fire.) A
  // mixed/unloadable font can still throw, so guard and fall through.
  try {
    await loadNodeFonts(t); // mixed-safe: every range font, once each
    const probe = t.clone();
    try {
      // HEIGHT keeps the box width and lets the wrapped text take the height
      // it needs — taller than the declared box means clipped content.
      probe.textAutoResize = "HEIGHT";
      if (probe.height > boxH + 0.5) return true;
    } finally {
      probe.remove();
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
 * "This looks like a scrim and it is not on top."
 *
 * Exported so the exemption is testable: a layer a DIAGRAM tool drew is left
 * alone, for the same reason the style hints leave it alone — the tool decided
 * that z-order deliberately. A journey map's column band is a big
 * semi-transparent rectangle that BELONGS at the bottom, grouping a column
 * behind its cells, and `isOverlayLike` reads any large translucent rect as a
 * scrim. Without the exemption every journey map came back with one
 * "move to top" issue per phase: advice that would break a correct drawing,
 * which is the fastest way to teach somebody to stop reading the audit.
 */
export function zIndexWarningsFor(
  node: SceneNode,
  index: number,
  siblingCount: number,
): string[] {
  if (siblingCount <= 0) return [];
  if (!isOverlayLike(node)) return [];
  if (isDiagramLayerName(node.name)) return [];
  if (index === siblingCount - 1) return [];
  return [
    `Overlay-like node is at z-index ${index}/${siblingCount - 1}; content above it will not be dimmed. Move to top.`,
  ];
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

  // Subtree-wide consistency collectors (the "why does this look busy/flat"
  // signals that per-node checks can't see). Filled during the walk, analyzed
  // once at the end.
  const fontSizes: number[] = [];
  const cornerRadii: number[] = [];
  const gaps: number[] = []; // itemSpacing of auto-layout frames with ≥2 kids

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
      textTruncated = await isTextTruncated(node as TextNode, rendered);
    }

    const zWarnings = zIndexWarningsFor(node, frame.index, frame.siblings.length);

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

    // Collect subtree-wide consistency signals. A drawn diagram is exempt: its
    // radii ARE its notation — a 20px start pill, a 4px fork bar, an 11.5px
    // label pill — so counting them as an unsystematic scale sends the agent
    // off to "fix" the vocabulary of the drawing.
    const generated = isDiagramLayerName(node.name);
    if (!generated && node.type === "TEXT" && typeof node.fontSize === "number") {
      fontSizes.push(node.fontSize);
    }
    const nr = numericCornerRadius(node);
    if (!generated && nr !== null && nr > 0 && hasVisibleSurface(node)) cornerRadii.push(nr);
    if (
      !generated &&
      "layoutMode" in node &&
      (node as FrameNode).layoutMode !== "NONE" &&
      "children" in node &&
      (node as ChildrenMixin).children.length >= 2 &&
      typeof (node as FrameNode).itemSpacing === "number"
    ) {
      gaps.push((node as FrameNode).itemSpacing);
    }

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

  // Subtree-wide aesthetic signals (added to styleHints, never to issues).
  for (const h of subtreeStyleHints(fontSizes, cornerRadii, gaps)) {
    styleHints.push(h);
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

/**
 * Consistency hints computed across the whole subtree — the signals a per-node
 * pass can't see: too many distinct font sizes (busy typography), too many
 * distinct radii (incoherent shapes), and uniform spacing (no visual grouping).
 * Conservative thresholds so a normal screen stays quiet.
 */
export function subtreeStyleHints(
  fontSizes: readonly number[],
  cornerRadii: readonly number[],
  gaps: readonly number[],
): string[] {
  const out: string[] = [];

  const distinctSizes = uniqueSorted(fontSizes);
  if (distinctSizes.length > 6) {
    out.push(
      `Typography uses ${distinctSizes.length} distinct font sizes (${distinctSizes.join("/")}) — this reads as busy/unsystematic. Collapse to a 4–6 step scale via text styles (figma_docs(section="style")).`,
    );
  }

  const distinctRadii = uniqueSorted(cornerRadii);
  if (distinctRadii.length > 4) {
    out.push(
      `Corners use ${distinctRadii.length} distinct radii (${distinctRadii.join("/")}) — bind a small radius scale (e.g. 8/12/16) instead of arbitrary values.`,
    );
  }

  // Uniform spacing = no grouping. If there are several gaps and they're ALL
  // identical, proximity can't signal what belongs together.
  const distinctGaps = uniqueSorted(gaps);
  if (gaps.length >= 4 && distinctGaps.length === 1) {
    out.push(
      `Every gap is ${distinctGaps[0]}px — uniform spacing gives no visual grouping. Make in-group spacing tighter than between-group spacing (e.g. 8px inside a field, 24px between sections).`,
    );
  }

  return out;
}

function uniqueSorted(nums: readonly number[]): number[] {
  return Array.from(new Set(nums.map((n) => Math.round(n * 100) / 100))).sort(
    (a, b) => a - b,
  );
}
