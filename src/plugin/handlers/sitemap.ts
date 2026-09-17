/// <reference types="@figma/plugin-typings" />
/**
 * Draw a laid-out sitemap. Every coordinate arrives already computed by
 * src/shared/sitemap (the tidy-tree pass, or dagre when asked), so this
 * handler is deliberately dumb: lines first, then the page boxes on top of
 * them.
 *
 * Two things it does decide, and both are about the relation being drawn:
 *
 *  - **No arrow heads.** A head would say "go here next", which is the
 *    userflow's relation. A containment line is a bracket, not a route.
 *  - **A page box is a FRAME with its text INSIDE it**, not a rectangle with
 *    labels parked on top. That is what makes dragging a page in Figma carry
 *    its own name along — the state handler has to reposition four kinds of
 *    orphaned sibling text on every reflow, and a sitemap has one box per page
 *    and many of them, so the same trick would be four times the work and
 *    visible the first time somebody tidied the tree by hand.
 */
import { HandlerContext } from "../context.js";
import { createTree } from "./create.js";
import { rememberDrawnEdges, pageArtboards, pageModel, openDiagramFrame, preloadDiagramFonts } from "../diagram-apply.js";
import { err } from "../errors.js";
import { ErrorCode } from "../../shared/protocol.js";
import { SITEMAP_MARKER } from "../diagram-mark.js";
import type { DrawPage, SitemapDraw } from "../../shared/sitemap/types.js";
import type { DrawEdge } from "../../shared/diagram/types.js";

const INK = "#000f22";
const MUTED = "#5b6675";
const BODY = "#33404f";
const CHUNK = 60;

type Spec = Record<string, unknown>;

export async function createSitemap(ctx: HandlerContext): Promise<unknown> {
  const d = ctx.params as unknown as SitemapDraw;
  const font = typeof d?.font === "string" && d.font ? d.font : "Inter";
  if (!d || typeof d !== "object" || !Array.isArray(d.pages) || !Array.isArray(d.edges)) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      "create_sitemap expects laid-out draw data (pages/edges).",
      'Call it through the figma_diagram tool with type:"sitemap" — the server computes the layout.',
    );
  }

  await preloadDiagramFonts(ctx, font);

  const frame = await openDiagramFrame(
    ctx,
    {
      type: "FRAME",
      name: d.name,
      x: d.x,
      y: d.y,
      width: d.w,
      height: d.h,
      fill: "#ffffff",
      strokes: "#dfe4ea",
      strokeWeight: 1,
      cornerRadius: 16,
      clipsContent: false,
      ...(d.parentId ? { parentId: d.parentId } : {}),
    },
    d.intoFrameId,
  );

  // Painting order = z-order: lines underneath, boxes cover the ends that run
  // into them.
  const children: Spec[] = [...headerSpecs(d, font), ...edgeSpecs(d.edges), ...pageSpecs(d.pages, font)];

  let done = 0;
  for (const spec of children) {
    await createTree(sub(ctx, { ...spec, parentId: frame.id }), frame);
    done++;
    if (done % CHUNK === 0) ctx.progress(done, children.length, "drawing sitemap");
  }

  const nodeIds: Record<string, string> = {};
  for (const child of frame.children) {
    const hit = /^page:([^\s]+)/.exec(child.name);
    if (hit && hit[1]) nodeIds[hit[1]] = child.id;
  }

  rememberDrawnEdges(frame);
  frame.setPluginData(
    SITEMAP_MARKER,
    JSON.stringify({
      kind: "sitemap",
      title: d.title,
      nodes: Object.keys(nodeIds),
      // The MODEL, so the next change can be a patch instead of the whole
      // spec again. `graph` is where the layout PUT things and cannot be
      // edited back into a diagram; this can.
      ...(d.source !== undefined ? { source: d.source } : {}),
      ...(d.graph ? { graph: d.graph } : {}),
    }),
  );

  return {
    frameId: frame.id,
    pageModel: pageModel(frame),
    // The artboards ride back with the drawing, so "does the IA match the
    // designs?" costs no round trip — the same bargain `pageModel` already
    // strikes for the cross-check.
    ...(frame.parent && "children" in frame.parent
      ? { artboards: pageArtboards(frame.parent as BaseNode & ChildrenMixin) }
      : {}),
    name: frame.name,
    nodes: nodeIds,
    box: { x: frame.x, y: frame.y, w: frame.width, h: frame.height },
  };
}

function sub(ctx: HandlerContext, params: Spec): HandlerContext {
  return { params, warnings: ctx.warnings, progress: ctx.progress, warn: ctx.warn };
}

function headerSpecs(d: SitemapDraw, FONT: string): Spec[] {
  const out: Spec[] = [
    {
      type: "TEXT",
      name: "title",
      x: 32,
      y: 24,
      width: Math.max(120, d.w - 64),
      characters: d.title,
      fontSize: 20,
      fontFamily: FONT,
      fontStyle: "Bold",
      fill: INK,
      textAutoResize: "HEIGHT",
    },
  ];
  if (d.subtitle) {
    out.push({
      type: "TEXT",
      name: "subtitle",
      x: 32,
      y: 56,
      width: Math.max(120, d.w - 64),
      characters: d.subtitle,
      fontSize: 13,
      fontFamily: FONT,
      fontStyle: "Regular",
      fill: MUTED,
      textAutoResize: "HEIGHT",
    });
  }
  return out;
}

/**
 * A containment line: one VECTOR per parent→child pair, `endArrow` off.
 *
 * One layer per line rather than one bus polyline per parent, even though the
 * shoulders coincide and the two look identical: a line that is its own layer
 * can be re-routed on its own when its child is dragged, and can be hidden on
 * its own when the child is deleted.
 */
function edgeSpecs(edges: DrawEdge[]): Spec[] {
  return edges.map((e) => ({
    type: "VECTOR",
    name: `edge ${e.id}`,
    points: e.points,
    endArrow: false,
    strokes: e.color,
    strokeWeight: 1.25,
    strokeJoin: "ROUND",
    cornerRadius: 8,
    fills: [],
    ...(e.dashed ? { dashPattern: [5, 4] } : {}),
  }));
}

function pageSpecs(pages: DrawPage[], FONT: string): Spec[] {
  return pages.map((p) => {
    const kids: Spec[] = [
      {
        type: "TEXT",
        name: "name",
        layoutAlign: "STRETCH",
        characters: p.title.join("\n"),
        fontSize: 13,
        fontFamily: FONT,
        // The root and the sections are the scaffolding of the tree, so they
        // carry the weight; a leaf page is ordinary text.
        fontStyle: p.depth === 1 || p.kind === "section" ? "Bold" : "Medium",
        fill: INK,
        textAlignHorizontal: "CENTER",
        textAutoResize: "HEIGHT",
      },
    ];
    // A string rather than a list means the SERVER is an older build than this
    // plugin — they ship together, but a user who updates one and not the
    // other got `n.screenId.join is not a function`, which names nothing they
    // can act on. Read both shapes and draw the right thing.
    const arts =
      typeof p.screenId === "string"
        ? String(p.screenId).split(",").map((v) => v.trim()).filter(Boolean)
        : (p.screenId ?? []);
    if (arts.length) {
      kids.push({
        type: "TEXT",
        name: "screen",
        layoutAlign: "STRETCH",
        characters: `· ${arts.join(" · ")}`,
        fontSize: 11,
        fontFamily: FONT,
        fontStyle: "Regular",
        fill: MUTED,
        textAlignHorizontal: "CENTER",
        textAutoResize: "HEIGHT",
      });
    }
    if (p.detail.length) {
      kids.push({
        type: "TEXT",
        name: "detail",
        layoutAlign: "STRETCH",
        characters: p.detail.join("\n"),
        fontSize: 11,
        fontFamily: FONT,
        fontStyle: "Regular",
        fill: BODY,
        textAlignHorizontal: "CENTER",
        textAutoResize: "HEIGHT",
      });
    }
    return {
      type: "FRAME",
      name: p.name,
      x: p.at.x,
      y: p.at.y,
      width: p.at.w,
      height: p.at.h,
      fill: p.fill,
      strokes: p.stroke,
      // The root reads as the front door; everything else is the same weight,
      // because a level is not more important than its siblings.
      strokeWeight: p.depth === 1 ? 2 : 1.25,
      // OUTSIDE, so the border does not eat into the auto-layout content box —
      // with the default inside stroke the last line of a wrapped label hangs
      // past the bottom and comes back clipped.
      strokeAlign: "OUTSIDE",
      cornerRadius: p.radius,
      clipsContent: true,
      ...(p.dashed ? { dashPattern: [5, 4] } : {}),
      layoutMode: "VERTICAL",
      primaryAxisSizingMode: "FIXED",
      counterAxisSizingMode: "FIXED",
      primaryAxisAlignItems: "CENTER",
      counterAxisAlignItems: "CENTER",
      itemSpacing: 2,
      paddingLeft: 14,
      paddingRight: 14,
      paddingTop: 12,
      paddingBottom: 12,
      children: kids,
    };
  });
}
