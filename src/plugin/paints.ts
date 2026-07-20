/// <reference types="@figma/plugin-typings" />
/**
 * Figma-typed facade over paints-core.ts. All parsing logic (and its tests)
 * lives in paints-core.ts, which is figma-global-free; this file only casts
 * the structurally-identical outputs to the real Figma types and keeps the
 * one helper that genuinely needs a figma node type.
 */
import { toPaintCore, toPaintsCore, toEffectCore, toEffectsCore } from "./paints-core.js";
import { HandlerError } from "./errors.js";
import { ErrorCode } from "../shared/protocol.js";

export function toPaint(spec: unknown): Paint {
  return toPaintCore(spec) as unknown as Paint;
}

export function toPaints(spec: unknown): Paint[] {
  return toPaintsCore(spec) as unknown as Paint[];
}

export function toEffect(spec: unknown): Effect {
  return toEffectCore(spec) as unknown as Effect;
}

export function toEffects(spec: unknown): Effect[] {
  return toEffectsCore(spec) as unknown as Effect[];
}

export function assertHasFills(node: BaseNode): asserts node is BaseNode & GeometryMixin {
  if (!("fills" in node)) {
    throw new HandlerError(
      ErrorCode.INVALID_PARAMS,
      `Node type ${node.type} has no fills.`,
    );
  }
}
