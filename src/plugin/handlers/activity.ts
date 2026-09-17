/// <reference types="@figma/plugin-typings" />
/**
 * Draw a laid-out swimlane activity diagram. Every coordinate arrives already
 * computed by src/shared/activity (dagre for the rank order, lane-constrained
 * placement and corridor routing on the server), so this handler is
 * deliberately dumb: lanes first as the background, then the arrows, then the
 * steps on top of them, and the frame is tagged so a later drag can re-route
 * without a redraw.
 */
import { HandlerContext } from "../context.js";
import { createTree } from "./create.js";
import { rememberDrawnEdges, pageModel, openDiagramFrame, preloadDiagramFonts } from "../diagram-apply.js";
import { err } from "../errors.js";
import { ErrorCode } from "../../shared/protocol.js";
import { ACTIVITY_MARKER } from "../diagram-mark.js";
import type { ActivityDraw, DrawLane, DrawStep } from "../../shared/activity/types.js";
import type { DrawEdge } from "../../shared/diagram/types.js";

const INK = "#000f22";
const MUTED = "#5b6675";
const DETAIL = "#33404f";
const LANE_TEXT = "#1f2937";
const CHUNK = 60;

type Spec = Record<string, unknown>;

export async function createActivity(ctx: HandlerContext): Promise<unknown> {
  const d = ctx.params as unknown as ActivityDraw;
  const font = typeof d?.font === "string" && d.font ? d.font : "Inter";
  if (!d || typeof d !== "object" || !Array.isArray(d.steps) || !Array.isArray(d.lanes)) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      "create_activity expects laid-out draw data (lanes/steps/edges).",
      'Call it through the figma_diagram tool with type:"activity" — the server computes the layout.',
    );
  }

  // Painting order = z-order: lanes are the background, arrows sit on them,
  // steps cover the arrows that run into them, text and labels go on top.
  //
  // Built BEFORE the frame is opened. Redrawing in place (intoFrameId) empties
  // the frame as it opens it, so a malformed piece of draw data that threw
  // here used to leave the user's diagram wiped with nothing drawn back.
  // Anything wrong with the data now fails while the canvas is untouched.
  let children: Spec[];
  try {
    children = [
      headerSpecs(d, font),
      laneSpecs(d.lanes, font),
      edgeSpecs(d.edges),
      stepSpecs(d.steps, font),
      labelSpecs(d.edges, font),
    ].reduce<Spec[]>((all, part) => all.concat(part), []);
  } catch (e) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      `create_activity got malformed draw data (${e instanceof Error ? e.message : String(e)}) — nothing was changed.`,
      'Call it through the figma_diagram tool with type:"activity" — the server computes the layout.',
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

  let done = 0;
  for (const spec of children) {
    await createTree(sub(ctx, { ...spec, parentId: frame.id }), frame);
    done++;
    if (done % CHUNK === 0) ctx.progress(done, children.length, "drawing activity diagram");
  }

  const nodeIds: Record<string, string> = {};
  const laneIds: Record<string, string> = {};
  for (const child of frame.children) {
    const step = /^step:([^\s]+)/.exec(child.name);
    if (step && step[1]) nodeIds[step[1]] = child.id;
    const lane = /^lane:([^\s]+)/.exec(child.name);
    if (lane && lane[1]) laneIds[lane[1]] = child.id;
  }

  rememberDrawnEdges(frame);
  frame.setPluginData(
    ACTIVITY_MARKER,
    JSON.stringify({
      kind: "activity",
      title: d.title,
      nodes: Object.keys(nodeIds),
      lanes: Object.keys(laneIds),
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
    nodes: nodeIds,
    lanes: laneIds,
    box: { x: frame.x, y: frame.y, w: frame.width, h: frame.height },
  };
}


function sub(ctx: HandlerContext, params: Spec): HandlerContext {
  return { params, warnings: ctx.warnings, progress: ctx.progress, warn: ctx.warn };
}

function headerSpecs(d: ActivityDraw, FONT: string): Spec[] {
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

function laneSpecs(lanes: DrawLane[], FONT: string): Spec[] {
  const out: Spec[] = [];
  for (const lane of lanes) {
    out.push({
      type: "FRAME",
      name: `lane:${lane.id}`,
      x: lane.at.x,
      y: lane.at.y,
      width: lane.at.w,
      height: lane.at.h,
      fill: lane.fill,
      strokes: lane.stroke,
      strokeWeight: 1,
      cornerRadius: 0,
      clipsContent: false,
    });
    // The name and its detail are stacked by AUTO-LAYOUT, not by y offsets we
    // computed: a lane called "Ngân hàng lõi" wraps to two lines in the name
    // strip, and the hand-placed detail line landed on top of it. Figma does
    // the stacking correctly whatever the text does.
    const inner: Spec[] = [
      {
        type: "TEXT",
        name: "name",
        width: Math.max(40, lane.header.w - 20),
        characters: lane.label,
        fontSize: 13,
        fontFamily: FONT,
        fontStyle: "Semi Bold",
        fill: LANE_TEXT,
        textAlignHorizontal: "CENTER",
        textAutoResize: "HEIGHT",
      },
    ];
    if (lane.detail) {
      inner.push({
        type: "TEXT",
        name: "detail",
        width: Math.max(40, lane.header.w - 20),
        characters: lane.detail,
        fontSize: 11,
        fontFamily: FONT,
        fontStyle: "Regular",
        fill: MUTED,
        textAlignHorizontal: "CENTER",
        textAutoResize: "HEIGHT",
      });
    }
    out.push({
      type: "FRAME",
      name: `lane-head:${lane.id}`,
      x: lane.header.x,
      y: lane.header.y,
      width: lane.header.w,
      height: lane.header.h,
      fill: lane.headerFill,
      strokes: lane.stroke,
      strokeWeight: 1,
      cornerRadius: 0,
      clipsContent: false,
      layoutMode: "VERTICAL",
      primaryAxisSizingMode: "FIXED",
      counterAxisSizingMode: "FIXED",
      primaryAxisAlignItems: "CENTER",
      counterAxisAlignItems: "CENTER",
      itemSpacing: 2,
      padding: 10,
      children: inner,
    });
  }
  return out;
}

function edgeSpecs(edges: DrawEdge[]): Spec[] {
  const out: Spec[] = [];
  for (const e of edges) {
    // ONE layer per edge: the head is a cap on the line's last point, so
    // dragging that point in Figma drags the arrow head with it.
    out.push({
      type: "VECTOR",
      name: `edge ${e.id}`,
      points: e.points,
      endArrow: true,
      strokes: e.color,
      strokeWeight: 1.5,
      strokeJoin: "ROUND",
      cornerRadius: 6,
      fills: [],
      ...(e.dashed ? { dashPattern: [6, 4] } : {}),
    });
  }
  return out;
}

function stepSpecs(steps: DrawStep[], FONT: string): Spec[] {
  const out: Spec[] = [];
  for (const s of steps) {
    out.push(shapeSpec(s, FONT));
    const label = s.outside?.text ?? s.title;
    if (s.outside && label) {
      out.push({
        type: "TEXT",
        name: `text:${s.id}`,
        x: s.outside.at.x,
        y: s.outside.at.y,
        width: s.outside.at.w,
        characters: label,
        fontSize: 11,
        fontFamily: FONT,
        fontStyle: "Medium",
        fill: INK,
        textAlignHorizontal: s.outside.align,
        textAutoResize: "HEIGHT",
      });
    }
  }
  return out;
}

function shapeSpec(s: DrawStep, FONT: string): Spec {
  const base: Spec = {
    name: s.name,
    x: s.at.x,
    y: s.at.y,
    width: s.at.w,
    height: s.at.h,
    fill: s.fill,
    strokes: s.stroke,
    strokeWeight: s.strokeWeight,
    ...(s.dashed ? { dashPattern: [6, 4] } : {}),
  };

  // A diamond and a bar carry their text as a sibling: a POLYGON cannot hold
  // children, and a bar is 10px thick.
  if (s.kind === "decision") {
    return { ...base, type: "POLYGON", pointCount: 4 };
  }
  if (s.kind === "fork" || s.kind === "join") {
    return { ...base, type: "RECTANGLE", cornerRadius: s.radius };
  }

  const inner: Spec[] = [];
  const titleLines = s.title.split("\n").length;
  const pill = s.kind === "start" || s.kind === "end";
  inner.push({
    type: "TEXT",
    name: "title",
    x: 16,
    y: pill ? Math.max(6, s.at.h / 2 - 9) : 12,
    width: s.at.w - 32,
    characters: s.title,
    fontSize: pill ? 12 : 13,
    fontFamily: FONT,
    fontStyle: pill ? "Medium" : "Semi Bold",
    fill: s.invert ? "#ffffff" : INK,
    textAlignHorizontal: pill ? "CENTER" : "LEFT",
    textAutoResize: "HEIGHT",
  });
  if (s.detail) {
    inner.push({
      type: "TEXT",
      name: "detail",
      x: 16,
      y: 12 + titleLines * 18 + 4,
      width: s.at.w - 32,
      characters: s.detail,
      fontSize: 12,
      fontFamily: FONT,
      fontStyle: "Regular",
      fill: DETAIL,
      textAutoResize: "HEIGHT",
    });
  }
  return {
    ...base,
    type: "FRAME",
    cornerRadius: s.radius,
    clipsContent: false,
    children: inner,
  };
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
      strokes: l.muted ? "#d5dbe3" : "#cbd5e1",
      strokeWeight: 1,
      cornerRadius: l.h / 2,
      clipsContent: false,
      children: [
        {
          type: "TEXT",
          name: "t",
          x: 0,
          y: 4,
          width: l.w,
          characters: l.text,
          fontSize: 11,
          fontFamily: FONT,
          fontStyle: l.muted ? "Regular" : "Medium",
          fill: l.muted ? MUTED : INK,
          textAlignHorizontal: "CENTER",
          textAutoResize: "HEIGHT",
        },
      ],
    });
  }
  return out;
}
