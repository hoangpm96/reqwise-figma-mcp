/// <reference types="@figma/plugin-typings" />
/**
 * Draw a laid-out entity-relationship diagram. Coordinates arrive computed by
 * src/shared/erd, so this handler only turns them into nodes.
 *
 * Two things differ from the other diagrams. A table is built with AUTO-LAYOUT
 * — the header and one frame per column — because a column list is exactly the
 * kind of stacked text that hand-computed offsets get wrong the moment a name
 * is longer than expected. And a relationship carries a crow's foot at each
 * end instead of an arrow head, drawn as its own little stroke group.
 */
import { HandlerContext } from "../context.js";
import { createTree } from "./create.js";
import { err } from "../errors.js";
import { ErrorCode } from "../../shared/protocol.js";
import { ERD_MARKER } from "../diagram-mark.js";
import { rememberDrawnEdges, pageModel, openDiagramFrame, preloadDiagramFonts } from "../diagram-apply.js";
import type { DrawEntity, DrawMarker, ErdDraw } from "../../shared/erd/types.js";
import type { DrawEdge } from "../../shared/diagram/types.js";

const INK = "#000f22";
const MUTED = "#5b6675";
const TYPE_TEXT = "#5b6675";
const KEY_TEXT = "#8a6d1f";
const FK_TEXT = "#3f5c78";
const ZEBRA = "#fbfcfd";
const CHUNK = 60;

type Spec = Record<string, unknown>;

export async function createErd(ctx: HandlerContext): Promise<unknown> {
  const d = ctx.params as unknown as ErdDraw;
  const font = typeof d?.font === "string" && d.font ? d.font : "Inter";
  if (!d || typeof d !== "object" || !Array.isArray(d.entities) || !Array.isArray(d.edges)) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      "create_erd expects laid-out draw data (entities/edges/markers).",
      'Call it through the figma_diagram tool with type:"erd" — the server computes the layout.',
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

  // Lines first, tables over them, notation and labels on top.
  const children: Spec[] = [
    headerSpecs(d, font),
    edgeSpecs(d.edges),
    entitySpecs(d.entities, font),
    markerSpecs(d.markers),
    labelSpecs(d.edges, font),
  ].reduce<Spec[]>((all, part) => all.concat(part), []);

  let done = 0;
  for (const spec of children) {
    await createTree(sub(ctx, { ...spec, parentId: frame.id }), frame);
    done++;
    if (done % CHUNK === 0) ctx.progress(done, children.length, "drawing the data model");
  }

  const nodeIds: Record<string, string> = {};
  for (const child of frame.children) {
    const match = /^entity:([^\s]+)/.exec(child.name);
    if (match && match[1]) nodeIds[match[1]] = child.id;
  }

  rememberDrawnEdges(frame);
  frame.setPluginData(
    ERD_MARKER,
    JSON.stringify({
      kind: "erd",
      title: d.title,
      entities: Object.keys(nodeIds),
      // The MODEL, so the next change can be a patch instead of the whole
      // spec again. `graph` is the ROUTING — where the layout put things —
      // and cannot be edited back into a diagram; this can.
      ...(d.source !== undefined ? { source: d.source } : {}),
      ...(d.graph ? { graph: d.graph } : {}),
    }),
  );

  return {
    frameId: frame.id,
    pageModel: pageModel(frame),
    name: frame.name,
    entities: nodeIds,
    box: { x: frame.x, y: frame.y, w: frame.width, h: frame.height },
  };
}


function sub(ctx: HandlerContext, params: Spec): HandlerContext {
  return { params, warnings: ctx.warnings, progress: ctx.progress, warn: ctx.warn };
}

function headerSpecs(d: ErdDraw, FONT: string): Spec[] {
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

function entitySpecs(entities: DrawEntity[], FONT: string): Spec[] {
  return entities.map((e) => {
    const header: Spec[] = [
      {
        type: "TEXT",
        name: "name",
        characters: e.title,
        fontSize: 14,
        fontFamily: FONT,
        fontStyle: "Bold",
        fill: INK,
        textAutoResize: "WIDTH_AND_HEIGHT",
      },
    ];
    if (e.detail) {
      header.push({
        type: "TEXT",
        name: "detail",
        characters: e.detail,
        fontSize: 11,
        fontFamily: FONT,
        fontStyle: "Regular",
        fill: MUTED,
        textAutoResize: "WIDTH_AND_HEIGHT",
      });
    }

    const rows: Spec[] = e.attributes.map((a, i) => {
      const left: Spec[] = [];
      if (e.badgeW > 0) {
        left.push({
          type: "TEXT",
          name: "key",
          characters: a.badge,
          fontSize: 9,
          fontFamily: FONT,
          fontStyle: "Bold",
          fill: a.badge.indexOf("PK") === 0 ? KEY_TEXT : FK_TEXT,
          width: e.badgeW - 8,
          textAutoResize: "HEIGHT",
        });
      }
      left.push({
        type: "TEXT",
        name: "col",
        characters: a.required ? `${a.name} •` : a.name,
        fontSize: 12,
        fontFamily: FONT,
        fontStyle: a.badge ? "Medium" : "Regular",
        fill: INK,
        textAutoResize: "WIDTH_AND_HEIGHT",
      });

      const cells: Spec[] = [
        {
          type: "FRAME",
          name: "left",
          fills: [],
          layoutMode: "HORIZONTAL",
          primaryAxisSizingMode: "AUTO",
          counterAxisSizingMode: "AUTO",
          counterAxisAlignItems: "CENTER",
          itemSpacing: 0,
          children: left,
        },
      ];
      if (a.type) {
        cells.push({
          type: "TEXT",
          name: "type",
          characters: a.type,
          fontSize: 11,
          fontFamily: FONT,
          fontStyle: "Regular",
          fill: TYPE_TEXT,
          textAutoResize: "WIDTH_AND_HEIGHT",
        });
      }
      return {
        type: "FRAME",
        name: `row ${a.name}`,
        // STRETCH, not a fixed width: a row as wide as its table overflows it
        // by the stroke, and every row came back clipped by 1.5px.
        layoutAlign: "STRETCH",
        height: a.h,
        // Only the striped rows get a fill; a white row on a white table is
        // a slab, and the audit says so (rightly).
        ...(i % 2 === 1 ? { fill: ZEBRA } : { fills: [] }),
        strokes: [],
        cornerRadius: 0,
        clipsContent: true,
        layoutMode: "HORIZONTAL",
        primaryAxisSizingMode: "FIXED",
        counterAxisSizingMode: "FIXED",
        primaryAxisAlignItems: "SPACE_BETWEEN",
        counterAxisAlignItems: "CENTER",
        itemSpacing: 8,
        paddingLeft: 12,
        paddingRight: 12,
        children: cells,
      };
    });

    return {
      type: "FRAME",
      name: e.name,
      x: e.at.x,
      y: e.at.y,
      width: e.at.w,
      height: e.at.h,
      fill: "#ffffff",
      strokes: e.stroke,
      strokeWeight: 1.5,
      // OUTSIDE, so the border does not eat into the auto-layout content box:
      // with the default inside stroke the last row of every table hung 3px
      // past the bottom and came back clipped.
      strokeAlign: "OUTSIDE",
      cornerRadius: 10,
      clipsContent: true,
      ...(e.dashed ? { dashPattern: [6, 4] } : {}),
      layoutMode: "VERTICAL",
      primaryAxisSizingMode: "FIXED",
      counterAxisSizingMode: "FIXED",
      itemSpacing: 0,
      padding: 0,
      children: [
        {
          type: "FRAME",
          name: "header",
          layoutAlign: "STRETCH",
          height: e.headerH,
          fill: e.headerFill,
          strokes: [],
          cornerRadius: 0,
          clipsContent: true,
          layoutMode: "VERTICAL",
          primaryAxisSizingMode: "FIXED",
          counterAxisSizingMode: "FIXED",
          primaryAxisAlignItems: "CENTER",
          itemSpacing: 1,
          paddingLeft: 12,
        paddingRight: 12,
          children: header,
        },
        ...rows,
      ],
    };
  });
}

function edgeSpecs(edges: DrawEdge[]): Spec[] {
  return edges.map((e) => ({
    type: "VECTOR",
    name: `edge ${e.id}`,
    points: e.points,
    strokes: e.color,
    strokeWeight: 1.5,
    strokeCap: "NONE",
    strokeJoin: "ROUND",
    cornerRadius: 6,
    fills: [],
    ...(e.dashed ? { dashPattern: [6, 4] } : {}),
  }));
}

/** The crow's feet, ticks and optionality circles. */
function markerSpecs(markers: DrawMarker[]): Spec[] {
  const out: Spec[] = [];
  for (const m of markers) {
    if (m.strokes.length) {
      out.push({
        type: "VECTOR",
        name: `mark ${m.id}`,
        strokeGroup: m.strokes,
        strokes: m.color,
        strokeWeight: 1.5,
        strokeCap: "NONE",
        fills: [],
      });
    }
    if (m.circle) {
      out.push({
        type: "ELLIPSE",
        name: `mark-o ${m.id}`,
        x: m.circle.x,
        y: m.circle.y,
        width: m.circle.r * 2,
        height: m.circle.r * 2,
        fill: "#ffffff",
        strokes: m.color,
        strokeWeight: 1.5,
      });
    }
  }
  return out;
}

function labelSpecs(edges: DrawEdge[], FONT: string): Spec[] {
  const out: Spec[] = [];
  for (const e of edges) {
    const l = e.label;
    if (!l) continue;
    out.push({
      type: "FRAME",
      name: `label ${e.id}`,
      x: l.x,
      y: l.y,
      width: l.w,
      height: l.h,
      fill: "#ffffff",
      strokes: "#cbd5e1",
      strokeWeight: 1,
      cornerRadius: l.h / 2,
      clipsContent: false,
      children: [
        {
          type: "TEXT",
          name: "t",
          x: 0,
          y: 3,
          width: l.w,
          characters: l.text,
          fontSize: 11,
          fontFamily: FONT,
          fontStyle: "Medium",
          fill: INK,
          textAlignHorizontal: "CENTER",
          textAutoResize: "HEIGHT",
        },
      ],
    });
  }
  return out;
}
