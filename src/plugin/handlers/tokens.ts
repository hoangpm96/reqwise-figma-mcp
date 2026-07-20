/// <reference types="@figma/plugin-typings" />
import { HandlerContext, requireNode } from "../context.js";
import { hexToRgba, rgbaToHex } from "../color-util.js";
import { err } from "../errors.js";
import { ErrorCode } from "../../shared/protocol.js";
import { collectModes, normalizeColorValue } from "../tokens-util.js";
import {
  toDtcg,
  toCss,
  toTailwind,
  parseDtcg,
  FlatToken,
  NeutralCollection,
  NeutralToken,
  TokenScalar,
  TokenType,
} from "../../shared/token-format.js";

const COLLECTION_NAME = "Reqwise Tokens";

interface TokensInput {
  colors?: Record<string, string | { light?: string; dark?: string; [mode: string]: string | undefined }>;
  numbers?: Record<string, number>;
  strings?: Record<string, string>;
}

/**
 * Create/update a single variable collection "Reqwise Tokens". CRITICAL: sets
 * values for ALL modes explicitly (the predecessor left non-default modes at
 * 0 / "String value"). Idempotent: re-running updates existing variables in
 * place. Colors may be a single hex (applied to every mode) or a per-mode map
 * ({light, dark}); modes are created as needed.
 */
export async function setupTokens(ctx: HandlerContext): Promise<unknown> {
  const input = (ctx.params.tokens ?? ctx.params) as TokensInput;
  const colors = input.colors ?? {};
  const numbers = input.numbers ?? {};
  const strings = input.strings ?? {};

  // Determine the full set of modes referenced by any per-mode color value.
  const modeNames = collectModes(colors);

  const collection = await getOrCreateCollection(modeNames, ctx);
  const modeIds = collection.modes.map((m) => m.modeId);
  const modeIdByName = new Map(collection.modes.map((m) => [m.name, m.modeId]));

  const existing = await existingVarsByName(collection);

  const created: string[] = [];
  const updated: string[] = [];

  // COLOR variables.
  for (const [name, value] of Object.entries(colors)) {
    const variable = upsertVar(existing, collection, name, "COLOR", created, updated);
    const perMode = normalizeColorValue(value, modeNames);
    for (const mode of collection.modes) {
      const hex = perMode[mode.name] ?? perMode.__default__;
      if (hex === undefined) continue;
      const { r, g, b, a } = hexToRgba(hex);
      variable.setValueForMode(mode.modeId, { r, g, b, a });
    }
  }

  // FLOAT variables (same value for all modes).
  for (const [name, value] of Object.entries(numbers)) {
    const variable = upsertVar(existing, collection, name, "FLOAT", created, updated);
    for (const modeId of modeIds) variable.setValueForMode(modeId, value);
  }

  // STRING variables (same value for all modes).
  for (const [name, value] of Object.entries(strings)) {
    const variable = upsertVar(existing, collection, name, "STRING", created, updated);
    for (const modeId of modeIds) variable.setValueForMode(modeId, value);
  }

  return {
    collectionId: collection.id,
    collection: COLLECTION_NAME,
    modes: collection.modes.map((m) => m.name),
    created,
    updated,
    total: created.length + updated.length,
  };
}

async function getOrCreateCollection(
  modeNames: string[],
  ctx: HandlerContext,
): Promise<VariableCollection> {
  const all = await figma.variables.getLocalVariableCollectionsAsync();
  let collection = all.find((c) => c.name === COLLECTION_NAME);
  if (!collection) {
    collection = figma.variables.createVariableCollection(COLLECTION_NAME);
  }
  // Ensure every referenced mode exists; rename the default when appropriate.
  const existingNames = new Set(collection.modes.map((m) => m.name));
  for (let i = 0; i < modeNames.length; i++) {
    const name = modeNames[i]!;
    if (existingNames.has(name)) continue;
    if (i === 0 && collection.modes.length === 1) {
      // Rename the single default mode to the first requested name.
      collection.renameMode(collection.modes[0]!.modeId, name);
    } else {
      collection.addMode(name);
    }
    existingNames.add(name);
  }
  return collection;
}

async function existingVarsByName(
  collection: VariableCollection,
): Promise<Map<string, Variable>> {
  const map = new Map<string, Variable>();
  for (const id of collection.variableIds) {
    const v = await figma.variables.getVariableByIdAsync(id);
    if (v) map.set(v.name, v);
  }
  return map;
}

function upsertVar(
  existing: Map<string, Variable>,
  collection: VariableCollection,
  name: string,
  type: VariableResolvedDataType,
  created: string[],
  updated: string[],
): Variable {
  const found = existing.get(name);
  if (found) {
    if (found.resolvedType !== type) {
      throw err(
        ErrorCode.INVALID_PARAMS,
        `Token "${name}" already exists as ${found.resolvedType}, cannot redefine as ${type}.`,
        "Use a different token name or remove the old collection.",
      );
    }
    updated.push(name);
    return found;
  }
  const v = figma.variables.createVariable(name, collection, type);
  existing.set(name, v);
  created.push(name);
  return v;
}

/** Bind a variable (by name) to a node field via setBoundVariable. */
export async function applyVariable(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const node = await requireNode(p.nodeId ?? p.id);
  const tokenName = String(p.tokenName ?? p.variable ?? "");
  const field = String(p.field ?? "");
  if (!tokenName || !field) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      "apply_variable requires tokenName and field.",
      'Example: { nodeId, tokenName: "primary", field: "fills" }.',
    );
  }
  const variable = await findVariableByName(tokenName);
  if (!variable) {
    throw err(
      ErrorCode.NODE_NOT_FOUND,
      `No variable named "${tokenName}".`,
      "Run setup_tokens first, or check the token name.",
    );
  }

  // Paint fields (fills/strokes) bind via setBoundVariableForPaint.
  if (field === "fills" || field === "strokes") {
    if (!("fills" in node)) {
      throw err(ErrorCode.INVALID_PARAMS, `Node ${node.type} has no ${field}.`);
    }
    const geo = node as GeometryMixin;
    const paints = (field === "fills" ? geo.fills : geo.strokes) as
      | readonly Paint[]
      | typeof figma.mixed;
    const base: SolidPaint =
      Array.isArray(paints) && paints[0]?.type === "SOLID"
        ? (paints[0] as SolidPaint)
        : { type: "SOLID", color: { r: 0, g: 0, b: 0 } };
    const bound = figma.variables.setBoundVariableForPaint(base, "color", variable);
    if (field === "fills") geo.fills = [bound];
    else geo.strokes = [bound];
  } else {
    (node as SceneNode).setBoundVariable(
      field as VariableBindableNodeField,
      variable,
    );
  }
  return { id: node.id, bound: { field, tokenName, variableId: variable.id } };
}

async function findVariableByName(name: string): Promise<Variable | null> {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  for (const c of collections) {
    for (const id of c.variableIds) {
      const v = await figma.variables.getVariableByIdAsync(id);
      if (v && v.name === name) return v;
    }
  }
  return null;
}

// ---- Variable CRUD (roadmap Wave 4a) ----

type VarPrimitive = string | number | boolean;

function inferVarType(v: VarPrimitive): VariableResolvedDataType {
  if (typeof v === "number") return "FLOAT";
  if (typeof v === "boolean") return "BOOLEAN";
  return /^#([0-9a-f]{3,8})$/i.test(v.trim()) ? "COLOR" : "STRING";
}

function convertVarValue(
  value: unknown,
  type: VariableResolvedDataType,
): VariableValue {
  switch (type) {
    case "COLOR": {
      const { r, g, b, a } = hexToRgba(String(value));
      return { r, g, b, a };
    }
    case "FLOAT": {
      const n = Number(value);
      if (Number.isNaN(n)) {
        throw err(ErrorCode.INVALID_PARAMS, `"${String(value)}" is not a number.`);
      }
      return n;
    }
    case "BOOLEAN":
      return value === true || value === "true";
    default:
      return String(value);
  }
}

/** Collection by id/name param; defaults to (and creates) "Reqwise Tokens". */
async function resolveCollectionParam(
  p: Record<string, unknown>,
): Promise<VariableCollection> {
  const wanted =
    typeof p.collection === "string" && p.collection.length > 0
      ? p.collection
      : COLLECTION_NAME;
  const all = await figma.variables.getLocalVariableCollectionsAsync();
  const found = all.find((c) => c.id === wanted || c.name === wanted);
  if (found) return found;
  if (wanted !== COLLECTION_NAME && p.createCollection !== true) {
    throw err(
      ErrorCode.NODE_NOT_FOUND,
      `No variable collection "${wanted}".`,
      `Existing collections: ${all.map((c) => c.name).join(", ") || "(none)"}. Pass createCollection: true to create it.`,
    );
  }
  return figma.variables.createVariableCollection(wanted);
}

/** Variable by id ("VariableID:…" or raw id) or by name across collections. */
async function resolveVariableRef(ref: unknown): Promise<Variable | null> {
  const s = String(ref ?? "").trim();
  if (!s) return null;
  try {
    const byId = await figma.variables.getVariableByIdAsync(s);
    if (byId) return byId;
  } catch {
    // not an id — fall through to name lookup
  }
  return findVariableByName(s);
}

/**
 * Set value/valuesByMode on a variable. `value` writes ALL modes explicitly
 * (the multi-mode rule); valuesByMode targets modes by name, creating missing
 * ones. Returns the mode names written.
 */
function writeVariableValues(
  variable: Variable,
  collection: VariableCollection,
  p: Record<string, unknown>,
  type: VariableResolvedDataType,
): string[] {
  const written: string[] = [];
  const vbm = p.valuesByMode;
  if (vbm && typeof vbm === "object" && !Array.isArray(vbm)) {
    for (const [modeName, val] of Object.entries(vbm as Record<string, unknown>)) {
      let mode = collection.modes.find(
        (m) => m.name === modeName || m.modeId === modeName,
      );
      if (!mode) {
        const modeId = collection.addMode(modeName);
        mode = { modeId, name: modeName };
      }
      variable.setValueForMode(mode.modeId, convertVarValue(val, type));
      written.push(mode.name);
    }
  } else if (p.value !== undefined) {
    for (const m of collection.modes) {
      variable.setValueForMode(m.modeId, convertVarValue(p.value, type));
      written.push(m.name);
    }
  }
  return written;
}

export async function createVariable(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const name = String(p.name ?? "").trim();
  if (!name) {
    throw err(ErrorCode.INVALID_PARAMS, "create_variable requires a name.");
  }
  const sample =
    p.value !== undefined
      ? p.value
      : p.valuesByMode && typeof p.valuesByMode === "object"
        ? Object.values(p.valuesByMode as Record<string, unknown>)[0]
        : undefined;
  if (sample === undefined) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      "create_variable requires value or valuesByMode.",
      'Example: { name: "primary", value: "#3366ee" } or { name: "bg", valuesByMode: { light: "#fff", dark: "#111" } }.',
    );
  }
  const type: VariableResolvedDataType =
    p.type === "COLOR" || p.type === "FLOAT" || p.type === "STRING" || p.type === "BOOLEAN"
      ? p.type
      : inferVarType(sample as VarPrimitive);

  const collection = await resolveCollectionParam(p);
  const existing = await existingVarsByName(collection);
  if (existing.has(name)) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      `Variable "${name}" already exists in "${collection.name}".`,
      "Use update_variable to change it, or rename_variable first.",
    );
  }
  const variable = figma.variables.createVariable(name, collection, type);
  if (typeof p.description === "string") variable.description = p.description;
  const modes = writeVariableValues(variable, collection, p, type);
  return { id: variable.id, name, type, collection: collection.name, modes };
}

export async function updateVariable(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const variable = await resolveVariableRef(p.variable ?? p.name ?? p.variableId);
  if (!variable) {
    throw err(
      ErrorCode.NODE_NOT_FOUND,
      `No variable "${String(p.variable ?? p.name ?? p.variableId ?? "")}".`,
      "Pass a variable name or id (see get_variables).",
    );
  }
  const collection = await figma.variables.getVariableCollectionByIdAsync(
    variable.variableCollectionId,
  );
  if (!collection) {
    throw err(ErrorCode.INTERNAL, "Variable's collection not found.");
  }
  const changed: string[] = [];
  if (typeof p.description === "string") {
    variable.description = p.description;
    changed.push("description");
  }
  if (typeof p.hiddenFromPublishing === "boolean") {
    variable.hiddenFromPublishing = p.hiddenFromPublishing;
    changed.push("hiddenFromPublishing");
  }
  const modes = writeVariableValues(variable, collection, p, variable.resolvedType);
  if (modes.length > 0) changed.push(`values(${modes.join(", ")})`);
  if (changed.length === 0) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      "update_variable requires value, valuesByMode, description or hiddenFromPublishing.",
    );
  }
  return { id: variable.id, name: variable.name, changed };
}

export async function renameVariable(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const variable = await resolveVariableRef(p.variable ?? p.name ?? p.variableId);
  const newName = String(p.newName ?? p.to ?? "").trim();
  if (!variable || !newName) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      "rename_variable requires a variable (name/id) and newName.",
      'Example: { variable: "primary", newName: "color/primary" }.',
    );
  }
  const oldName = variable.name;
  variable.name = newName;
  // Bindings reference the variable ID, so every consumer keeps resolving.
  return { id: variable.id, oldName, name: newName, referencesKept: true };
}

interface VariableUsage {
  node: SceneNode;
  kind: "field" | "paint";
  field: string;
  index?: number;
}

/** Walk the whole document for bindings to `varId` (fields + paints). */
async function scanVariableUsages(
  varId: string,
  ctx: HandlerContext,
): Promise<VariableUsage[]> {
  await figma.loadAllPagesAsync?.();
  const out: VariableUsage[] = [];
  const stack: SceneNode[] = [];
  for (const page of figma.root.children) {
    stack.push(...(page as PageNode).children);
  }
  let visited = 0;
  while (stack.length > 0) {
    const n = stack.pop()!;
    visited++;
    if (visited % 500 === 0) {
      ctx.progress(visited, visited + stack.length, "scanning variable usages");
    }
    const bv = (n as SceneNode & { boundVariables?: Record<string, unknown> })
      .boundVariables;
    if (bv) {
      for (const [field, alias] of Object.entries(bv)) {
        if (field === "fills" || field === "strokes") continue; // via paints below
        const aliases = Array.isArray(alias) ? alias : [alias];
        if (
          aliases.some(
            (a) => !!a && (a as VariableAlias).id === varId,
          )
        ) {
          out.push({ node: n, kind: "field", field });
        }
      }
    }
    for (const field of ["fills", "strokes"] as const) {
      if (field in n) {
        const paints = (n as GeometryMixin)[field];
        if (Array.isArray(paints)) {
          paints.forEach((paint, index) => {
            const pb = (paint as SolidPaint).boundVariables;
            if (pb?.color?.id === varId) {
              out.push({ node: n, kind: "paint", field, index });
            }
          });
        }
      }
    }
    if ("children" in n) stack.push(...(n as ChildrenMixin).children);
  }
  return out;
}

/**
 * delete_variable with a replace-gate: a variable that is still bound
 * somewhere is NOT deleted unless the caller passes replaceWith (rebind every
 * consumer to another variable of the same type) or force: true.
 */
export async function deleteVariable(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const variable = await resolveVariableRef(p.variable ?? p.name ?? p.variableId);
  if (!variable) {
    throw err(
      ErrorCode.NODE_NOT_FOUND,
      `No variable "${String(p.variable ?? p.name ?? p.variableId ?? "")}".`,
      "Pass a variable name or id (see get_variables).",
    );
  }
  let replaceWith: Variable | null = null;
  if (p.replaceWith !== undefined) {
    replaceWith = await resolveVariableRef(p.replaceWith);
    if (!replaceWith) {
      throw err(
        ErrorCode.NODE_NOT_FOUND,
        `replaceWith variable "${String(p.replaceWith)}" not found.`,
      );
    }
    if (replaceWith.resolvedType !== variable.resolvedType) {
      throw err(
        ErrorCode.INVALID_PARAMS,
        `Cannot replace ${variable.resolvedType} "${variable.name}" with ${replaceWith.resolvedType} "${replaceWith.name}".`,
      );
    }
  }

  const usages = await scanVariableUsages(variable.id, ctx);
  if (usages.length > 0 && !replaceWith && p.force !== true) {
    throw err(
      ErrorCode.COMPONENT_IN_USE,
      `Variable "${variable.name}" is bound to ${usages.length} node field(s); deleting would break them.`,
      "Pass replaceWith: <variable name/id> to rebind consumers first, or force: true to delete anyway.",
    );
  }

  let rebound = 0;
  const reboundFailed: string[] = [];
  if (replaceWith) {
    for (const u of usages) {
      try {
        if (u.kind === "field") {
          u.node.setBoundVariable(
            u.field as VariableBindableNodeField,
            replaceWith,
          );
        } else {
          const geo = u.node as GeometryMixin;
          const paints = [
            ...((u.field === "fills" ? geo.fills : geo.strokes) as readonly Paint[]),
          ];
          paints[u.index!] = figma.variables.setBoundVariableForPaint(
            paints[u.index!] as SolidPaint,
            "color",
            replaceWith,
          );
          if (u.field === "fills") geo.fills = paints;
          else geo.strokes = paints;
        }
        rebound++;
      } catch (e) {
        reboundFailed.push(
          `${u.node.id}.${u.field}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  const name = variable.name;
  const id = variable.id;
  variable.remove();
  return {
    deleted: name,
    id,
    usagesFound: usages.length,
    rebound,
    reboundFailed,
    ...(replaceWith ? { replacedWith: replaceWith.name } : {}),
  };
}

// ---- Token export / import (roadmap Wave 4b) ----

const FIGMA_TO_TOKEN_TYPE: Record<string, TokenType> = {
  COLOR: "color",
  FLOAT: "number",
  STRING: "string",
  BOOLEAN: "boolean",
};
const TOKEN_TO_FIGMA_TYPE: Record<TokenType, VariableResolvedDataType> = {
  color: "COLOR",
  number: "FLOAT",
  string: "STRING",
  boolean: "BOOLEAN",
};

/** Resolve local collections into the neutral shape token-format consumes. */
async function collectNeutral(
  wanted: VariableCollection[],
  all: VariableCollection[],
  ctx: HandlerContext,
): Promise<NeutralCollection[]> {
  // Variable-name lookup across ALL collections so alias refs resolve even
  // when the target lives in a collection not being exported.
  const nameById = new Map<string, string>();
  for (const c of all) {
    for (const id of c.variableIds) {
      const v = await figma.variables.getVariableByIdAsync(id);
      if (v) nameById.set(v.id, v.name);
    }
  }
  const neutral: NeutralCollection[] = [];
  for (const c of wanted) {
    const tokens: NeutralToken[] = [];
    for (const id of c.variableIds) {
      const v = await figma.variables.getVariableByIdAsync(id);
      if (!v) continue;
      const type = FIGMA_TO_TOKEN_TYPE[v.resolvedType] ?? "string";
      const valuesByMode: Record<string, TokenScalar> = {};
      for (const m of c.modes) {
        const raw = (v.valuesByMode as Record<string, unknown>)[m.modeId];
        if (raw === undefined) continue;
        if (
          raw &&
          typeof raw === "object" &&
          (raw as VariableAlias).type === "VARIABLE_ALIAS"
        ) {
          const target = nameById.get((raw as VariableAlias).id);
          if (target) {
            valuesByMode[m.name] = `{${target.split("/").join(".")}}`;
          } else {
            ctx.warn(`Alias target of "${v.name}" (${m.name}) not found; value omitted.`);
          }
        } else if (raw && typeof raw === "object" && "r" in (raw as object)) {
          valuesByMode[m.name] = rgbaToHex(raw as RGBA);
        } else {
          valuesByMode[m.name] = raw as TokenScalar;
        }
      }
      tokens.push({ path: v.name.split("/"), type, valuesByMode });
    }
    neutral.push({
      name: c.name,
      modes: c.modes.map((m) => m.name),
      defaultMode:
        c.modes.find((m) => m.modeId === c.defaultModeId)?.name ??
        c.modes[0]?.name ??
        "Mode 1",
      tokens,
    });
  }
  return neutral;
}

/**
 * export_tokens: local variables → DTCG JSON (default), CSS custom
 * properties, or a Tailwind theme extension. Aliases become DTCG "{a.b}"
 * refs / CSS var() refs; multi-mode goes to allModes (DTCG) or
 * [data-theme="mode"] blocks (CSS).
 */
export async function exportTokens(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const format =
    p.format === "css" || p.format === "tailwind" ? p.format : "dtcg";
  const all = await figma.variables.getLocalVariableCollectionsAsync();
  const wanted =
    typeof p.collection === "string" && p.collection.length > 0
      ? all.filter((c) => c.id === p.collection || c.name === p.collection)
      : all;
  if (wanted.length === 0) {
    throw err(
      ErrorCode.NODE_NOT_FOUND,
      typeof p.collection === "string"
        ? `No variable collection "${p.collection}".`
        : "This file has no local variable collections.",
      all.length > 0
        ? `Existing collections: ${all.map((c) => c.name).join(", ")}.`
        : "Create variables first (setup_tokens / create_variable).",
    );
  }
  const neutral = await collectNeutral(wanted, all, ctx);
  const count = neutral.reduce((s, c) => s + c.tokens.length, 0);
  const mode = typeof p.mode === "string" ? p.mode : undefined;

  if (format === "css") {
    return {
      format,
      count,
      content: toCss(neutral, {
        selector: typeof p.selector === "string" ? p.selector : undefined,
      }),
    };
  }
  if (format === "tailwind") {
    const tw = toTailwind(neutral, { mode });
    if (tw.skipped.length > 0) {
      ctx.warn(
        `No Tailwind slot for: ${tw.skipped.join(", ")} (strings/booleans/aliases are skipped).`,
      );
    }
    return { format, count, content: tw.content };
  }
  return {
    format,
    count,
    tokens: toDtcg(neutral, { mode, allModes: p.allModes === true }),
  };
}

/**
 * import_tokens: DTCG-ish tree → variables (upsert by name into one
 * collection, default "Reqwise Tokens"). `tokens` writes all modes (or the
 * one named by `mode`); `modes: {light: tree, dark: tree}` writes per mode,
 * creating missing modes. Alias refs "{a.b}" resolve after literals land;
 * unresolvable aliases and type conflicts become warnings, not failures.
 */
export async function importTokens(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const modesForm =
    p.modes && typeof p.modes === "object" && !Array.isArray(p.modes)
      ? (p.modes as Record<string, unknown>)
      : undefined;
  const tree = p.tokens ?? p.dtcg;
  if (!modesForm && (!tree || typeof tree !== "object" || Array.isArray(tree))) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      "import_tokens requires tokens (a DTCG tree) or modes ({modeName: tree}).",
      'Example: { tokens: { color: { primary: { $type: "color", $value: "#36e" } } } }.',
    );
  }

  const collection = await resolveCollectionParam({
    ...p,
    createCollection: p.createCollection !== false,
  });
  const existing = await existingVarsByName(collection);
  const created: string[] = [];
  const updated: string[] = [];

  const batches: Array<{ flat: FlatToken[]; modeName?: string }> = modesForm
    ? Object.entries(modesForm).map(([modeName, subtree]) => ({
        flat: parseDtcg(subtree),
        modeName,
      }))
    : [
        {
          flat: parseDtcg(tree),
          modeName: typeof p.mode === "string" ? p.mode : undefined,
        },
      ];

  const modeIdsFor = (modeName: string | undefined): string[] => {
    if (modeName === undefined) return collection.modes.map((m) => m.modeId);
    let mode = collection.modes.find(
      (m) => m.name === modeName || m.modeId === modeName,
    );
    if (!mode) {
      const modeId = collection.addMode(modeName);
      mode = { modeId, name: modeName };
    }
    return [mode.modeId];
  };

  const aliasQueue: Array<{ token: FlatToken; modeIds: string[] }> = [];
  let processed = 0;
  const totalTokens = batches.reduce((s, b) => s + b.flat.length, 0);

  for (const batch of batches) {
    const modeIds = modeIdsFor(batch.modeName);
    for (const token of batch.flat) {
      processed++;
      if (processed % 25 === 0) ctx.progress(processed, totalTokens, "importing tokens");
      const figmaType = TOKEN_TO_FIGMA_TYPE[token.type];
      let variable: Variable;
      try {
        variable = upsertVar(existing, collection, token.name, figmaType, created, updated);
      } catch (e) {
        ctx.warn(e instanceof Error ? e.message : String(e));
        continue;
      }
      if (token.aliasTo) {
        aliasQueue.push({ token, modeIds });
        continue;
      }
      for (const modeId of modeIds) {
        variable.setValueForMode(modeId, convertVarValue(token.value, figmaType));
      }
    }
  }

  // Second pass: aliases, now that literal targets exist.
  let aliased = 0;
  for (const { token, modeIds } of aliasQueue) {
    const targetName = token.aliasTo!.join("/");
    const target =
      existing.get(targetName) ?? (await findVariableByName(targetName));
    const variable = existing.get(token.name);
    if (!target || !variable) {
      ctx.warn(`Alias "${token.name}" → "${targetName}" skipped: target not found.`);
      continue;
    }
    for (const modeId of modeIds) {
      variable.setValueForMode(modeId, {
        type: "VARIABLE_ALIAS",
        id: target.id,
      });
    }
    aliased++;
  }

  // De-dup names that appeared in several mode batches.
  const uniq = (a: string[]) => [...new Set(a)];
  return {
    collection: collection.name,
    created: uniq(created),
    updated: uniq(updated).filter((n) => !created.includes(n)),
    aliased,
    total: totalTokens,
  };
}
