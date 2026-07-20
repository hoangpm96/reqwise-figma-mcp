/// <reference types="@figma/plugin-typings" />
import { HandlerContext, requireNode } from "../context.js";
import { resolveParent, insertInto } from "../insert.js";
import { serializeNode } from "../serialize.js";
import { toPaints } from "../paints.js";
import { loadNodeFonts } from "../fonts.js";
import { err, nodeNotFound } from "../errors.js";
import { ErrorCode } from "../../shared/protocol.js";
import { rankCandidates, Candidate } from "../fuzzy.js";
import { structureSignatureAtDepth, StructNode } from "../structure-sig.js";
import { buildChildMap, MiniNode } from "../tree-walk.js";
import { InsertAt } from "../layout-math.js";
import { create } from "./create.js";

/** Convert a figma node subtree into the minimal shape for buildChildMap. */
function toMini(node: BaseNode): MiniNode {
  const mini: MiniNode = { id: node.id };
  if ("children" in node) {
    const kids = (node as ChildrenMixin).children;
    if (kids.length > 0) mini.children = kids.map(toMini);
  }
  return mini;
}

/** node.clone() with reparent/insertAt + original→clone id map. */
export async function clone(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const node = await requireNode(p.nodeId ?? p.id);
  const cloned = node.clone();

  if (p.parentId !== undefined) {
    const parent = await resolveParent(p.parentId);
    insertInto(parent, cloned, p.insertAt as InsertAt | undefined);
  } else if (node.parent && "insertChild" in node.parent) {
    insertInto(node.parent as BaseNode & ChildrenMixin, cloned, p.insertAt as InsertAt | undefined);
  }
  if (typeof p.name === "string") cloned.name = p.name;
  if (typeof p.x === "number" && "x" in cloned) (cloned as LayoutMixin).x = p.x;
  if (typeof p.y === "number" && "y" in cloned) (cloned as LayoutMixin).y = p.y;

  const childMap = buildChildMap(toMini(node), toMini(cloned));
  return { id: cloned.id, childMap, node: serializeNode(cloned, "compact") };
}

interface LocalComponentCandidate extends Candidate {
  actualName: string;
  type: "COMPONENT" | "COMPONENT_SET";
  defaultVariantId?: string;
  path?: string;
}

async function localComponents(): Promise<LocalComponentCandidate[]> {
  await figma.loadAllPagesAsync?.();
  const nodes = figma.root.findAllWithCriteria({ types: ["COMPONENT", "COMPONENT_SET"] });
  return nodes.map((node) => {
    const inSet = node.type === "COMPONENT" && node.parent?.type === "COMPONENT_SET";
    const searchName = inSet ? `${node.parent!.name}/${node.name}` : node.name;
    return {
      id: node.id,
      name: searchName,
      actualName: node.name,
      type: node.type as "COMPONENT" | "COMPONENT_SET",
      defaultVariantId: node.type === "COMPONENT_SET" ? node.defaultVariant?.id : undefined,
      path: componentPath(node),
    };
  });
}

export async function findComponent(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const query = String(p.query ?? p.name ?? "");
  if (!query) {
    throw err(ErrorCode.INVALID_PARAMS, "find_component requires a query/name.");
  }
  const cands = await localComponents();
  const ranked = rankCandidates(query, cands, Number(p.limit) || 10);
  return {
    query,
    candidates: ranked.map((r) => ({
      id: r.candidate.id,
      name: r.candidate.name,
      actualName: r.candidate.actualName,
      type: r.candidate.type,
      path: r.candidate.path,
      defaultVariantId: r.candidate.defaultVariantId,
      score: r.score,
      reason: r.reason,
    })),
    best: ranked.length > 0 ? ranked[0]!.candidate.id : null,
  };
}

function componentPath(node: BaseNode): string {
  const names: string[] = [];
  let current: BaseNode | null = node;
  while (current && current.type !== "DOCUMENT") {
    names.push(current.name);
    current = current.parent;
  }
  return names.reverse().join("/");
}

/** Default reuse threshold: exact or tight prefix match (see fuzzy tiers). */
const REUSE_THRESHOLD = 800;

export async function findOrCreateComponent(
  ctx: HandlerContext,
): Promise<unknown> {
  const p = ctx.params;
  const query = String(p.name ?? p.query ?? "").trim();
  if (!query) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      "find_or_create_component requires a name/query.",
    );
  }
  const threshold =
    typeof p.threshold === "number" && p.threshold > 0
      ? p.threshold
      : REUSE_THRESHOLD;
  const dryRun = p.dryRun === true;

  const cands = await localComponents();
  const ranked = rankCandidates(query, cands, 3);
  const best = ranked[0];

  if (best && best.score >= threshold) {
    const c = best.candidate;
    return {
      decision: "reuse",
      id: c.id,
      name: c.name,
      created: false,
      score: best.score,
      reason: best.reason,
      ...(dryRun ? { dryRun: true } : {}),
    };
  }

  const reason = best
    ? `best candidate "${best.candidate.name}" scored ${best.score} < ${threshold} (${best.reason})`
    : "no local component matches the name";

  if (dryRun) {
    return {
      decision: "create",
      created: false,
      dryRun: true,
      score: best?.score ?? 0,
      reason,
      candidates: ranked.map((r) => ({
        id: r.candidate.id,
        name: r.candidate.name,
        score: r.score,
        reason: r.reason,
      })),
    };
  }

  // Create a COMPONENT from spec.
  const spec = (p.spec as Record<string, unknown>) ?? {};
  const createCtx: HandlerContext = {
    ...ctx,
    params: { ...spec, type: "COMPONENT", name: query || spec.name },
  };
  const res = (await create(createCtx)) as { id: string };
  return {
    decision: "create",
    id: res.id,
    name: query,
    created: true,
    score: best?.score ?? 0,
    reason,
  };
}

/** Figma node ids look like "123:456" (instance sub-nodes: "I123:456;…"). */
function looksLikeNodeId(s: string): boolean {
  return /^I?\d+:\d+/.test(s);
}

/** Same tier as find_or_create_component: exact or tight prefix match. */
const INSTANTIATE_MATCH_THRESHOLD = 800;

interface ResolvedComponent {
  comp: ComponentNode;
  resolved: {
    via: "id" | "query";
    query?: string;
    score?: number;
    reason?: string;
    componentSetId?: string;
  };
}

/**
 * Resolve the component to instantiate. Order: componentId as a real id
 * (a COMPONENT_SET id resolves to its default variant) → `component`/`query`
 * fuzzy-matched against local components → a non-id-shaped componentId string
 * treated as a query. Below-threshold matches throw with ranked candidates so
 * the agent can pick or refine instead of guessing.
 */
async function resolveComponent(
  ctx: HandlerContext,
): Promise<ResolvedComponent> {
  const p = ctx.params;
  const idArg = typeof p.componentId === "string" ? p.componentId.trim() : "";
  const queryArg = String(p.component ?? p.query ?? "").trim();

  if (idArg) {
    const node = await figma.getNodeByIdAsync(idArg);
    if (node && node.type === "COMPONENT") {
      return { comp: node as ComponentNode, resolved: { via: "id" } };
    }
    if (node && node.type === "COMPONENT_SET") {
      const def = (node as ComponentSetNode).defaultVariant;
      ctx.warn(
        `componentId "${idArg}" is a COMPONENT_SET; instantiated its default variant "${def.name}". Pass a variant's own id or props to pick another.`,
      );
      return { comp: def, resolved: { via: "id" } };
    }
    if (looksLikeNodeId(idArg)) {
      throw err(
        ErrorCode.NODE_NOT_FOUND,
        `componentId "${idArg}" is not a COMPONENT.`,
        "Call find_component to resolve a component id first, or pass component/query to resolve by name.",
      );
    }
    // Not id-shaped ("Button/Primary") → fall through and treat as a query.
  }

  const query = queryArg || idArg;
  if (!query) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      "instantiate requires componentId, component, or query.",
      'Pass a component id, or a name query like { component: "Button/Primary" }.',
    );
  }
  const cands = await localComponents();
  const ranked = rankCandidates(query, cands, 5);
  const best = ranked[0];
  if (best && best.score >= INSTANTIATE_MATCH_THRESHOLD) {
    const node = await figma.getNodeByIdAsync(
      best.candidate.id,
    );
    if (!node || (node.type !== "COMPONENT" && node.type !== "COMPONENT_SET")) {
      throw nodeNotFound(best.candidate.id);
    }
    const comp = node.type === "COMPONENT_SET" ? node.defaultVariant : node;
    if (node.type === "COMPONENT_SET") {
      ctx.warn(`Query "${query}" resolved to COMPONENT_SET "${node.name}"; instantiated default variant "${comp.name}" before applying props.`);
    }
    return {
      comp,
      resolved: {
        via: "query",
        query,
        score: best.score,
        reason: best.reason,
        ...(node.type === "COMPONENT_SET" ? { componentSetId: node.id } : {}),
      },
    };
  }
  const listing = ranked
    .map((r) => `"${r.candidate.name}" (${r.candidate.id}, score ${r.score})`)
    .join(", ");
  throw err(
    ErrorCode.NODE_NOT_FOUND,
    ranked.length > 0
      ? `No component matches "${query}" confidently enough. Candidates: ${listing}.`
      : `No local component matches "${query}".`,
    ranked.length > 0
      ? "Pick a candidate and pass its id as componentId, or refine the query to the exact component name."
      : "Call find_component to browse candidates, or find_or_create_component to create it.",
  );
}

export async function instantiate(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const { comp, resolved } = await resolveComponent(ctx);
  const instance = comp.createInstance();
  if (p.parentId !== undefined) {
    const parent = await resolveParent(p.parentId);
    insertInto(parent, instance, p.insertAt as InsertAt | undefined);
  } else {
    figma.currentPage.appendChild(instance);
  }
  if (typeof p.x === "number") instance.x = p.x;
  if (typeof p.y === "number") instance.y = p.y;
  if (typeof p.name === "string") instance.name = p.name;

  const props = (p.props ?? p.properties) as Record<string, unknown> | undefined;
  if (props && typeof props === "object" && !Array.isArray(props)) {
    applyComponentProps(instance, props, ctx);
  }

  const overrides = (p.overrides as Record<string, unknown>) ?? {};
  const overridesApplied = await applyOverrides(instance, overrides, ctx);

  return {
    id: instance.id,
    resolved,
    ...(overridesApplied.length > 0 ? { overridesApplied } : {}),
    node: serializeNode(instance, "compact"),
  };
}

function applyComponentProps(
  instance: InstanceNode,
  props: Record<string, unknown>,
  ctx: HandlerContext,
): void {
  const available = instance.componentProperties ?? {};
  const patch: Record<string, string | boolean | VariableAlias> = {};
  for (const [name, value] of Object.entries(props)) {
    if (!(name in available)) {
      ctx.warn(`Component property "${name}" not found on instance; skipped.`);
      continue;
    }
    if (typeof value === "string" || typeof value === "boolean" || isVariableAlias(value)) {
      patch[name] = value;
    } else {
      ctx.warn(`Component property "${name}" expects string/boolean/VariableAlias; skipped.`);
    }
  }
  if (Object.keys(patch).length === 0) return;
  try {
    instance.setProperties(patch);
  } catch (e) {
    ctx.warn(`Could not apply component props: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function isVariableAlias(value: unknown): value is VariableAlias {
  return !!value && typeof value === "object" && (value as { type?: unknown }).type === "VARIABLE_ALIAS" && typeof (value as { id?: unknown }).id === "string";
}

/** One applied (or failed) override, for the transparency report. */
export interface AppliedOverride {
  target: string;
  field: "text" | "visible" | "fills";
  appliedVia: "property" | "name";
  ok: boolean;
  error?: string;
}

/**
 * Nearest INSTANCE (the node itself or an ancestor, up to and including
 * `root`) whose componentProperties own `ref` — that is the instance
 * setProperties must be called on for the reference to take effect.
 */
function ownerInstanceFor(
  node: SceneNode,
  ref: string,
  root: InstanceNode,
): InstanceNode | null {
  let cur: BaseNode | null = node;
  while (cur) {
    if (cur.type === "INSTANCE") {
      const props = (cur as InstanceNode).componentProperties ?? {};
      if (ref in props) return cur as InstanceNode;
    }
    if (cur.id === root.id) break;
    cur = cur.parent;
  }
  return null;
}

/**
 * Set a text override. When the text node is wired to a component property
 * (componentPropertyReferences.characters) go through setProperties so
 * auto-layout reflows; otherwise (or if that fails) write characters directly.
 */
async function applyTextOverride(
  t: TextNode,
  text: string,
  root: InstanceNode,
  ctx: HandlerContext,
): Promise<"property" | "name"> {
  const ref = t.componentPropertyReferences?.characters;
  if (ref) {
    const owner = ownerInstanceFor(t, ref, root);
    if (owner) {
      try {
        owner.setProperties({ [ref]: text });
        return "property";
      } catch (e) {
        ctx.warn(
          `setProperties("${ref}") failed (${e instanceof Error ? e.message : String(e)}); fell back to setting characters on "${t.name}".`,
        );
      }
    }
  }
  await loadNodeFonts(t);
  t.characters = text;
  return "name";
}

/** overrides: { "Node Name": {text?, visible?, fills?} } keyed by node name. */
async function applyOverrides(
  root: InstanceNode,
  overrides: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<AppliedOverride[]> {
  const report: AppliedOverride[] = [];
  const byName = new Map<string, SceneNode[]>();
  const stack: SceneNode[] = [root];
  while (stack.length > 0) {
    const n = stack.pop()!;
    const list = byName.get(n.name) ?? [];
    list.push(n);
    byName.set(n.name, list);
    if ("children" in n) stack.push(...(n as ChildrenMixin).children);
  }
  for (const [name, ov] of Object.entries(overrides)) {
    const targets = byName.get(name);
    const o = (ov ?? {}) as Record<string, unknown>;
    if (!targets) {
      ctx.warn(`Override target "${name}" not found in instance; skipped.`);
      for (const field of ["text", "visible", "fills"] as const) {
        if (o[field] !== undefined) {
          report.push({
            target: name,
            field,
            appliedVia: "name",
            ok: false,
            error: "target not found",
          });
        }
      }
      continue;
    }
    for (const t of targets) {
      if (typeof o.visible === "boolean") {
        t.visible = o.visible;
        report.push({ target: name, field: "visible", appliedVia: "name", ok: true });
      }
      if (typeof o.text === "string" && t.type === "TEXT") {
        const via = await applyTextOverride(t as TextNode, o.text, root, ctx);
        report.push({ target: name, field: "text", appliedVia: via, ok: true });
      }
      if (o.fills !== undefined && "fills" in t) {
        (t as GeometryMixin).fills = toPaints(o.fills);
        report.push({ target: name, field: "fills", appliedVia: "name", ok: true });
      }
    }
  }
  return report;
}

/** {Size: "sm", State: "hover"} from the API, else parsed from the name. */
function variantPropsOf(v: ComponentNode): Record<string, string> {
  const api = (v as ComponentNode & { variantProperties?: unknown })
    .variantProperties;
  if (api && typeof api === "object" && !Array.isArray(api)) {
    return api as Record<string, string>;
  }
  const out: Record<string, string> = {};
  for (const part of v.name.split(",")) {
    const idx = part.indexOf("=");
    if (idx > 0) {
      const k = part.slice(0, idx).trim();
      const val = part.slice(idx + 1).trim();
      if (k) out[k] = val;
    }
  }
  return out;
}

/**
 * arrange_component_set: lay the variants of a COMPONENT_SET out on a grid.
 * Columns iterate the `columnsBy` axis (default: the LAST axis, typically
 * State); rows iterate every combination of the remaining axes. Uniform cells
 * sized to the largest variant; the set is resized to fit.
 */
export async function arrangeComponentSet(
  ctx: HandlerContext,
): Promise<unknown> {
  const p = ctx.params;
  const node = await requireNode(p.nodeId ?? p.id);
  if (node.type !== "COMPONENT_SET") {
    throw err(
      ErrorCode.INVALID_PARAMS,
      `Node "${node.id}" is a ${node.type}, not a COMPONENT_SET.`,
      "Pass the component set id returned by create_variants (componentSet: true).",
    );
  }
  const set = node as ComponentSetNode;
  const gap = typeof p.gap === "number" && p.gap >= 0 ? p.gap : 24;
  const padding = typeof p.padding === "number" && p.padding >= 0 ? p.padding : 16;
  const variants = set.children.filter(
    (c): c is ComponentNode => c.type === "COMPONENT",
  );
  if (variants.length === 0) {
    return { id: set.id, arranged: 0, rows: 0, cols: 0 };
  }

  const axisNames = Object.keys(variantPropsOf(variants[0]!));
  const colAxis =
    typeof p.columnsBy === "string" && axisNames.includes(p.columnsBy)
      ? p.columnsBy
      : axisNames[axisNames.length - 1];
  if (typeof p.columnsBy === "string" && p.columnsBy !== colAxis) {
    ctx.warn(
      `columnsBy "${p.columnsBy}" is not a variant axis (${axisNames.join(", ")}); used "${colAxis}".`,
    );
  }

  const cellW = Math.max(...variants.map((v) => v.width));
  const cellH = Math.max(...variants.map((v) => v.height));

  const rowKeys: string[] = [];
  const colKeys: string[] = [];
  for (const v of variants) {
    const props = variantPropsOf(v);
    const colKey = colAxis !== undefined ? String(props[colAxis] ?? "") : "";
    const rowKey =
      axisNames
        .filter((a) => a !== colAxis)
        .map((a) => `${a}=${props[a] ?? ""}`)
        .join(", ") || "·";
    if (!rowKeys.includes(rowKey)) rowKeys.push(rowKey);
    if (!colKeys.includes(colKey)) colKeys.push(colKey);
    v.x = padding + colKeys.indexOf(colKey) * (cellW + gap);
    v.y = padding + rowKeys.indexOf(rowKey) * (cellH + gap);
  }

  const totalW = 2 * padding + colKeys.length * cellW + (colKeys.length - 1) * gap;
  const totalH = 2 * padding + rowKeys.length * cellH + (rowKeys.length - 1) * gap;
  try {
    set.resizeWithoutConstraints(totalW, totalH);
  } catch (e) {
    ctx.warn(
      `Could not resize the set to fit (${e instanceof Error ? e.message : String(e)}).`,
    );
  }

  return {
    id: set.id,
    arranged: variants.length,
    rows: rowKeys.length,
    cols: colKeys.length,
    columnsBy: colAxis ?? null,
    cell: { w: cellW, h: cellH },
    gap,
  };
}

/**
 * set_component_description: write the description (and optionally
 * documentationLinks) of a COMPONENT / COMPONENT_SET so generated design
 * systems self-document. Empty string clears the description.
 */
export async function setComponentDescription(
  ctx: HandlerContext,
): Promise<unknown> {
  const p = ctx.params;
  const node = await requireNode(p.nodeId ?? p.componentId ?? p.id);
  if (node.type !== "COMPONENT" && node.type !== "COMPONENT_SET") {
    throw err(
      ErrorCode.INVALID_PARAMS,
      `Node "${node.id}" is a ${node.type}; descriptions live on COMPONENT / COMPONENT_SET.`,
      "For a variant inside a set, describe the set (or pass the variant COMPONENT's id).",
    );
  }
  const target = node as ComponentNode | ComponentSetNode;
  if (typeof p.description === "string") {
    target.description = p.description;
  }
  if (Array.isArray(p.documentationLinks)) {
    const links = (p.documentationLinks as unknown[])
      .filter(
        (l): l is { uri: string } =>
          !!l && typeof l === "object" && typeof (l as { uri?: unknown }).uri === "string",
      )
      .map((l) => ({ uri: l.uri }));
    try {
      target.documentationLinks = links;
    } catch (e) {
      ctx.warn(
        `Could not set documentationLinks (${e instanceof Error ? e.message : String(e)}).`,
      );
    }
  }
  return {
    id: target.id,
    name: target.name,
    description: target.description,
    documentationLinks: target.documentationLinks,
  };
}

/** Minimal structural tree of a node for signature matching. */
function toStruct(n: BaseNode): StructNode {
  return {
    type: n.type,
    name: n.name,
    children:
      "children" in n
        ? (n as ChildrenMixin).children.map(toStruct)
        : undefined,
  };
}

/**
 * Collect structural copies of `sig` under `root`, excluding the original
 * node. Never descends into components/instances (their content cannot be
 * replaced), and a match is not descended into (nested identical trees are
 * impossible).
 */
function collectCopies(
  root: BaseNode,
  sig: string,
  excludeId: string,
): SceneNode[] {
  const out: SceneNode[] = [];
  const stack: SceneNode[] = [
    ...("children" in root ? (root as ChildrenMixin).children : []),
  ];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.id === excludeId) continue;
    if (
      n.type === "INSTANCE" ||
      n.type === "COMPONENT" ||
      n.type === "COMPONENT_SET"
    ) {
      continue;
    }
    if (structureSignatureAtDepth(toStruct(n)) === sig) {
      out.push(n);
      continue;
    }
    if ("children" in n) stack.push(...(n as ChildrenMixin).children);
  }
  return out;
}

/**
 * componentize: turn an already-drawn tree into a COMPONENT (in place, via
 * createComponentFromNode) and — unless replaceCopies: false — replace every
 * structurally identical copy (same type/name tree) in scope with an instance
 * at the same parent/index/position. The draw-once-reuse-everywhere op.
 */
export async function componentize(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const node = await requireNode(p.nodeId ?? p.id);
  if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
    throw err(
      ErrorCode.INVALID_PARAMS,
      `Node "${node.id}" is already a ${node.type}.`,
      "Pass a plain FRAME/GROUP tree; use instantiate to reuse an existing component.",
    );
  }
  if (node.type === "INSTANCE") {
    throw err(
      ErrorCode.INVALID_PARAMS,
      `Node "${node.id}" is an INSTANCE — it already reuses a component.`,
      "Componentize its main component's copies instead, or detach_instance first.",
    );
  }
  const replaceCopies = p.replaceCopies !== false;
  const scope = p.scope === "document" ? "document" : "page";

  // Capture the signature and the copies BEFORE conversion mutates the tree.
  const sig = structureSignatureAtDepth(toStruct(node));
  let candidates: SceneNode[] = [];
  if (replaceCopies) {
    const roots: BaseNode[] =
      scope === "document"
        ? (await figma.loadAllPagesAsync?.(), [...figma.root.children])
        : [figma.currentPage];
    for (const root of roots) {
      candidates.push(...collectCopies(root, sig, node.id));
    }
  }

  const comp = figma.createComponentFromNode(node as SceneNode);
  if (typeof p.name === "string" && p.name.length > 0) comp.name = p.name;

  const replaced: Array<{
    id: string;
    instanceId?: string;
    ok: boolean;
    error?: string;
  }> = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    try {
      const parent = c.parent;
      if (!parent || !("insertChild" in parent)) {
        replaced.push({ id: c.id, ok: false, error: "parent cannot hold an instance" });
        continue;
      }
      const index = (parent as ChildrenMixin).children.indexOf(c);
      const inst = comp.createInstance();
      (parent as BaseNode & ChildrenMixin).insertChild(
        index < 0 ? (parent as ChildrenMixin).children.length : index,
        inst,
      );
      if ("x" in c) {
        inst.x = (c as LayoutMixin).x;
        inst.y = (c as LayoutMixin).y;
      }
      const oldId = c.id;
      c.remove();
      replaced.push({ id: oldId, instanceId: inst.id, ok: true });
    } catch (e) {
      replaced.push({
        id: c.id,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    ctx.progress(i + 1, candidates.length);
  }

  const okCount = replaced.filter((r) => r.ok).length;
  return {
    componentId: comp.id,
    name: comp.name,
    candidatesFound: candidates.length,
    replacedCount: okCount,
    failCount: replaced.length - okCount,
    replaced,
    node: serializeNode(comp, "compact"),
  };
}

/** Hard cap on axes combinations — beyond this the file becomes unusable. */
const MAX_VARIANT_COMBOS = 50;

/** {Size: ["sm","md"], State: ["default","hover"]} — every value an array. */
function isAxesShape(v: unknown): v is Record<string, unknown[]> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const entries = Object.entries(v as Record<string, unknown>);
  return (
    entries.length > 0 &&
    entries.every(([, vals]) => Array.isArray(vals) && vals.length > 0)
  );
}

/** Cartesian product of the axes, preserving key order. */
function cartesian(
  axes: Record<string, unknown[]>,
): Array<Record<string, string>> {
  let combos: Array<Record<string, string>> = [{}];
  for (const [axis, values] of Object.entries(axes)) {
    const next: Array<Record<string, string>> = [];
    for (const combo of combos) {
      for (const v of values) next.push({ ...combo, [axis]: String(v) });
    }
    combos = next;
  }
  return combos;
}

interface VariantPlanEntry {
  /** Figma variant name, e.g. "Size=sm, State=default". */
  name: string;
  /** Per-variant spec merged over baseSpec (fills, size, …). */
  override?: Record<string, unknown>;
}

/**
 * create_variants: build a real component set. Two input shapes:
 * - `axes: {Size: [...], State: [...]}` (or a variants object of that shape)
 *   → Cartesian product, one COMPONENT per combo named "Size=sm, State=hover";
 *   combineAsVariants derives the multi-axis property definitions from names.
 * - legacy `variants`/`states` list → single `state` axis. String entries name
 *   the state; object entries may carry a `name`/`state` plus per-variant spec
 *   overrides ({name: "State=Default", fills: [...]}).
 * Falls back to individual components (with childMap) when combineAsVariants
 * is unavailable / fails.
 */
export async function createVariants(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const baseSpec = (p.baseSpec as Record<string, unknown>) ?? {};
  const baseName = String(baseSpec.name ?? p.name ?? "Variant");

  // Accept axes as p.axes, as the whole variants arg, or wrapped ({axes: …}).
  const vRaw: unknown = p.variants ?? p.states;
  let axes: Record<string, unknown[]> | undefined;
  if (p.axes !== undefined) {
    if (!isAxesShape(p.axes)) {
      throw err(
        ErrorCode.INVALID_PARAMS,
        "axes must be a non-empty object of non-empty arrays, e.g. {Size: [\"sm\",\"md\"], State: [\"default\",\"hover\"]}.",
      );
    }
    axes = p.axes;
  } else if (isAxesShape(vRaw)) {
    axes = vRaw;
  } else if (
    vRaw &&
    typeof vRaw === "object" &&
    isAxesShape((vRaw as { axes?: unknown }).axes)
  ) {
    axes = (vRaw as { axes: Record<string, unknown[]> }).axes;
  }

  let plan: VariantPlanEntry[];
  if (axes) {
    const combos = cartesian(axes);
    if (combos.length > MAX_VARIANT_COMBOS) {
      throw err(
        ErrorCode.INVALID_PARAMS,
        `axes expand to ${combos.length} variants (max ${MAX_VARIANT_COMBOS}).`,
        "Split the matrix (e.g. one component set per Size) or drop an axis.",
      );
    }
    plan = combos.map((c) => ({
      name: Object.entries(c)
        .map(([k, v]) => `${k}=${v}`)
        .join(", "),
    }));
  } else if (Array.isArray(vRaw)) {
    plan = vRaw.map((v) => {
      if (typeof v === "string") return { name: `state=${v}` };
      const o = (v ?? {}) as Record<string, unknown>;
      const { state, name, ...rest } = o;
      const label =
        typeof name === "string" && name.includes("=")
          ? name
          : `state=${String(state ?? name ?? "default")}`;
      return {
        name: label,
        override: Object.keys(rest).length > 0 ? rest : undefined,
      };
    });
  } else if (vRaw && typeof vRaw === "object") {
    plan = Object.entries(vRaw as Record<string, unknown>).map(([k, ov]) => ({
      name: `state=${k}`,
      override:
        ov && typeof ov === "object" && !Array.isArray(ov)
          ? (ov as Record<string, unknown>)
          : undefined,
    }));
  } else {
    plan = [];
  }

  if (plan.length === 0) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      "create_variants requires axes or a non-empty variants/states list.",
    );
  }

  // Build one COMPONENT per planned variant.
  const components: ComponentNode[] = [];
  const childMaps: Record<string, Record<string, string>> = {};
  for (let i = 0; i < plan.length; i++) {
    const entry = plan[i]!;
    const createCtx: HandlerContext = {
      ...ctx,
      params: {
        ...baseSpec,
        ...(entry.override ?? {}),
        type: "COMPONENT",
        name: `${baseName}=${entry.name}`,
      },
      warnings: ctx.warnings,
    };
    const res = (await create(createCtx)) as { id: string };
    const node = (await figma.getNodeByIdAsync(res.id)) as ComponentNode;
    node.name = entry.name;
    components.push(node);
    childMaps[entry.name] = { [baseName]: node.id };
    ctx.progress(i + 1, plan.length);
  }

  const axesEcho = axes
    ? Object.fromEntries(
        Object.entries(axes).map(([k, vs]) => [k, vs.map(String)]),
      )
    : undefined;

  try {
    const set = figma.combineAsVariants(components, figma.currentPage);
    set.name = baseName;
    return {
      id: set.id,
      componentSet: true,
      ...(axesEcho ? { axes: axesEcho } : {}),
      variants: components.map((c) => ({ id: c.id, name: c.name })),
      node: serializeNode(set, "compact"),
    };
  } catch (e) {
    ctx.warn(
      `combineAsVariants failed (${e instanceof Error ? e.message : String(e)}); returned individual frames instead.`,
    );
    return {
      id: components[0]!.id,
      componentSet: false,
      ...(axesEcho ? { axes: axesEcho } : {}),
      variants: components.map((c) => ({ id: c.id, name: c.name })),
      childMap: childMaps,
    };
  }
}
