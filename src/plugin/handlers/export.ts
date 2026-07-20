/// <reference types="@figma/plugin-typings" />
import { HandlerContext, requireNode } from "../context.js";
import { err } from "../errors.js";
import { ErrorCode } from "../../shared/protocol.js";

import { encodeBase64 } from "../base64.js";

/** Encode a byte array to base64 (no Buffer/btoa guarantee in the main-thread sandbox). */
export function bytesToBase64(bytes: Uint8Array): string {
  return encodeBase64(bytes);
}

/** screenshot: PNG of a node (or current page selection/root) at `scale`. */
export async function screenshot(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const scale = typeof p.scale === "number" ? p.scale : 0.6;
  let node: SceneNode | PageNode;
  if (typeof p.nodeId === "string") {
    node = await requireNode(p.nodeId);
  } else if (figma.currentPage.selection.length === 1) {
    node = figma.currentPage.selection[0]!;
  } else {
    node = figma.currentPage;
  }
  const bytes = await (node as ExportMixin).exportAsync({
    format: "PNG",
    constraint: { type: "SCALE", value: scale },
  });
  return {
    format: "PNG",
    scale,
    nodeId: node.id,
    base64: bytesToBase64(bytes),
  };
}

/** export_node: PNG/SVG/JPG/PDF export of a node → base64. */
export async function exportNode(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const node = await requireNode(p.nodeId ?? p.id);
  const fmt = String(p.format ?? "PNG").toUpperCase();
  const scale = typeof p.scale === "number" ? p.scale : 1;

  let settings: ExportSettings;
  switch (fmt) {
    case "PNG":
      settings = { format: "PNG", constraint: { type: "SCALE", value: scale } };
      break;
    case "JPG":
    case "JPEG":
      settings = { format: "JPG", constraint: { type: "SCALE", value: scale } };
      break;
    case "SVG":
      settings = { format: "SVG" };
      break;
    case "PDF":
      settings = { format: "PDF" };
      break;
    default:
      throw err(
        ErrorCode.INVALID_PARAMS,
        `Unsupported export format "${fmt}".`,
        "Use PNG, JPG, SVG or PDF.",
      );
  }
  const bytes = await (node as ExportMixin).exportAsync(settings);
  return {
    format: fmt === "JPEG" ? "JPG" : fmt,
    nodeId: node.id,
    base64: bytesToBase64(bytes),
  };
}
