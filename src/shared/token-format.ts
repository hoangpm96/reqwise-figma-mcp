/**
 * Token export/import formats (DTCG JSON, CSS custom properties, Tailwind).
 * Pure data-in/data-out — NO figma globals — shared by the plugin handlers
 * and testable in the server program (same pattern as design-system.ts).
 *
 * Neutral shape: the plugin resolves Figma variables into NeutralCollection[]
 * (aliases already turned into "{path.to.token}" DTCG-style references);
 * everything below is serialization.
 */

export type TokenScalar = string | number | boolean;
export type TokenType = "color" | "number" | "string" | "boolean";

export interface NeutralToken {
  /** Name split on "/" — ["color", "primary"]. */
  path: string[];
  type: TokenType;
  /** Mode name → value; alias refs are "{path.to.token}" strings. */
  valuesByMode: Record<string, TokenScalar>;
}

export interface NeutralCollection {
  name: string;
  modes: string[];
  defaultMode: string;
  tokens: NeutralToken[];
}

/** "{a.b}" — a DTCG alias reference. */
export function isAliasRef(v: unknown): v is string {
  return typeof v === "string" && /^\{[^{}]+\}$/.test(v.trim());
}

// ---- DTCG export ----

type DtcgNode = { [key: string]: DtcgNode | DtcgLeaf };
interface DtcgLeaf {
  $type: TokenType;
  $value: TokenScalar;
}

function insertLeaf(root: DtcgNode, path: string[], leaf: DtcgLeaf): void {
  let cur = root;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i]!;
    const next = cur[seg];
    if (!next || "$value" in next) {
      cur[seg] = {};
    }
    cur = cur[seg] as DtcgNode;
  }
  cur[path[path.length - 1]!] = leaf;
}

/**
 * DTCG tree for one mode. With a single collection the tree is flat; several
 * collections nest under their names.
 */
export function toDtcg(
  collections: NeutralCollection[],
  opts: { mode?: string; allModes?: boolean } = {},
): Record<string, unknown> {
  if (opts.allModes) {
    const modes = new Set<string>();
    for (const c of collections) for (const m of c.modes) modes.add(m);
    const out: Record<string, unknown> = {};
    for (const m of modes) out[m] = toDtcg(collections, { mode: m });
    return out;
  }
  const root: DtcgNode = {};
  const nest = collections.length > 1;
  for (const c of collections) {
    const mode = opts.mode && c.modes.includes(opts.mode) ? opts.mode : c.defaultMode;
    for (const t of c.tokens) {
      const value = t.valuesByMode[mode] ?? t.valuesByMode[c.defaultMode];
      if (value === undefined) continue;
      const path = nest ? [c.name, ...t.path] : t.path;
      insertLeaf(root, path, { $type: t.type, $value: value });
    }
  }
  return root;
}

// ---- CSS export ----

/** "color/Primary Dark" → "color-primary-dark". */
export function cssSlug(path: string[]): string {
  return path
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function cssValue(t: NeutralToken, v: TokenScalar): string {
  if (isAliasRef(v)) {
    return `var(--${cssSlug(String(v).trim().slice(1, -1).split("."))})`;
  }
  if (t.type === "number") return `${v}px`;
  return String(v);
}

/**
 * CSS custom properties. Default mode lands in `:root`; every other mode gets
 * a `[data-theme="<mode>"]` block overriding the changed values.
 */
export function toCss(
  collections: NeutralCollection[],
  opts: { selector?: string } = {},
): string {
  const selector = opts.selector ?? ":root";
  const byMode = new Map<string, string[]>();
  const defaults: string[] = [];
  for (const c of collections) {
    for (const t of c.tokens) {
      const name = `--${cssSlug(t.path)}`;
      const defVal = t.valuesByMode[c.defaultMode];
      if (defVal !== undefined) defaults.push(`  ${name}: ${cssValue(t, defVal)};`);
      for (const mode of c.modes) {
        if (mode === c.defaultMode) continue;
        const v = t.valuesByMode[mode];
        if (v === undefined || v === defVal) continue;
        const lines = byMode.get(mode) ?? [];
        lines.push(`  ${name}: ${cssValue(t, v)};`);
        byMode.set(mode, lines);
      }
    }
  }
  const blocks = [`${selector} {\n${defaults.join("\n")}\n}`];
  for (const [mode, lines] of byMode) {
    blocks.push(`[data-theme="${mode}"] {\n${lines.join("\n")}\n}`);
  }
  return blocks.join("\n\n") + "\n";
}

// ---- Tailwind export ----

/**
 * Minimal Tailwind theme extension: color tokens → theme.extend.colors
 * (nested by path), number tokens → theme.extend.spacing ("Npx"). Strings
 * and booleans have no Tailwind slot and are skipped (reported by caller).
 */
export function toTailwind(
  collections: NeutralCollection[],
  opts: { mode?: string } = {},
): { content: string; skipped: string[] } {
  const colors: DtcgNode = {};
  const spacing: Record<string, string> = {};
  const skipped: string[] = [];
  for (const c of collections) {
    const mode = opts.mode && c.modes.includes(opts.mode) ? opts.mode : c.defaultMode;
    for (const t of c.tokens) {
      const v = t.valuesByMode[mode] ?? t.valuesByMode[c.defaultMode];
      if (v === undefined || isAliasRef(v)) {
        if (isAliasRef(v)) skipped.push(t.path.join("/"));
        continue;
      }
      if (t.type === "color") {
        insertLeaf(colors, t.path, { $type: "color", $value: v } as DtcgLeaf);
      } else if (t.type === "number") {
        spacing[cssSlug(t.path)] = `${v}px`;
      } else {
        skipped.push(t.path.join("/"));
      }
    }
  }
  // Strip the DTCG leaf wrappers down to plain values for the config.
  const plain = (n: DtcgNode): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(n)) {
      out[k] = "$value" in v ? (v as DtcgLeaf).$value : plain(v as DtcgNode);
    }
    return out;
  };
  const config = {
    theme: { extend: { colors: plain(colors), spacing } },
  };
  return {
    content: `module.exports = ${JSON.stringify(config, null, 2)};\n`,
    skipped,
  };
}

// ---- DTCG import (parse) ----

export interface FlatToken {
  path: string[];
  name: string;
  type: TokenType;
  value: TokenScalar;
  /** Set when $value is an alias reference "{a.b}". */
  aliasTo?: string[];
}

function inferDtcgType(v: TokenScalar): TokenType {
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  return /^#([0-9a-f]{3,8})$/i.test(v.trim()) ? "color" : "string";
}

/**
 * Flatten a DTCG-ish tree into tokens. A node is a leaf when it carries
 * $value; group keys become path segments. Unknown $type falls back to
 * inference from the value.
 */
export function parseDtcg(tree: unknown, basePath: string[] = []): FlatToken[] {
  const out: FlatToken[] = [];
  if (!tree || typeof tree !== "object" || Array.isArray(tree)) return out;
  for (const [key, node] of Object.entries(tree as Record<string, unknown>)) {
    if (key.startsWith("$")) continue;
    if (!node || typeof node !== "object" || Array.isArray(node)) continue;
    const obj = node as Record<string, unknown>;
    if ("$value" in obj) {
      const raw = obj.$value as TokenScalar;
      const declared = obj.$type;
      const type: TokenType =
        declared === "color" || declared === "number" || declared === "string" || declared === "boolean"
          ? declared
          : typeof declared === "string" && declared === "dimension"
            ? "number"
            : inferDtcgType(raw);
      const path = [...basePath, key];
      const token: FlatToken = { path, name: path.join("/"), type, value: raw };
      if (isAliasRef(raw)) {
        token.aliasTo = String(raw).trim().slice(1, -1).split(".");
      }
      out.push(token);
    } else {
      out.push(...parseDtcg(obj, [...basePath, key]));
    }
  }
  return out;
}
