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

/**
 * A token's path can be a strict prefix of another's — "color/brand" and
 * "color/brand/deep" are both legal variable names. DTCG has no node that is
 * a group AND a token, so the leaf's $-fields fold ONTO the group: the node
 * keeps its children and also carries $value. Both tokens survive, in
 * whichever order they arrive, and `parseDtcg` reads the merged node back as
 * two tokens again.
 */
function insertLeaf(root: DtcgNode, path: string[], leaf: DtcgLeaf): void {
  let cur = root;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i]!;
    const next = cur[seg];
    if (!next) {
      cur[seg] = {};
    }
    // `next` may already be a leaf (the shorter token path landed first):
    // descend anyway, so the group gains children beside $value instead of
    // the token being overwritten by an empty group.
    cur = cur[seg] as DtcgNode;
  }
  const last = path[path.length - 1]!;
  const existing = cur[last];
  if (existing && !("$value" in existing)) {
    // The group was here first — keep its children and add the token's own.
    Object.assign(existing, leaf);
  } else {
    cur[last] = leaf;
  }
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
  // When tokens nest under collection names, a bare "{a.b}" ref points at the
  // root where nothing lives — and two collections can define the same path,
  // making it ambiguous besides. Qualify each alias with the collection that
  // owns the target: the token's own first, the one other collection that has
  // the path otherwise. An alias no collection holds stays as written.
  const pathsByCollection = new Map<string, Set<string>>();
  if (nest) {
    for (const c of collections) {
      pathsByCollection.set(
        c.name,
        new Set(c.tokens.map((t) => t.path.join("/"))),
      );
    }
  }
  const qualifyAlias = (v: TokenScalar, c: NeutralCollection): TokenScalar => {
    if (!isAliasRef(v)) return v;
    const ref = String(v).trim().slice(1, -1);
    const key = ref.split(".").join("/");
    const owner = pathsByCollection.get(c.name)?.has(key)
      ? c.name
      : collections.find((o) => pathsByCollection.get(o.name)?.has(key))?.name;
    return owner ? `{${owner}.${ref}}` : v;
  };
  for (const c of collections) {
    const mode = opts.mode && c.modes.includes(opts.mode) ? opts.mode : c.defaultMode;
    for (const t of c.tokens) {
      const value = t.valuesByMode[mode] ?? t.valuesByMode[c.defaultMode];
      if (value === undefined) continue;
      const path = nest ? [c.name, ...t.path] : t.path;
      insertLeaf(root, path, {
        $type: t.type,
        $value: nest ? qualifyAlias(value, c) : value,
      });
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

/**
 * cssSlug folds different names to one string ("color/brand" and
 * "color.brand" both → color-brand), and a second write to one custom
 * property or object key silently wins. A collision gets a deterministic
 * -2/-3 suffix in declaration order.
 */
function uniqueSlug(
  path: string[],
  taken: Set<string>,
  nextN: Map<string, number>,
): string {
  const base = cssSlug(path);
  let n = nextN.get(base) ?? 1;
  let slug = base;
  while (taken.has(slug)) slug = `${base}-${++n}`;
  nextN.set(base, n);
  taken.add(slug);
  return slug;
}

function cssValue(
  t: NeutralToken,
  v: TokenScalar,
  resolve: (path: string[]) => string,
): string {
  if (isAliasRef(v)) {
    return `var(--${resolve(String(v).trim().slice(1, -1).split("."))})`;
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

  // Slugs are unique per token — see uniqueSlug — and aliases resolve through
  // the same maps, so var() still points at the renamed token.
  const slugOf = new Map<NeutralToken, string>();
  const slugByOwnerPath = new Map<string, string>();
  const slugByPath = new Map<string, string>();
  const taken = new Set<string>();
  const nextN = new Map<string, number>();
  for (const c of collections) {
    for (const t of c.tokens) {
      const slug = uniqueSlug(t.path, taken, nextN);
      slugOf.set(t, slug);
      const pathKey = t.path.join("/");
      slugByOwnerPath.set(`${c.name}/${pathKey}`, slug);
      if (!slugByPath.has(pathKey)) slugByPath.set(pathKey, slug);
    }
  }
  const resolveSlug = (c: NeutralCollection, path: string[]): string =>
    slugByOwnerPath.get(`${c.name}/${path.join("/")}`) ??
    slugByPath.get(path.join("/")) ??
    cssSlug(path);

  const byMode = new Map<string, string[]>();
  const defaults: string[] = [];
  for (const c of collections) {
    const resolve = (path: string[]): string => resolveSlug(c, path);
    for (const t of c.tokens) {
      const name = `--${slugOf.get(t)!}`;
      const defVal = t.valuesByMode[c.defaultMode];
      if (defVal !== undefined) defaults.push(`  ${name}: ${cssValue(t, defVal, resolve)};`);
      for (const mode of c.modes) {
        if (mode === c.defaultMode) continue;
        const v = t.valuesByMode[mode];
        if (v === undefined || v === defVal) continue;
        const lines = byMode.get(mode) ?? [];
        lines.push(`  ${name}: ${cssValue(t, v, resolve)};`);
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
  // Spacing keys are slugs, so the same collision applies as in CSS.
  const spacingTaken = new Set<string>();
  const spacingN = new Map<string, number>();
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
        spacing[uniqueSlug(t.path, spacingTaken, spacingN)] = `${v}px`;
      } else {
        skipped.push(t.path.join("/"));
      }
    }
  }
  // Strip the DTCG leaf wrappers down to plain values for the config.
  const plain = (n: DtcgNode): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(n)) {
      // insertLeaf can fold a leaf's $-fields onto a group (a token path that
      // prefixes another's); those keys are wrappers, not children.
      if (k.startsWith("$")) continue;
      if ("$value" in v) {
        // Tailwind spells a colour that is also a group `DEFAULT`.
        const kids = plain(v as unknown as DtcgNode);
        out[k] = Object.keys(kids).length
          ? { DEFAULT: (v as DtcgLeaf).$value, ...kids }
          : (v as DtcgLeaf).$value;
      } else {
        out[k] = plain(v as DtcgNode);
      }
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
    const path = [...basePath, key];
    if ("$value" in obj) {
      const raw = obj.$value;
      // A composite $value — a shadow object, a dimension pair, an array —
      // is not a scalar variable this importer can express. Skipping it
      // keeps one unwritable token from aborting the whole batch.
      if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
        const declared = obj.$type;
        const type: TokenType =
          declared === "color" || declared === "number" || declared === "string" || declared === "boolean"
            ? declared
            : typeof declared === "string" && declared === "dimension"
              ? "number"
              : inferDtcgType(raw);
        const token: FlatToken = { path, name: path.join("/"), type, value: raw };
        if (isAliasRef(raw)) {
          token.aliasTo = String(raw).trim().slice(1, -1).split(".");
        }
        out.push(token);
      }
    }
    // A node can be BOTH group and token — export folds a leaf's $-fields
    // onto the group when one path is a prefix of another — so keep walking
    // the children ($-keys are skipped above) rather than lose half of it.
    out.push(...parseDtcg(obj, path));
  }
  return out;
}
