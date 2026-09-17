/// <reference types="@figma/plugin-typings" />
/**
 * `get_diagram_spec`: hand back the model a drawn diagram was made from.
 *
 * Without it the only way to change a drawing is to re-author the whole spec,
 * because the frame remembers its ROUTING graph but not what it was asked to
 * draw. With it, "the finding says this handoff has no label" becomes a patch.
 */
import { HandlerContext } from "../context.js";
import { readDiagramSource } from "../diagram-apply.js";
import { err } from "../errors.js";
import { ErrorCode } from "../../shared/protocol.js";

export async function getDiagramSpec(ctx: HandlerContext): Promise<unknown> {
  const id = String(ctx.params.nodeId ?? "");
  const node = await figma.getNodeByIdAsync(id);
  if (!node) {
    throw err(
      ErrorCode.NODE_NOT_FOUND,
      `Node "${id}" not found.`,
      "Pass the frameId a diagram tool returned.",
    );
  }
  const mark = readDiagramSource(node);
  if (!mark.kind) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      `"${node.name}" is not a frame drawn by a diagram tool.`,
      "Only frames drawn by figma_diagram carry their model. Pass the frameId it returned.",
    );
  }
  if (mark.source === undefined) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      `"${node.name}" was drawn before the model was stored on the frame.`,
      "Redraw it once with the current version (figma_diagram with the full spec) and the frame will carry its model from then on.",
    );
  }
  return { nodeId: node.id, kind: mark.kind, title: mark.title, spec: mark.source };
}
