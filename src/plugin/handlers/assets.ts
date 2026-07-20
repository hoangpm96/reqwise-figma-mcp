/// <reference types="@figma/plugin-typings" />
import { HandlerContext } from "../context.js";
import { resolveParent, insertInto } from "../insert.js";
import { serializeNode } from "../serialize.js";
import { hexToRgb } from "../color-util.js";
import { err } from "../errors.js";
import { ErrorCode } from "../../shared/protocol.js";
import { resolveGeometry, InsertAt, Inset } from "../layout-math.js";
import { parentSize } from "./create.js";

import { decodeBase64 } from "../base64.js";

/** Decode a base64 string to a Uint8Array (no Buffer/atob guarantee in the main-thread sandbox). */
export function base64ToBytes(b64: string): Uint8Array {
  return decodeBase64(b64);
}

/** Recolor every solid fill of a node subtree to `hex`. */
function recolorFills(node: SceneNode, hex: string): void {
  const rgb = hexToRgb(hex);
  const stack: SceneNode[] = [node];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if ("fills" in n) {
      const fills = (n as GeometryMixin).fills;
      if (Array.isArray(fills) && fills.length > 0) {
        (n as GeometryMixin).fills = fills.map((f) =>
          f.type === "SOLID" ? { ...f, color: rgb } : f,
        );
      }
    }
    if ("children" in n) stack.push(...(n as ChildrenMixin).children);
  }
}

/**
 * load_icon: createNodeFromSvg → resize → recolor → position/insert.
 * params: { svg, name?, size?, color?, parentId?, x?, y?, inset? }.
 */
export async function loadIcon(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const svg = typeof p.svg === "string" ? p.svg : "";
  if (!svg) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      "load_icon requires an svg string.",
      "Fetch the SVG markup (server-side searchIcons) and pass it as { svg }.",
    );
  }
  const node = figma.createNodeFromSvg(svg);
  node.name = typeof p.name === "string" ? p.name : "icon";
  const size = typeof p.size === "number" ? p.size : 24;
  node.resize(size, size);
  if (typeof p.color === "string") recolorFills(node, p.color);

  const parent = await resolveParent(p.parentId);
  insertInto(parent, node, p.insertAt as InsertAt | undefined);
  positionInParent(node, p, parent);

  return { id: node.id, node: serializeNode(node, "compact") };
}

/**
 * load_image: figma.createImage(bytes) → paint onto a rectangle/frame fill.
 * params: { base64, name?, w?, h?, parentId?, x?, y?, inset?, scaleMode? }.
 */
export async function loadImage(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const b64 =
    typeof p.base64 === "string"
      ? p.base64
      : typeof p.bytes === "string"
        ? p.bytes
        : typeof p.source === "string"
          ? p.source
          : "";
  if (!b64) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      "load_image requires image bytes as base64.",
      "Read the image server-side and pass { base64 }.",
    );
  }
  const image = figma.createImage(base64ToBytes(b64));
  const { width, height } = await image.getSizeAsync();

  const rect = figma.createRectangle();
  rect.name = typeof p.name === "string" ? p.name : "image";
  const w = typeof p.w === "number" ? p.w : width;
  const h = typeof p.h === "number" ? p.h : height;
  rect.resize(Math.max(1, w), Math.max(1, h));
  const scaleMode = (typeof p.scaleMode === "string" ? p.scaleMode : "FILL") as
    | "FILL"
    | "FIT"
    | "CROP"
    | "TILE";
  rect.fills = [{ type: "IMAGE", scaleMode, imageHash: image.hash }];

  const parent = await resolveParent(p.parentId);
  insertInto(parent, rect, p.insertAt as InsertAt | undefined);
  positionInParent(rect, p, parent);

  return {
    id: rect.id,
    imageSize: { w: width, h: height },
    node: serializeNode(rect, "compact"),
  };
}

function positionInParent(
  node: SceneNode,
  p: Record<string, unknown>,
  parent: BaseNode,
): void {
  const managed =
    "layoutMode" in parent && (parent as FrameNode).layoutMode !== "NONE";
  if (managed) return;
  const pb = parentSize(parent);
  if (p.inset && pb) {
    const box = resolveGeometry(
      {
        w: node.width,
        h: node.height,
        inset: p.inset as Inset,
        align: p.align as "center-x" | "center-y" | "center" | undefined,
      },
      pb,
    );
    node.x = box.x;
    node.y = box.y;
    return;
  }
  if (typeof p.x === "number") node.x = p.x;
  if (typeof p.y === "number") node.y = p.y;
}

/**
 * create_page: try figma.createPage(); on plan-limit failure return a
 * fallback descriptor instead of throwing mid-flow.
 */
export async function createPage(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  try {
    const page = figma.createPage();
    if (typeof p.name === "string") page.name = p.name;
    return { id: page.id, name: page.name, created: true };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    ctx.warn(
      `PAGE_LIMIT: could not create a new page (${reason}); using the current page.`,
    );
    return {
      created: false,
      fallback: "current-page",
      reason,
      id: figma.currentPage.id,
      name: figma.currentPage.name,
    };
  }
}

/** Switch the visible Figma page by id or exact name. */
export async function setCurrentPage(ctx: HandlerContext): Promise<unknown> {
  const pageId = typeof ctx.params.pageId === "string" ? ctx.params.pageId.trim() : "";
  const pageName = typeof ctx.params.name === "string" ? ctx.params.name.trim() : "";
  await figma.loadAllPagesAsync?.();
  let page: PageNode | null = null;
  if (pageId) {
    const node = await figma.getNodeByIdAsync(pageId);
    if (node?.type === "PAGE") page = node;
  } else if (pageName) {
    const matches = figma.root.children.filter((candidate) => candidate.name.toLowerCase() === pageName.toLowerCase());
    if (matches.length === 1) page = matches[0]!;
    if (matches.length > 1) {
      throw err(
        ErrorCode.INVALID_PARAMS,
        `Multiple pages are named "${pageName}".`,
        "Call get_document_info and pass the exact pageId instead.",
      );
    }
  }
  if (!page) {
    throw err(
      ErrorCode.NODE_NOT_FOUND,
      `Page ${pageId || JSON.stringify(pageName)} was not found.`,
      "Call get_document_info to list page ids and names.",
    );
  }
  figma.currentPage = page;
  return { id: page.id, name: page.name, current: true };
}

/**
 * create_overlay: a RECTANGLE (never a FRAME) sized to the parent's bounds,
 * with color + opacity, inserted at top by default.
 */
export async function createOverlay(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const parent = await resolveParent(p.parentId);
  const pb = parentSize(parent);
  const rect = figma.createRectangle();
  rect.name = typeof p.name === "string" ? p.name : "Overlay";
  if (pb) rect.resize(Math.max(1, pb.w), Math.max(1, pb.h));
  const color = typeof p.color === "string" ? p.color : "#000000";
  const opacity = typeof p.opacity === "number" ? p.opacity : 0.5;
  rect.fills = [{ type: "SOLID", color: hexToRgb(color) }];
  rect.opacity = opacity;

  const insertAt = (p.insertAt as InsertAt | undefined) ?? "top";
  insertInto(parent, rect, insertAt);
  const managed =
    "layoutMode" in parent && (parent as FrameNode).layoutMode !== "NONE";
  if (!managed) {
    rect.x = 0;
    rect.y = 0;
  }
  return { id: rect.id, node: serializeNode(rect, "compact") };
}
