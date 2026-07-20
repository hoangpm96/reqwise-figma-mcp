/// <reference types="@figma/plugin-typings" />
import { HandlerContext } from "../context.js";
import { serializeNode } from "../serialize.js";
import { loadNodeFonts } from "../fonts.js";
import { err } from "../errors.js";
import { ErrorCode } from "../../shared/protocol.js";
import {
  buildOverrideSummary,
  flattenComponentProperties,
  OverrideSummary,
} from "../edit-util.js";

/**
 * Resolve an INSTANCE node from an explicit id, or fall back to the single
 * selected instance. Throws INVALID_PARAMS with a hint when the target is not
 * an instance (this is the classic mistake — running the format-painter on a
 * frame/group instead of a component instance).
 */
async function requireInstance(
  nodeId: unknown,
  opName: string,
): Promise<InstanceNode> {
  let node: BaseNode | null = null;
  if (typeof nodeId === "string" && nodeId.length > 0) {
    node = await figma.getNodeByIdAsync(nodeId);
    if (!node) {
      throw err(
        ErrorCode.NODE_NOT_FOUND,
        `No node with id "${nodeId}".`,
        "Call read_selection or get_selection to obtain a current instance id.",
      );
    }
  } else {
    const sel = figma.currentPage.selection.filter(
      (n) => n.type === "INSTANCE",
    );
    if (sel.length === 0) {
      throw err(
        ErrorCode.INVALID_PARAMS,
        `${opName} needs an instance: pass nodeId or select exactly one component instance.`,
        "Select a single INSTANCE node in Figma, or pass its id as nodeId.",
      );
    }
    if (sel.length > 1) {
      throw err(
        ErrorCode.INVALID_PARAMS,
        `${opName} found ${sel.length} selected instances; expected exactly one.`,
        "Select a single INSTANCE node, or pass its id as nodeId.",
      );
    }
    node = sel[0]!;
  }
  if (node.type !== "INSTANCE") {
    throw err(
      ErrorCode.INVALID_PARAMS,
      `${opName} target must be an INSTANCE (got ${node.type}).`,
      "This op reads/applies component overrides — pick a component instance, not a frame/group.",
    );
  }
  return node as InstanceNode;
}

/** Extract a portable snapshot of everything a target would need to match. */
async function readOverrides(inst: InstanceNode): Promise<OverrideSummary> {
  const main = await inst.getMainComponentAsync();
  const overriddenNodeIds = (inst.overrides ?? []).map((o) => o.id);
  const componentProperties = flattenComponentProperties(
    inst.componentProperties as Record<
      string,
      { type?: string; value?: unknown }
    >,
  );
  const exposedInstanceIds = (inst.exposedInstances ?? []).map((e) => e.id);
  return buildOverrideSummary({
    sourceInstanceId: inst.id,
    mainComponentId: main ? main.id : null,
    overriddenNodeIds,
    componentProperties,
    exposedInstanceIds,
  });
}

/**
 * get_instance_overrides: read the override set from an instance (or the single
 * selected instance). Returns the portable summary + a raw overrides list.
 */
export async function getInstanceOverrides(
  ctx: HandlerContext,
): Promise<unknown> {
  const inst = await requireInstance(
    ctx.params.nodeId,
    "get_instance_overrides",
  );
  const summary = await readOverrides(inst);
  return {
    sourceInstanceId: summary.sourceInstanceId,
    mainComponentId: summary.mainComponentId,
    overrides: (inst.overrides ?? []).map((o) => ({
      id: o.id,
      overriddenFields: o.overriddenFields,
    })),
    componentProperties: summary.componentProperties,
    exposedInstances: summary.exposedInstanceIds,
    node: serializeNode(inst, "compact"),
  };
}

/**
 * Apply the "raw" per-node overrides (text / fills / visibility) from the
 * source instance onto a target instance by matching node names. Component
 * property values are applied separately via setProperties.
 *
 * This adapts cursor-talk-to-figma's get/setInstanceOverrides approach: rather
 * than replaying opaque override records (which reference source-local node ids
 * that don't exist in the target), we snapshot the *rendered* overridable
 * values from the source subtree and re-apply them by node name — the same
 * heuristic a designer's copy/paste-properties uses.
 */
async function applyRawOverrides(
  source: InstanceNode,
  target: InstanceNode,
  ctx: HandlerContext,
): Promise<void> {
  // Snapshot source overridable values keyed by name.
  interface Snap {
    text?: string;
    visible?: boolean;
    fills?: readonly Paint[];
  }
  const snap = new Map<string, Snap>();
  const sStack: SceneNode[] = [source];
  while (sStack.length > 0) {
    const n = sStack.pop()!;
    const entry: Snap = {};
    if (n.type === "TEXT" && n.characters !== undefined) {
      entry.text = n.characters;
    }
    entry.visible = n.visible;
    if ("fills" in n) {
      const f = (n as GeometryMixin).fills;
      if (f !== figma.mixed && Array.isArray(f)) entry.fills = f;
    }
    // Last-writer-wins on name collisions is fine for this heuristic.
    snap.set(n.name, entry);
    if ("children" in n) sStack.push(...(n as ChildrenMixin).children);
  }

  const tStack: SceneNode[] = [target];
  while (tStack.length > 0) {
    const n = tStack.pop()!;
    const s = snap.get(n.name);
    if (s) {
      if (typeof s.visible === "boolean") n.visible = s.visible;
      if (s.text !== undefined && n.type === "TEXT") {
        try {
          await loadNodeFonts(n as TextNode);
          (n as TextNode).characters = s.text;
        } catch (e) {
          ctx.warn(
            `Could not set text on "${n.name}": ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      if (s.fills !== undefined && "fills" in n) {
        try {
          (n as GeometryMixin).fills = s.fills as Paint[];
        } catch {
          /* incompatible node; skip */
        }
      }
    }
    if ("children" in n) tStack.push(...(n as ChildrenMixin).children);
  }
}

/**
 * set_instance_overrides: the "format painter for components". Applies the
 * source instance's overrides to each target instance:
 *   1. swap the target's main component to match the source (if different),
 *      via swapComponent to preserve overrides;
 *   2. apply component property values via setProperties (skipping props that
 *      throw, e.g. incompatible INSTANCE_SWAP);
 *   3. re-apply raw text/fill/visibility overrides by node name.
 * Per-target try/catch; returns {applied: [{id, ok, error?}], sourceId}.
 */
export async function setInstanceOverrides(
  ctx: HandlerContext,
): Promise<unknown> {
  const p = ctx.params;
  const sourceId = String(p.sourceId ?? p.sourceInstanceId ?? "");
  const source = await requireInstance(sourceId, "set_instance_overrides");

  const rawTargets = p.targetIds ?? p.targets;
  if (!Array.isArray(rawTargets) || rawTargets.length === 0) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      "set_instance_overrides requires a non-empty targetIds[] array.",
      "Pass the ids of the instance(s) to paint the source overrides onto.",
    );
  }

  const sourceMain = await source.getMainComponentAsync();
  const sourceProps = flattenComponentProperties(
    source.componentProperties as Record<
      string,
      { type?: string; value?: unknown }
    >,
  );

  const applied: Array<{
    id: string;
    ok: boolean;
    swapped?: boolean;
    error?: string;
  }> = [];

  for (const rawId of rawTargets) {
    const id = String(rawId);
    if (id === source.id) {
      applied.push({ id, ok: false, error: "target equals source; skipped." });
      continue;
    }
    try {
      const t = await figma.getNodeByIdAsync(id);
      if (!t || t.type !== "INSTANCE") {
        applied.push({
          id,
          ok: false,
          error: t ? `not an INSTANCE (${t.type})` : "node not found",
        });
        continue;
      }
      const target = t as InstanceNode;
      let swapped = false;

      // 1. Swap main component to match the source (preserving overrides).
      const targetMain = await target.getMainComponentAsync();
      if (sourceMain && targetMain && sourceMain.id !== targetMain.id) {
        try {
          target.swapComponent(sourceMain);
          swapped = true;
        } catch (e) {
          ctx.warn(
            `swapComponent failed on ${id}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      // 2. Apply component property values (skip ones that throw).
      applyProps(target, sourceProps, ctx);

      // 3. Re-apply raw text/fill/visibility overrides by name.
      await applyRawOverrides(source, target, ctx);

      applied.push({ id, ok: true, swapped });
    } catch (e) {
      applied.push({
        id,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return {
    sourceId: source.id,
    applied,
    okCount: applied.filter((a) => a.ok).length,
    failCount: applied.filter((a) => !a.ok).length,
  };
}

/** Apply component property values one at a time so a bad prop can't fail all. */
function applyProps(
  target: InstanceNode,
  props: Record<string, unknown>,
  ctx: HandlerContext,
): void {
  for (const [name, value] of Object.entries(props)) {
    if (typeof value !== "string" && typeof value !== "boolean") continue;
    try {
      target.setProperties({ [name]: value });
    } catch (e) {
      ctx.warn(
        `Property "${name}" skipped on ${target.id}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

/** nodeIds[] (or single nodeId) → list of ids, for the batch-style ops. */
function idListParam(p: Record<string, unknown>): string[] {
  if (Array.isArray(p.nodeIds)) return (p.nodeIds as unknown[]).map(String);
  const single = p.nodeId ?? p.id;
  return typeof single === "string" && single.length > 0 ? [single] : [];
}

/**
 * detach_instance: detach one or more INSTANCE nodes into plain frames
 * (children, overrides and layout are kept; the component link is cut).
 * Per-target try/catch — one bad id never fails the batch.
 */
export async function detachInstance(ctx: HandlerContext): Promise<unknown> {
  const ids = idListParam(ctx.params);
  if (ids.length === 0) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      "detach_instance requires nodeId or nodeIds.",
      "Pass the INSTANCE id(s) to detach, e.g. from get_selection.",
    );
  }
  const results: Array<{
    id: string;
    ok: boolean;
    detachedId?: string;
    name?: string;
    error?: string;
  }> = [];
  for (const id of ids) {
    const node = await figma.getNodeByIdAsync(id);
    if (!node || node.type !== "INSTANCE") {
      results.push({
        id,
        ok: false,
        error: node ? `is ${node.type}, not INSTANCE` : "not found",
      });
      continue;
    }
    try {
      const frame = (node as InstanceNode).detachInstance();
      results.push({ id, ok: true, detachedId: frame.id, name: frame.name });
    } catch (e) {
      results.push({
        id,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  const okCount = results.filter((r) => r.ok).length;
  return { detached: okCount, failCount: results.length - okCount, results };
}

/**
 * reset_instance_overrides: reset one or more INSTANCE nodes back to their
 * main component (drops all overrides). Per-target try/catch.
 */
export async function resetInstanceOverrides(
  ctx: HandlerContext,
): Promise<unknown> {
  const ids = idListParam(ctx.params);
  if (ids.length === 0) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      "reset_instance_overrides requires nodeId or nodeIds.",
      "Pass the INSTANCE id(s) to reset, e.g. from get_selection.",
    );
  }
  const results: Array<{ id: string; ok: boolean; error?: string }> = [];
  for (const id of ids) {
    const node = await figma.getNodeByIdAsync(id);
    if (!node || node.type !== "INSTANCE") {
      results.push({
        id,
        ok: false,
        error: node ? `is ${node.type}, not INSTANCE` : "not found",
      });
      continue;
    }
    try {
      (node as InstanceNode).resetOverrides();
      results.push({ id, ok: true });
    } catch (e) {
      results.push({
        id,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  const okCount = results.filter((r) => r.ok).length;
  return { reset: okCount, failCount: results.length - okCount, results };
}
