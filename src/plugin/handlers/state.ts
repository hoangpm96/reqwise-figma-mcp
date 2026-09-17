/// <reference types="@figma/plugin-typings" />
/**
 * Draw a laid-out state machine. Every coordinate arrives already computed by
 * src/shared/state (dagre for the rank order, the shared orthogonal router for
 * the transitions), so this handler is deliberately dumb: arrows first, then
 * the states on top of them, then the labels.
 *
 * The one thing it does decide is what a UML shape is made of — a starting dot
 * is an ellipse, a final state is a ring drawn as two, and a state box carries
 * a separator rule between its name and its `entry / do / exit`.
 */
import { HandlerContext } from "../context.js";
import { createTree } from "./create.js";
import { rememberDrawnEdges, pageModel, openDiagramFrame, preloadDiagramFonts } from "../diagram-apply.js";
import { err } from "../errors.js";
import { ErrorCode } from "../../shared/protocol.js";
import { STATE_MARKER } from "../diagram-mark.js";
import type { DrawState, StateDraw } from "../../shared/state/types.js";
import type { DrawEdge } from "../../shared/diagram/types.js";

const INK = "#000f22";
const MUTED = "#5b6675";
const BODY = "#33404f";
const RULE = "#dfe4ea";
const CHUNK = 60;

type Spec = Record<string, unknown>;

export async function createState(ctx: HandlerContext): Promise<unknown> {
  const d = ctx.params as unknown as StateDraw;
  const font = typeof d?.font === "string" && d.font ? d.font : "Inter";
  if (!d || typeof d !== "object" || !Array.isArray(d.states) || !Array.isArray(d.edges)) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      "create_state expects laid-out draw data (states/edges).",
      'Call it through the figma_diagram tool with type:"state" — the server computes the layout.',
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

  // Painting order = z-order: arrows underneath, states cover the lines that
  // run into them, text and labels on top.
  const children: Spec[] = [
    headerSpecs(d, font),
    edgeSpecs(d.edges),
    stateSpecs(d.states, font),
    labelSpecs(d.edges, font),
  ].reduce<Spec[]>((all, part) => all.concat(part), []);

  let done = 0;
  for (const spec of children) {
    await createTree(sub(ctx, { ...spec, parentId: frame.id }), frame);
    done++;
    if (done % CHUNK === 0) ctx.progress(done, children.length, "drawing state diagram");
  }

  const nodeIds: Record<string, string> = {};
  for (const child of frame.children) {
    const hit = /^state:([^\s]+)/.exec(child.name);
    if (hit && hit[1]) nodeIds[hit[1]] = child.id;
  }

  rememberDrawnEdges(frame);
  frame.setPluginData(
    STATE_MARKER,
    JSON.stringify({
      kind: "state",
      title: d.title,
      nodes: Object.keys(nodeIds),
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
    box: { x: frame.x, y: frame.y, w: frame.width, h: frame.height },
  };
}


function sub(ctx: HandlerContext, params: Spec): HandlerContext {
  return { params, warnings: ctx.warnings, progress: ctx.progress, warn: ctx.warn };
}

function headerSpecs(d: StateDraw, FONT: string): Spec[] {
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

function stateSpecs(states: DrawState[], FONT: string): Spec[] {
  const out: Spec[] = [];
  for (const s of states) {
    out.push(shapeSpec(s, FONT));
    // The filled centre of a final state is its own layer: an ellipse cannot
    // hold children, and a ring is two circles however you slice it.
    if (s.inner) {
      out.push({
        type: "ELLIPSE",
        name: `ring:${s.id}`,
        x: s.inner.x,
        y: s.inner.y,
        width: s.inner.w,
        height: s.inner.h,
        fill: s.stroke,
        strokes: [],
      });
    }
    if (s.outside && s.title) {
      out.push({
        type: "TEXT",
        name: `text:${s.id}`,
        x: s.outside.at.x,
        y: s.outside.at.y,
        width: s.outside.at.w,
        characters: s.title,
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

function shapeSpec(s: DrawState, FONT: string): Spec {
  const base: Spec = {
    name: s.name,
    x: s.at.x,
    y: s.at.y,
    width: s.at.w,
    height: s.at.h,
    fill: s.fill,
    ...(s.strokeWeight > 0 ? { strokes: s.stroke, strokeWeight: s.strokeWeight } : { strokes: [] }),
  };

  if (s.kind === "initial" || s.kind === "final") {
    return { ...base, type: "ELLIPSE" };
  }
  // A diamond and a bar carry their text as a sibling: a POLYGON cannot hold
  // children, and a bar is 10px thick.
  if (s.kind === "choice") {
    return { ...base, type: "POLYGON", pointCount: 4 };
  }
  if (s.kind === "fork" || s.kind === "join") {
    return { ...base, type: "RECTANGLE", cornerRadius: s.radius };
  }

  const inner: Spec[] = [
    {
      type: "TEXT",
      name: "name",
      x: 16,
      y: 12,
      width: s.at.w - 32,
      characters: s.title,
      fontSize: 13,
      fontFamily: FONT,
      fontStyle: "Semi Bold",
      fill: INK,
      textAutoResize: "HEIGHT",
    },
  ];
  // The rule under the name is what makes a UML state read as a state. It is
  // drawn full width — the compartment divides the whole box, not the padding.
  if (s.body.length && typeof s.ruleY === "number") {
    inner.push({
      type: "RECTANGLE",
      name: "rule",
      x: 0,
      y: s.ruleY,
      width: s.at.w,
      height: 1,
      fill: RULE,
      strokes: [],
    });
    inner.push({
      type: "TEXT",
      name: "body",
      x: 16,
      y: s.ruleY + 7,
      width: s.at.w - 32,
      characters: s.body.join("\n"),
      fontSize: 11,
      fontFamily: FONT,
      fontStyle: "Regular",
      fill: BODY,
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
