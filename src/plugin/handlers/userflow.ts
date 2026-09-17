/// <reference types="@figma/plugin-typings" />
/**
 * Draw a laid-out userflow. Every coordinate arrives already
 * computed by src/shared/userflow (dagre + orthogonal routing on the server),
 * so this handler is deliberately dumb: it turns draw data into nodes, tags
 * the frame so later screen work can find it, and optionally wires each screen
 * box to its artboard.
 */
import { HandlerContext } from "../context.js";
import { createTree } from "./create.js";
import { rememberDrawnEdges, pageModel, openDiagramFrame, preloadDiagramFonts } from "../diagram-apply.js";
import { err } from "../errors.js";
import { normalizeReactions } from "../edit-util.js";
import { ErrorCode } from "../../shared/protocol.js";
import { FLOW_MARKER, nameMatchesScreenId } from "../flow-mark.js";
import type { DrawBox, DrawData, DrawDiamond, DrawEdge } from "../../shared/userflow/types.js";

const INK = "#000f22";
const MUTED = "#5b6675";
// The reference line sits on green/amber/red box fills as well as white, so it
// has to clear 4.5:1 against the darkest of them — #7a8594 measured 3.02:1 on
// the happy-path green (caught by our own layout_audit).
const SLUG = "#4b5563";
const DETAIL = "#33404f";
const CHUNK = 60;

type Spec = Record<string, unknown>;

export async function createUserflow(ctx: HandlerContext): Promise<unknown> {
  const d = ctx.params as unknown as DrawData;
  const font = typeof d?.font === "string" && d.font ? d.font : "Inter";
  if (!d || typeof d !== "object" || !Array.isArray(d.boxes) || !Array.isArray(d.edges)) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      "create_userflow expects laid-out draw data (boxes/diamonds/edges).",
      "Call it through figma.userflow(spec) / figma_diagram type:\"userflow\" — the server computes the layout.",
    );
  }

  const frameSpec: Spec = {
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
  };
  // Painting order = z-order: arrows first, boxes over them, labels on top.
  //
  // Built BEFORE the frame is opened. Redrawing in place (intoFrameId) empties
  // the frame as it opens it, so a malformed piece of draw data that threw
  // here used to leave the user's diagram wiped with nothing drawn back.
  // Anything wrong with the data now fails while the canvas is untouched.
  let children: Spec[];
  try {
    children = [
      headerSpecs(d, font),
      edgeSpecs(d.edges),
      nodeSpecs(d, font),
      labelSpecs(d.edges, font),
    ].reduce<Spec[]>((all, part) => all.concat(part), []);
  } catch (e) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      `create_userflow got malformed draw data (${e instanceof Error ? e.message : String(e)}) — nothing was changed.`,
      "Call it through figma.userflow(spec) / figma_diagram type:\"userflow\" — the server computes the layout.",
    );
  }

  await preloadDiagramFonts(ctx, font);

  const frame = await openDiagramFrame(ctx, frameSpec, d.intoFrameId);

  let done = 0;
  for (const spec of children) {
    await createTree(sub(ctx, { ...spec, parentId: frame.id }), frame);
    done++;
    if (done % CHUNK === 0) ctx.progress(done, children.length, "drawing userflow");
  }

  const nodeIds: Record<string, string> = {};
  const drawn = new Map<string, SceneNode>();
  for (const child of frame.children) {
    // Layer name is `flow:<id> · <screenId · slug>` — the id is the first token.
    const match = /^flow:([^\s]+)/.exec(child.name);
    if (match && match[1]) {
      nodeIds[match[1]] = child.id;
      drawn.set(match[1], child);
    }
  }

  const screens: Record<string, string> = {};
  for (const b of d.boxes) if (b.screenId) screens[b.id] = b.screenId;
  // The graph rides along on the frame so a later drag can be answered by
  // re-routing the arrows instead of redrawing the flow. Without it the frame
  // is still a valid userflow — it just cannot follow its boxes.
  rememberDrawnEdges(frame);
  frame.setPluginData(
    FLOW_MARKER,
    JSON.stringify({
      // Every other kind writes this, and `get_diagram_spec` / redraw-in-place
      // both key off it — without it a userflow frame reads as "not drawn by a
      // diagram tool" and refuses to be edited.
      kind: "userflow",
      title: d.title,
      nodes: Object.keys(nodeIds),
      screens,
      // The MODEL, so the next change can be a patch instead of the whole
      // spec again. `graph` is the ROUTING — where the layout put things —
      // and cannot be edited back into a diagram; this can.
      ...(d.source !== undefined ? { source: d.source } : {}),
      ...(d.graph ? { graph: d.graph } : {}),
    }),
  );

  // The userflow is on the canvas by now. Linking is a bonus pass over other
  // people's artboards, so a failure there must not throw away the result the
  // caller needs (the frame id and the id map) — report and carry on.
  const linked: Record<string, string> = {};
  if (d.linkScreens) {
    try {
      await linkScreens(d, drawn, linked, ctx);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Figma's prototype API needs its backend; when that is unreachable
      // setReactionsAsync hangs for 10s and fails while every other write
      // still runs in milliseconds. Saying so stops the caller from hunting
      // for a bug in their artboard names.
      const figmaSide = /unable to establish connection|internet connection/i.test(msg);
      ctx.warn(
        figmaSide
          ? `The userflow was drawn, but linkScreens could not write the prototype links — Figma's own prototype API did not respond ("${msg}"). That is a Figma-side failure, not your graph: ordinary writes still work. Re-run with linkScreens later.`
          : `The userflow was drawn, but linkScreens failed: ${msg}. Re-run with linkScreens after checking the artboard names.`,
      );
    }
  }

  return {
    frameId: frame.id,
    pageModel: pageModel(frame),
    name: frame.name,
    nodes: nodeIds,
    box: { x: frame.x, y: frame.y, w: frame.width, h: frame.height },
    ...(d.linkScreens ? { linkedScreens: linked } : {}),
  };
}


function sub(ctx: HandlerContext, params: Spec): HandlerContext {
  return { params, warnings: ctx.warnings, progress: ctx.progress, warn: ctx.warn };
}

function headerSpecs(d: DrawData, FONT: string): Spec[] {
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

function nodeSpecs(d: DrawData, FONT: string): Spec[] {
  const out: Spec[] = [];
  for (const b of d.boxes) out.push(boxSpec(b, FONT));
  for (const m of d.diamonds) {
    out.push({
      type: "POLYGON",
      name: `flow:${m.id}`,
      pointCount: 4,
      x: m.x,
      y: m.y,
      width: m.w,
      height: m.h,
      fill: m.fill,
      strokes: m.stroke,
      strokeWeight: 1.5,
    });
    out.push(diamondText(m, FONT));
  }
  return out;
}

function boxSpec(b: DrawBox, FONT: string): Spec {
  const inner: Spec[] = [];
  let y = 12;
  const titleLines = b.title.split("\n").length;
  inner.push({
    type: "TEXT",
    name: "title",
    x: 16,
    y,
    width: b.w - 32,
    characters: b.title,
    fontSize: 13,
    fontFamily: FONT,
    fontStyle: "Semi Bold",
    fill: INK,
    textAutoResize: "HEIGHT",
  });
  y += titleLines * 18;
  if (b.ref) {
    inner.push({
      type: "TEXT",
      name: "ref",
      x: 16,
      y,
      width: b.w - 32,
      characters: b.ref,
      fontSize: 11,
      fontFamily: FONT,
      fontStyle: "Medium",
      fill: SLUG,
      textAutoResize: "HEIGHT",
    });
    y += 15;
  }
  if (b.detail) {
    inner.push({
      type: "TEXT",
      name: "detail",
      x: 16,
      y: y + 4,
      width: b.w - 32,
      characters: b.detail,
      fontSize: 12,
      fontFamily: FONT,
      fontStyle: "Regular",
      fill: DETAIL,
      textAutoResize: "HEIGHT",
    });
  }
  return {
    type: "FRAME",
    name: `flow:${b.id}`,
    x: b.x,
    y: b.y,
    width: b.w,
    height: b.h,
    fill: b.fill,
    strokes: b.stroke,
    strokeWeight: 1.5,
    cornerRadius: 10,
    clipsContent: false,
    children: inner,
  };
}

function diamondText(m: DrawDiamond, FONT: string): Spec {
  return {
    type: "TEXT",
    name: `q ${m.id}`,
    x: m.x + m.w / 2 - m.textW / 2,
    y: m.y + m.h / 2 - m.textH / 2,
    width: m.textW,
    characters: m.text,
    fontSize: 11,
    fontFamily: FONT,
    fontStyle: "Medium",
    fill: INK,
    textAlignHorizontal: "CENTER",
    textAutoResize: "HEIGHT",
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

/**
 * Wire each screen box to the artboard that carries its screenId, so a reader
 * can click through from the flow to the design. A screenId with no artboard
 * is REPORTED, never guessed at — a wrong link is worse than no link.
 */
async function linkScreens(
  d: DrawData,
  drawn: Map<string, SceneNode>,
  linked: Record<string, string>,
  ctx: HandlerContext,
): Promise<void> {
  const page = figma.currentPage;
  const candidates: SceneNode[] = [];
  for (const child of page.children) {
    if (child.type === "SECTION") {
      for (const inner of child.children) candidates.push(inner as SceneNode);
      continue;
    }
    candidates.push(child);
  }

  const missing: string[] = [];
  for (const b of d.boxes) {
    if (!b.screenId) continue;
    const boxNode = drawn.get(b.id);
    if (!boxNode) continue;
    const hit = candidates.filter(
      (c) => nameMatchesScreenId(c.name, b.screenId!) && c.id !== boxNode.id,
    );
    if (hit.length === 0) {
      missing.push(b.screenId);
      continue;
    }
    const target = boxNode as SceneNode & {
      setReactionsAsync?: (reactions: unknown) => Promise<void>;
      reactions?: unknown;
    };
    // Build the reaction through the same normalizer set_reactions uses. A
    // hand-rolled shape looked identical and was rejected by the Plugin API,
    // which cost a whole live run to find.
    const reactions = normalizeReactions([
      {
        trigger: { type: "ON_CLICK" },
        action: { type: "NODE", destinationId: hit[0]!.id, navigation: "NAVIGATE" },
      },
    ]);
    if (typeof target.setReactionsAsync === "function") {
      await target.setReactionsAsync(reactions);
    } else {
      target.reactions = reactions;
    }
    linked[b.screenId] = hit[0]!.id;
    if (hit.length > 1) {
      ctx.warn(
        `screenId "${b.screenId}" matches ${hit.length} artboards — linked the first ("${hit[0]!.name}"). Make the artboard names unique.`,
      );
    }
  }
  if (missing.length) {
    ctx.warn(
      `linkScreens found no artboard for ${missing.slice(0, 8).map((m) => `"${m}"`).join(", ")}${missing.length > 8 ? ` and ${missing.length - 8} more` : ""} — those boxes stayed unlinked. Name the artboard so it contains the screenId, then re-run with linkScreens.`,
    );
  }
}
