/// <reference types="@figma/plugin-typings" />
/**
 * Draw a laid-out sequence diagram. Coordinates arrive computed by
 * src/shared/sequence, so this handler only turns them into nodes.
 *
 * Painting order carries meaning here: the fragment boxes are the background a
 * block of messages sits in, the lifelines hang behind everything, the
 * activation bars sit on the lifelines, and the arrows and their labels go on
 * top of all of it.
 */
import { HandlerContext } from "../context.js";
import { createTree } from "./create.js";
import { err } from "../errors.js";
import { ErrorCode } from "../../shared/protocol.js";
import { SEQUENCE_MARKER } from "../diagram-mark.js";
import { rememberDrawnEdges, pageModel, openDiagramFrame, preloadDiagramFonts } from "../diagram-apply.js";
import type {
  DrawActivation,
  DrawFragment,
  DrawMessage,
  DrawParticipant,
  SequenceDraw,
} from "../../shared/sequence/types.js";

const INK = "#000f22";
const MUTED = "#5b6675";
const LIFELINE = "#aeb6c2";
const BAR_FILL = "#dfe5ec";
const BAR_STROKE = "#8a94a6";
const FRAG_STROKE = "#94a3b8";
const FRAG_TAB = "#eef2f7";
const NOTE_FILL = "#fffbe6";
const NOTE_STROKE = "#e6d9a8";
const CHUNK = 60;

type Spec = Record<string, unknown>;

export async function createSequence(ctx: HandlerContext): Promise<unknown> {
  const d = ctx.params as unknown as SequenceDraw;
  const font = typeof d?.font === "string" && d.font ? d.font : "Inter";
  if (!d || typeof d !== "object" || !Array.isArray(d.participants) || !Array.isArray(d.messages)) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      "create_sequence expects laid-out draw data (participants/messages).",
      'Call it through the figma_diagram tool with type:"sequence" — the server computes the layout.',
    );
  }

  // Order matters: the fragment BOXES are the background a block sits in, the
  // lifelines hang behind everything, bars sit on them, arrows over those —
  // and the fragment TABS go on top, because a lifeline drawn through the word
  // "alt" makes the block look like a mistake.
  //
  // Built BEFORE the frame is opened. Redrawing in place (intoFrameId) empties
  // the frame as it opens it, so a malformed piece of draw data that threw
  // here used to leave the user's diagram wiped with nothing drawn back.
  // Anything wrong with the data now fails while the canvas is untouched.
  let children: Spec[];
  try {
    children = [
      headerSpecs(d, font),
      fragmentBoxSpecs(d.fragments),
      lifelineSpecs(d.participants),
      activationSpecs(d.activations),
      messageSpecs(d.messages),
      participantSpecs(d.participants, font),
      fragmentLabelSpecs(d.fragments, font),
      labelSpecs(d.messages, font),
    ].reduce<Spec[]>((all, part) => all.concat(part), []);
  } catch (e) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      `create_sequence got malformed draw data (${e instanceof Error ? e.message : String(e)}) — nothing was changed.`,
      'Call it through the figma_diagram tool with type:"sequence" — the server computes the layout.',
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
    if (done % CHUNK === 0) ctx.progress(done, children.length, "drawing the sequence");
  }

  const nodeIds: Record<string, string> = {};
  for (const child of frame.children) {
    const match = /^party:([^\s]+)/.exec(child.name);
    if (match && match[1]) nodeIds[match[1]] = child.id;
  }

  rememberDrawnEdges(frame);
  frame.setPluginData(
    SEQUENCE_MARKER,
    JSON.stringify({
      kind: "sequence",
      title: d.title,
      participants: Object.keys(nodeIds),
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
    participants: nodeIds,
    box: { x: frame.x, y: frame.y, w: frame.width, h: frame.height },
  };
}


function sub(ctx: HandlerContext, params: Spec): HandlerContext {
  return { params, warnings: ctx.warnings, progress: ctx.progress, warn: ctx.warn };
}

function headerSpecs(d: SequenceDraw, FONT: string): Spec[] {
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

/** The dashed line each participant hangs on: its existence over time. */
function lifelineSpecs(parties: DrawParticipant[]): Spec[] {
  return parties.map((p) => ({
    type: "VECTOR",
    name: `life ${p.id}`,
    points: [
      [p.lifeline.x, p.lifeline.y],
      [p.lifeline.x, p.lifeline.y + p.lifeline.h],
    ],
    strokes: LIFELINE,
    strokeWeight: 1,
    strokeCap: "NONE",
    dashPattern: [4, 4],
    fills: [],
  }));
}

function participantSpecs(parties: DrawParticipant[], FONT: string): Spec[] {
  return parties.map((p) => {
    const inner: Spec[] = [
      {
        type: "TEXT",
        name: "name",
        characters: p.title,
        fontSize: 13,
        fontFamily: FONT,
        fontStyle: "Semi Bold",
        fill: p.fill === INK ? "#ffffff" : INK,
        textAlignHorizontal: "CENTER",
        width: p.at.w - 20,
        textAutoResize: "HEIGHT",
      },
    ];
    if (p.detail) {
      inner.push({
        type: "TEXT",
        name: "detail",
        characters: p.detail,
        fontSize: 11,
        fontFamily: FONT,
        fontStyle: "Regular",
        fill: p.fill === INK ? "#c9ced6" : MUTED,
        textAlignHorizontal: "CENTER",
        width: p.at.w - 20,
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
      strokeWeight: 1.5,
      strokeAlign: "OUTSIDE",
      cornerRadius: 10,
      clipsContent: false,
      ...(p.dashed ? { dashPattern: [6, 4] } : {}),
      layoutMode: "VERTICAL",
      primaryAxisSizingMode: "FIXED",
      counterAxisSizingMode: "FIXED",
      primaryAxisAlignItems: "CENTER",
      counterAxisAlignItems: "CENTER",
      itemSpacing: 2,
      paddingLeft: 10,
      paddingRight: 10,
      children: inner,
    };
  });
}

/** The bar that says a participant is busy handling a call. */
function activationSpecs(bars: DrawActivation[]): Spec[] {
  return bars.map((b) => ({
    type: "RECTANGLE",
    name: `bar ${b.id}`,
    x: b.at.x,
    y: b.at.y,
    width: b.at.w,
    height: b.at.h,
    fill: BAR_FILL,
    strokes: BAR_STROKE,
    strokeWeight: 1,
    cornerRadius: 2,
  }));
}

function messageSpecs(messages: DrawMessage[]): Spec[] {
  const out: Spec[] = [];
  for (const m of messages) {
    if (m.points.length < 2) continue;
    out.push({
      type: "VECTOR",
      name: `edge ${m.id}`,
      points: m.points,
      // A call gets the filled head, a reply or an async the open one.
      endArrow: m.cap === "filled" ? true : "line",
      strokes: m.color,
      strokeWeight: 1.5,
      strokeJoin: "ROUND",
      cornerRadius: 4,
      fills: [],
      ...(m.dashed ? { dashPattern: [6, 4] } : {}),
    });
  }
  return out;
}

/** The block outline and its else divider: background for the messages. */
function fragmentBoxSpecs(fragments: DrawFragment[]): Spec[] {
  const out: Spec[] = [];
  for (const f of fragments) {
    out.push({
      type: "FRAME",
      name: `frag ${f.id}`,
      x: f.at.x,
      y: f.at.y,
      width: f.at.w,
      height: f.at.h,
      fills: [],
      strokes: FRAG_STROKE,
      strokeWeight: 1,
      cornerRadius: 6,
      clipsContent: false,
    });
    if (f.divider) {
      out.push({
        type: "VECTOR",
        name: `frag-else ${f.id}`,
        points: [
          [f.at.x, f.divider.y],
          [f.at.x + f.at.w, f.divider.y],
        ],
        strokes: FRAG_STROKE,
        strokeWeight: 1,
        strokeCap: "NONE",
        dashPattern: [5, 4],
        fills: [],
      });
    }
  }
  return out;
}

/** The corner tab and the else caption — opaque, and drawn over the lifelines. */
function fragmentLabelSpecs(fragments: DrawFragment[], FONT: string): Spec[] {
  const out: Spec[] = [];
  for (const f of fragments) {
    out.push({
      type: "FRAME",
      name: `frag-tab ${f.id}`,
      x: f.at.x,
      y: f.at.y,
      width: f.tabW,
      height: f.tabH,
      fill: FRAG_TAB,
      strokes: FRAG_STROKE,
      strokeWeight: 1,
      cornerRadius: 6,
      clipsContent: false,
      children: [
        {
          type: "TEXT",
          name: "t",
          x: 8,
          y: 3,
          width: f.tabW - 16,
          characters: `${f.kind} · ${f.label}`,
          fontSize: 10,
          fontFamily: FONT,
          fontStyle: "Semi Bold",
          fill: INK,
          textAutoResize: "HEIGHT",
        },
      ],
    });
    if (f.divider) {
      const text = `[${f.divider.label}]`;
      out.push({
        type: "FRAME",
        name: `frag-else-label ${f.id}`,
        x: f.at.x + 10,
        y: f.divider.y - 8,
        width: Math.min(f.at.w - 20, 220),
        height: 18,
        fill: "#ffffff",
        strokes: [],
        cornerRadius: 4,
        clipsContent: false,
        children: [
          {
            type: "TEXT",
            name: "t",
            x: 4,
            y: 2,
            width: Math.min(f.at.w - 28, 212),
            characters: text,
            fontSize: 10,
            fontFamily: FONT,
            fontStyle: "Medium",
            fill: MUTED,
            textAutoResize: "HEIGHT",
          },
        ],
      });
    }
  }
  return out;
}

function labelSpecs(messages: DrawMessage[], FONT: string): Spec[] {
  const out: Spec[] = [];
  for (const m of messages) {
    if (m.points.length < 2) continue;
    out.push({
      type: "TEXT",
      name: `label ${m.id}`,
      x: m.label.x,
      y: m.label.y,
      width: m.label.w,
      characters: m.label.text,
      fontSize: 11,
      fontFamily: FONT,
      fontStyle: m.label.muted ? "Regular" : "Medium",
      fill: m.label.muted ? MUTED : m.color,
      textAlignHorizontal: "CENTER",
      textAutoResize: "HEIGHT",
    });
    if (m.note) {
      out.push({
        type: "FRAME",
        name: `note ${m.id}`,
        x: m.note.x,
        y: m.note.y,
        width: m.note.w,
        height: m.note.h,
        fill: NOTE_FILL,
        strokes: NOTE_STROKE,
        strokeWeight: 1,
        cornerRadius: 4,
        clipsContent: false,
        children: [
          {
            type: "TEXT",
            name: "t",
            x: 8,
            y: 5,
            width: m.note.w - 16,
            characters: m.note.text,
            fontSize: 10,
            fontFamily: FONT,
            fontStyle: "Regular",
            fill: "#6b6320",
            textAutoResize: "HEIGHT",
          },
        ],
      });
    }
  }
  return out;
}
