/**
 * figma_write executor.
 *
 * Runs the caller's modern-ES JavaScript inside a Node `vm` context. The
 * context exposes:
 *   - `figma`  — a proxy whose camelCase methods map to snake_case protocol
 *                ops and each perform ONE bridge round-trip (a Promise).
 *   - `state`  — the persistent per-session object (survives figma_write calls).
 *   - `console`— captured (log/info/warn/error) and returned to the caller.
 *   - standard globals (Math, JSON, Object, Array, Promise, Date, ...).
 * Banned: require, process, fetch, setTimeout/setInterval, eval, Function.
 *
 * The vm timeout (VM_TIMEOUT_MS) is a *whole-program* budget and must never
 * fire before an in-flight bridge op — the bridge owns per-op timeouts. We run
 * the code with a generous vm timeout only as a guard against pure-CPU
 * infinite loops in the user code itself; bridge waits are async and not
 * counted by vm's synchronous timeout.
 *
 * figma.batch(ops) is special: it splits into BATCH_CHUNK_SIZE chunks streamed
 * sequentially, each chunk a separate bridge dispatch. Progress resets the
 * timeout; per-item try/catch on the plugin side yields exact per-index errors;
 * partial results are committed (no rollback).
 */
import vm from "node:vm";
import {
  BATCH_CHUNK_SIZE,
  OP_TIMEOUTS,
  VM_TIMEOUT_MS,
  type AnyOperation,
  type BridgeResponse,
  type Operation,
} from "../shared/protocol.js";
import { ErrorCode, OpError } from "./errors.js";
import type { Session } from "./session.js";
import { validateOperation, isReadOp } from "./validate.js";
import { loadIconSvg, searchIcons as searchIconsSvc, type Fetcher, type IconLibrary } from "./icons.js";

/**
 * A single op runner: validate → dispatch → unwrap. This IS the leader-direct
 * path. index.ts builds it around the bridge; the executor calls it for every
 * figma.* method so validation is never skipped. Accepts server ops too
 * (list_channels) — index.ts answers those from bridge state.
 */
export type OpRunner = (op: AnyOperation, params: Record<string, unknown>) => Promise<BridgeResponse>;

export interface ExecutorDeps {
  runOp: OpRunner;
  /** Injectable for tests — real icon fetch is server-side over the CDN. */
  iconFetcher?: Fetcher;
  /** Injectable for tests — resolves an image URL to base64 bytes. */
  imageFetcher?: (url: string) => Promise<string>;
}

export interface WriteResult {
  ok: boolean;
  result?: unknown;
  logs: string[];
  warnings: string[];
  error?: { code: ErrorCode; message: string; hint?: string };
}

/** camelCase sandbox method → snake_case protocol op. */
const METHOD_TO_OP: Record<string, AnyOperation> = {
  create: "create",
  modify: "modify",
  delete: "delete",
  del: "delete",
  clone: "clone",
  move: "move",
  resize: "resize",
  group: "group",
  ungroup: "ungroup",
  flatten: "flatten",
  batch: "batch",
  findComponent: "find_component",
  findOrCreateComponent: "find_or_create_component",
  instantiate: "instantiate",
  createVariants: "create_variants",
  arrangeComponentSet: "arrange_component_set",
  setComponentDescription: "set_component_description",
  componentize: "componentize",
  setupTokens: "setup_tokens",
  applyVariable: "apply_variable",
  createVariable: "create_variable",
  updateVariable: "update_variable",
  renameVariable: "rename_variable",
  deleteVariable: "delete_variable",
  exportTokens: "export_tokens",
  importTokens: "import_tokens",
  setText: "set_text",
  loadImage: "load_image",
  createPage: "create_page",
  setCurrentPage: "set_current_page",
  overlay: "create_overlay",
  zoomToFit: "zoom_to_fit",
  setSelection: "set_selection",
  // Edit-in-place composite write ops (business logic lives in the plugin).
  getInstanceOverrides: "get_instance_overrides",
  setInstanceOverrides: "set_instance_overrides",
  detachInstance: "detach_instance",
  resetInstanceOverrides: "reset_instance_overrides",
  setSelectionColors: "set_selection_colors",
  setGradient: "set_gradient",
  setEffects: "set_effects",
  // read ops usable from write code
  readSelection: "read_selection",
  getNodeById: "get_node",
  getNode: "get_node",
  getNodes: "get_nodes",
  getChildren: "get_children" as Operation, // handled specially below
  getDocumentInfo: "get_document_info",
  getSelection: "get_selection",
  getDesignContext: "get_design_context",
  searchNodes: "search_nodes",
  scanTextNodes: "scan_text_nodes",
  scanNodesByTypes: "scan_nodes_by_types",
  getStyles: "get_styles",
  getVariables: "get_variables",
  getComponents: "get_components",
  getComponent: "get_component",
  getLibraryComponent: "get_library_component",
  getDesignSystemKit: "get_design_system_kit",
  generateDesignMd: "generate_design_md",
  screenshot: "screenshot",
  exportNode: "export_node",
  getFonts: "get_fonts",
  layoutAudit: "layout_audit",
  currentPage: "get_document_info", // convenience; returns doc/page info
  // Server-answered (never hits the plugin): connected Figma windows.
  listChannels: "list_channels",
};

/**
 * Race a promise against a wall-clock deadline. The vm's synchronous timeout
 * cannot catch an awaited promise that never settles (e.g. `new Promise(()=>{})`),
 * so we enforce the same budget on the async path here and fail with a clean,
 * in-budget PLUGIN_TIMEOUT instead of hanging until the MCP transport drops.
 */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new OpError(
          ErrorCode.PLUGIN_TIMEOUT,
          `figma_write exceeded the ${ms}ms budget (async operation never completed).`,
          "An awaited promise never resolved (e.g. a bridge op that stalled, or a Promise that never settles). Split the work across calls, or ensure every await eventually resolves.",
        ),
      );
    }, ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer)) as Promise<T>;
}

export async function executeWrite(code: string, session: Session, deps: ExecutorDeps): Promise<WriteResult> {
  const logs: string[] = [];
  const warnings: string[] = [];

  const console_ = {
    log: (...a: unknown[]) => logs.push(fmt(a)),
    info: (...a: unknown[]) => logs.push(fmt(a)),
    warn: (...a: unknown[]) => logs.push(`WARN: ${fmt(a)}`),
    error: (...a: unknown[]) => logs.push(`ERROR: ${fmt(a)}`),
    debug: (...a: unknown[]) => logs.push(fmt(a)),
  };

  const figma = buildFigmaProxy(session, deps, warnings);

  // Explicit, minimal global surface. Anything not listed is undefined in the
  // sandbox. Banned APIs are set to throwing stubs so the error is legible.
  const banned = (name: string) => () => {
    throw new OpError(
      ErrorCode.SANDBOX_ERROR,
      `"${name}" is not available in figma_write.`,
      "Sandbox bans require/process/fetch/timers/eval. Use figma.* ops and plain JS only.",
    );
  };

  // IMPORTANT: do NOT inject host built-ins (Object, Array, Function, …) into the
  // sandbox. A vm context is its own realm and already provides all standard
  // globals from THAT realm; injecting the host's versions was the root cause of
  // the sandbox escape — `({}).constructor.constructor` then resolved to the
  // HOST Function, which can read the real `process`/`process.env`. By leaving
  // built-ins to the context realm, the Function constructor reachable via any
  // prototype chain is the sandbox realm's, which has no `process`/`require`.
  // We only inject non-standard globals (figma/state/console) and throwing stubs
  // for the Node host APIs that a fresh realm would otherwise expose.
  const sandbox: Record<string, unknown> = {
    figma,
    state: session.state,
    console: console_,
    // banned host APIs (these exist in a Node vm realm unless shadowed)
    require: banned("require"),
    process: banned("process"),
    fetch: banned("fetch"),
    setTimeout: banned("setTimeout"),
    setInterval: banned("setInterval"),
    setImmediate: banned("setImmediate"),
    eval: banned("eval"),
    Function: banned("Function"),
    globalThis: undefined,
  };

  const context = vm.createContext(sandbox, { name: "figma_write" });

  // Wrap user code in an async IIFE so top-level await + returns work; capture
  // its resolved value as `result`. Strict mode makes a bare call's `this`
  // undefined. Combined with not injecting host built-ins (see sandbox above),
  // `this.constructor.constructor` / `({}).constructor.constructor` resolve to
  // the CONTEXT realm's Function — which has no host process/require — instead
  // of the host realm's.
  const wrapped = `(async function () {\n"use strict";\n${code}\n}).call(undefined)`;

  session.writeCount++;

  let script: vm.Script;
  try {
    script = new vm.Script(wrapped, { filename: "figma_write.js" });
  } catch (err) {
    return {
      ok: false,
      logs,
      warnings,
      error: {
        code: ErrorCode.SANDBOX_ERROR,
        message: `Syntax error in figma_write code: ${(err as Error).message}`,
        hint: "Fix the JavaScript syntax. Modern ES (?., ??, spread, async/await) is supported.",
      },
    };
  }

  try {
    // vm.timeout only guards SYNCHRONOUS CPU loops. The code is an async IIFE,
    // so runInContext returns a Promise immediately and the real wait happens at
    // `await`. A body like `await new Promise(()=>{})` never resolves and never
    // burns CPU, so vm.timeout can't fire — previously this hung ~150s until the
    // MCP transport gave up, which dropped the plugin and wiped session state.
    // Race the awaited result against an explicit async deadline so a hung write
    // fails cleanly and in-budget instead of taking down the connection.
    const runResult = script.runInContext(context, { timeout: VM_TIMEOUT_MS }) as Promise<unknown>;
    const result = await withDeadline(runResult, VM_TIMEOUT_MS);
    return { ok: true, result: safeSerialize(result), logs, warnings };
  } catch (err) {
    if (err instanceof OpError) {
      return { ok: false, logs, warnings, error: { code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) } };
    }
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = /Script execution timed out/i.test(message);
    return {
      ok: false,
      logs,
      warnings,
      error: {
        code: isTimeout ? ErrorCode.PLUGIN_TIMEOUT : ErrorCode.SANDBOX_ERROR,
        message: isTimeout ? `figma_write exceeded the ${VM_TIMEOUT_MS}ms budget.` : message,
        hint: isTimeout
          ? "Split the work across multiple figma_write calls or use figma.batch() for many similar ops."
          : "The error is from your code or a figma op — check the message and figma_docs(section=\"api\").",
      },
    };
  }
}

function buildFigmaProxy(session: Session, deps: ExecutorDeps, warnings: string[]): Record<string, unknown> {
  const call = async (op: AnyOperation, params: Record<string, unknown>): Promise<unknown> => {
    maybeNudgePalette(op, params, session, warnings);
    const res = await deps.runOp(op, params);
    if (res.warnings?.length) warnings.push(...res.warnings);
    if (!res.ok) {
      const e = res.error ?? { code: ErrorCode.INTERNAL, message: `Operation ${op} failed.` };
      throw new OpError(e.code, e.message, e.hint);
    }
    return res.result;
  };

  const proxy: Record<string, unknown> = {};

  // Sentinel matching the serializer's "mixed" marker, so sandbox code can
  // write `if (node.fontSize === figma.mixed)` like the official plugin API.
  // (Previously undefined, which made `x === figma.mixed` true for every
  // missing property — a lie generator.)
  proxy["mixed"] = "mixed";

  for (const [method, op] of Object.entries(METHOD_TO_OP)) {
    if (method === "batch") continue; // custom below
    if (method === "getChildren") {
      // No dedicated op; derive from get_node's children in the plugin. We
      // forward a get_node with { includeChildren: true } convention and
      // return the children ARRAY (not the {node, children} wrapper) so
      // `for (const kid of await figma.getChildren(id))` just works.
      proxy[method] = async (nodeId: string) => {
        const res = (await call("get_node", { nodeId, includeChildren: true })) as
          | { children?: unknown[] }
          | undefined;
        return flattenNodes(res?.children ?? []);
      };
      continue;
    }
    if (method === "getNode" || method === "getNodeById") {
      // get_node returns { node, children? }; unwrap to the flat node object
      // (with width/height aliases and children merged in) so sandbox code
      // can read `n.name` / `n.width` like the official plugin API instead
      // of unwrapping a transport envelope.
      proxy[method] = async (...args: unknown[]) => {
        const res = (await call("get_node", argsToParams("get_node", args))) as
          | { node?: Record<string, unknown>; children?: unknown[] }
          | undefined;
        if (!res?.node) return res;
        const flat = flattenNode(res.node);
        if (res.children) flat.children = flattenNodes(res.children);
        return flat;
      };
      continue;
    }
    if (method === "currentPage") {
      proxy[method] = async () => call("get_document_info", { scope: "page" });
      continue;
    }
    proxy[method] = async (...args: unknown[]) => call(op, argsToParams(op, args));
  }

  // batch: chunked streaming with partial commit + exact per-index errors.
  // Optional opts.resultDetail:"ids" trims each successful item's result to
  // just its node id — for large create batches where the agent only needs the
  // ids back, this avoids echoing a full serialized node per item.
  proxy["batch"] = async (
    ops: Array<{ op: string; params: Record<string, unknown> }>,
    opts: { resultDetail?: "full" | "ids" } = {},
  ) => runBatch(ops, deps, warnings, opts.resultDetail === "ids" ? "ids" : "full");

  // setupTokens: run the plugin op, then cache the resulting token map into
  // session.state.tokens so later figma_write calls can look tokens up by name
  // without re-declaring them — the behaviour the docs promise. The plugin
  // owns the Figma Variables; state.tokens is the in-session convenience map.
  proxy["setupTokens"] = async (tokensJson: Record<string, unknown>) => {
    const result = (await call("setup_tokens", { tokens: tokensJson })) as
      | Record<string, unknown>
      | undefined;
    const existing =
      (session.state.tokens as Record<string, unknown> | undefined) ?? {};
    const map = mergeTokenMap(existing, tokensJson, result);
    session.state.tokens = map;
    return result;
  };

  // Icons: searchIcons is server-side (no fetch); loadIcon fetches the SVG
  // server-side, then forwards the load_icon op to the plugin with `svg`.
  proxy["searchIcons"] = (query: string) => searchIconsSvc(query);
  proxy["loadIcon"] = async (name: string, opts: { library?: IconLibrary; size?: number; color?: string; parentId?: string } = {}) => {
    const loaded = await loadIconSvg(name, {
      ...(opts.library ? { library: opts.library } : {}),
      ...(deps.iconFetcher ? { fetcher: deps.iconFetcher } : {}),
    });
    return call("load_icon", {
      name,
      canonical: loaded.canonical,
      library: loaded.library,
      svg: loaded.svg,
      ...(opts.size !== undefined ? { size: opts.size } : {}),
      ...(opts.color !== undefined ? { color: opts.color } : {}),
      ...(opts.parentId !== undefined ? { parentId: opts.parentId } : {}),
    });
  };

  // loadImage: accept a URL (fetched server-side, like icons), a data: URI, or
  // raw base64. Previously only base64 worked and a URL crashed the plugin with
  // a cryptic atob() error; now the server resolves the URL to base64 before
  // forwarding, matching the documented loadImage(url|base64) contract.
  proxy["loadImage"] = async (
    source: string,
    opts: Record<string, unknown> = {},
  ) => {
    if (typeof source !== "string" || source.length === 0) {
      throw new OpError(
        ErrorCode.INVALID_PARAMS,
        "loadImage requires a URL, a data: URI, or a base64 string.",
        "Pass an https URL, a data:image/...;base64,... URI, or raw base64 bytes.",
      );
    }
    let base64: string;
    if (/^https?:\/\//i.test(source)) {
      base64 = await fetchImageAsBase64(source, deps);
    } else if (source.startsWith("data:")) {
      const comma = source.indexOf(",");
      base64 = comma >= 0 ? source.slice(comma + 1) : source;
    } else {
      base64 = source;
    }
    return call("load_image", { base64, ...opts });
  };

  // Official-plugin-API muscle memory → the sandbox equivalent. Each entry is
  // a method agents reach for reflexively; calling it explains the mapping
  // instead of dying with a bare "not a function".
  const API_MAPPINGS: Record<string, string> = {
    getNodeByIdAsync: "await figma.getNode(id)",
    createFrame: 'await figma.create({ type: "FRAME", ... })',
    createText: 'await figma.create({ type: "TEXT", characters: "...", ... })',
    createRectangle: 'await figma.create({ type: "RECTANGLE", ... })',
    createEllipse: 'await figma.create({ type: "ELLIPSE", ... })',
    createComponent: 'await figma.create({ type: "COMPONENT", ... })',
    appendChild: "pass parentId in the create() spec, or figma.move(nodeId, { parentId })",
    insertChild: "pass parentId + insertAt in the create() spec, or figma.move(nodeId, { parentId, insertAt })",
    loadFontAsync: "not needed — create/modify load fonts automatically (fontName: { family, style })",
    getLocalPaintStylesAsync: "await figma.getStyles()",
    getLocalTextStylesAsync: "await figma.getStyles()",
    notify: "console.log(...) — logs are returned to the caller",
    closePlugin: "not applicable in this sandbox",
  };

  // Unknown-method guard: `figma.somethingElse(...)` returns a function that
  // throws a descriptive, actionable error instead of the engine's bare
  // TypeError. Non-call property probes (await's `then`, JSON.stringify's
  // `toJSON`, symbols) must stay undefined so normal JS semantics hold.
  const knownMethods = Object.keys(proxy).filter((k) => typeof proxy[k] === "function");
  return new Proxy(proxy, {
    get(target, prop, receiver) {
      if (typeof prop === "symbol" || prop in target) {
        return Reflect.get(target, prop, receiver);
      }
      if (prop === "then" || prop === "toJSON" || prop === "constructor" || prop === "inspect") {
        return undefined;
      }
      const name = String(prop);
      const mapped = API_MAPPINGS[name];
      const close = nearestMethods(name, knownMethods);
      return () => {
        throw new OpError(
          ErrorCode.SANDBOX_ERROR,
          `figma.${name} is not a sandbox method.`,
          mapped
            ? `In this sandbox use: ${mapped}.`
            : `${close.length ? `Did you mean: ${close.join(", ")}? ` : ""}See figma_docs(section="api") for the full method list.`,
        );
      };
    },
  }) as unknown as Record<string, unknown>;
}

/** Cheap fuzzy match: known methods sharing a prefix or substring with `name`. */
function nearestMethods(name: string, known: string[]): string[] {
  const lower = name.toLowerCase();
  const scored = known
    .map((k) => {
      const kl = k.toLowerCase();
      let score = 0;
      if (kl === lower) score = 100;
      else if (kl.includes(lower) || lower.includes(kl)) score = 50;
      else {
        // shared prefix length
        let i = 0;
        while (i < Math.min(kl.length, lower.length) && kl[i] === lower[i]) i++;
        score = i >= 4 ? i : 0;
      }
      return { k, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, 3).map((s) => s.k);
}

/**
 * Build the in-session token map (name → { value, variableId? }) the docs
 * promise at state.tokens. Values come from the input tokensJson; variable ids
 * come from the plugin result when present. Merges with any existing map so
 * repeated setupTokens calls accumulate.
 */
function mergeTokenMap(
  existing: Record<string, unknown>,
  tokensJson: Record<string, unknown>,
  _result: unknown,
): Record<string, unknown> {
  const map: Record<string, unknown> = { ...existing };
  for (const group of ["colors", "numbers", "strings"]) {
    const entries = (tokensJson as Record<string, unknown>)[group];
    if (entries && typeof entries === "object") {
      for (const [name, value] of Object.entries(entries as Record<string, unknown>)) {
        map[name] = value;
      }
    }
  }
  return map;
}

/** Fetch an image URL and return its base64 body. An optional imageFetcher on
 * deps lets tests supply bytes without hitting the network. */
async function fetchImageAsBase64(url: string, deps: ExecutorDeps): Promise<string> {
  try {
    if (deps.imageFetcher) return await deps.imageFetcher(url);
    const res = await (globalThis.fetch as unknown as (u: string) => Promise<Response>)(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.toString("base64");
  } catch (e) {
    throw new OpError(
      ErrorCode.INVALID_PARAMS,
      `Could not fetch image from URL: ${(e as Error).message}`,
      "Check the URL is reachable and points at an image, or pass base64 bytes directly.",
    );
  }
}

/**
 * Map positional call args to the op's params object. Most write ops take a
 * single object spec; the mutation ops take (nodeId, props-ish). Validation in
 * validateOperation is the authority — this only shapes ergonomics.
 */
function argsToParams(op: AnyOperation, args: unknown[]): Record<string, unknown> {
  const first = args[0];
  const second = args[1];
  switch (op) {
    case "modify":
      return { nodeId: first, props: second };
    case "delete":
      return isObj(first) ? (first as Record<string, unknown>) : { nodeId: first, ...(isObj(second) ? (second as object) : {}) };
    case "clone":
    case "move":
    case "resize":
    case "ungroup":
    case "flatten":
    case "zoom_to_fit":
    case "layout_audit":
    case "export_node":
    case "arrange_component_set":
    case "componentize":
      return { nodeId: first, ...(isObj(second) ? (second as object) : {}) };
    case "get_node":
      return { nodeId: first, ...(isObj(second) ? (second as object) : {}) };
    case "get_nodes":
      return { nodeIds: first };
    case "get_component":
      return isObj(first) ? (first as Record<string, unknown>) : { componentId: first };
    case "get_library_component":
      return isObj(first) ? (first as Record<string, unknown>) : { key: first };
    case "detach_instance":
    case "reset_instance_overrides":
      // (idOrIds) or ({nodeId|nodeIds, ...})
      return Array.isArray(first)
        ? { nodeIds: first }
        : isObj(first)
          ? (first as Record<string, unknown>)
          : { nodeId: first };
    case "set_text":
      return { nodeId: first, content: second };
    case "set_component_description":
      // setComponentDescription(nodeId, "text") or (nodeId, {description, documentationLinks})
      return isObj(second)
        ? { nodeId: first, ...(second as object) }
        : { nodeId: first, description: second };
    case "apply_variable":
      return { nodeId: first, field: second, tokenName: args[2] };
    case "instantiate":
      // instantiate(idOrName, opts) or instantiate({component|query|componentId, ...}, opts)
      return isObj(first)
        ? { ...(first as Record<string, unknown>), ...(isObj(second) ? (second as object) : {}) }
        : { componentId: first, ...(isObj(second) ? (second as object) : {}) };
    case "create_variants":
      return { baseSpec: first, variants: second };
    case "find_component":
      return isObj(first) ? (first as Record<string, unknown>) : { query: first };
    case "find_or_create_component":
      // findOrCreateComponent(name, spec, {dryRun, threshold})
      return { name: first, spec: second, ...(isObj(args[2]) ? (args[2] as object) : {}) };
    case "setup_tokens":
      return isObj(first) ? (first as Record<string, unknown>) : { tokens: first };
    case "create_variable":
      // createVariable(name, valueOrOpts) or createVariable({name, ...})
      return isObj(first)
        ? { ...(first as Record<string, unknown>), ...(isObj(second) ? (second as object) : {}) }
        : { name: first, ...(isObj(second) ? (second as object) : { value: second }) };
    case "update_variable":
    case "delete_variable":
      // (nameOrId, opts) or ({variable, ...})
      return isObj(first)
        ? (first as Record<string, unknown>)
        : { variable: first, ...(isObj(second) ? (second as object) : {}) };
    case "rename_variable":
      return isObj(first)
        ? (first as Record<string, unknown>)
        : { variable: first, newName: second };
    case "export_tokens":
      // exportTokens("css") or exportTokens({format, collection, mode, ...})
      return isObj(first) ? (first as Record<string, unknown>) : first !== undefined ? { format: first } : {};
    case "import_tokens":
      // importTokens(tree, opts) or importTokens({tokens|modes, ...})
      return isObj(first) && ("tokens" in (first as object) || "modes" in (first as object) || "dtcg" in (first as object))
        ? { ...(first as Record<string, unknown>), ...(isObj(second) ? (second as object) : {}) }
        : { tokens: first, ...(isObj(second) ? (second as object) : {}) };
    case "create_page":
      return isObj(first) ? (first as Record<string, unknown>) : { name: first };
    case "set_current_page":
      return isObj(first) ? (first as Record<string, unknown>) : { pageId: first };
    case "load_image":
      return isObj(first) ? (first as Record<string, unknown>) : { source: first };
    case "group":
      return isObj(first) ? (first as Record<string, unknown>) : { nodeIds: first };
    case "search_nodes":
      return isObj(first) ? (first as Record<string, unknown>) : { query: first };
    // Edit-in-place composite ops — keep the (targetish, opts) ergonomics.
    case "get_instance_overrides":
      // getInstanceOverrides(nodeId?) → {nodeId?} (omit when absent).
      return isObj(first)
        ? (first as Record<string, unknown>)
        : first === undefined
          ? {}
          : { nodeId: first };
    case "set_instance_overrides":
      // setInstanceOverrides(sourceId, targetIds) → {sourceId, targetIds}.
      return isObj(first) ? (first as Record<string, unknown>) : { sourceId: first, targetIds: second };
    case "set_selection_colors":
      // setSelectionColors(nodeId, opts) → {nodeId, ...opts}. nodeId is
      // optional (defaults to current selection), so a single object arg is
      // treated as the opts bag directly.
      return isObj(first)
        ? (first as Record<string, unknown>)
        : { nodeId: first, ...(isObj(second) ? (second as object) : {}) };
    case "set_gradient":
      // setGradient(nodeId, opts) → {nodeId, ...opts}.
      return { nodeId: first, ...(isObj(second) ? (second as object) : {}) };
    case "set_effects":
      // setEffects(nodeId, effects) → {nodeId, effects}.
      return { nodeId: first, effects: second };
    case "create":
    case "create_overlay": {
      // create(spec) — but also tolerate the natural two-arg shape
      // create(spec, parentId) that agents write reflexively (mirrors
      // parent.appendChild(node) muscle memory). Silently dropping args[1]
      // was how an entire screen's children landed flat on the page.
      const spec = isObj(first) ? { ...(first as Record<string, unknown>) } : {};
      if (spec.parentId === undefined) {
        if (typeof second === "string" && second.length > 0) {
          spec.parentId = second;
        } else if (isObj(second) && typeof (second as Record<string, unknown>).id === "string") {
          // create(spec, nodeObject) — the result of a prior create().
          spec.parentId = (second as Record<string, unknown>).id;
        }
      }
      return spec;
    }
    default:
      // screenshot, get_* etc → single object spec (or {})
      return isObj(first) ? (first as Record<string, unknown>) : first === undefined ? {} : { value: first };
  }
}

/**
 * Split ops into chunks of BATCH_CHUNK_SIZE and stream each chunk as its own
 * bridge dispatch. Results are collected per original index; a failing item
 * does NOT abort the batch (partial commit) — its error is recorded at its
 * exact index.
 */
async function runBatch(
  ops: Array<{ op: string; params: Record<string, unknown> }>,
  deps: ExecutorDeps,
  warnings: string[],
  resultDetail: "full" | "ids" = "full",
): Promise<{ total: number; ok: number; failed: number; results: Array<{ index: number; ok: boolean; result?: unknown; error?: { code: ErrorCode; message: string; hint?: string } }> }> {
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new OpError(ErrorCode.INVALID_PARAMS, "batch() requires a non-empty array of { op, params }.", "Pass e.g. [{ op: \"create\", params: {...} }, ...].");
  }

  // Validate every item up-front through the choke point. A bad item fails
  // just that index; the rest still run.
  const validated: Array<{ index: number; op: AnyOperation; params: Record<string, unknown>; error?: OpError }> = ops.map((item, index) => {
    try {
      const v = validateOperation(item.op, item.params);
      return { index, op: v.op, params: v.params };
    } catch (err) {
      return { index, op: item.op as Operation, params: item.params, error: err as OpError };
    }
  });

  const results: Array<{ index: number; ok: boolean; result?: unknown; error?: { code: ErrorCode; message: string; hint?: string } }> = [];
  const total = ops.length;

  for (let start = 0; start < validated.length; start += BATCH_CHUNK_SIZE) {
    const chunkItems = validated.slice(start, start + BATCH_CHUNK_SIZE);
    const chunkIndex = Math.floor(start / BATCH_CHUNK_SIZE);
    const chunkTotal = Math.ceil(validated.length / BATCH_CHUNK_SIZE);

    // Items that already failed validation get their error recorded without a
    // round-trip; the rest are dispatched as one chunk to the plugin.
    const runnable = chunkItems.filter((it) => !it.error);
    for (const bad of chunkItems.filter((it) => it.error)) {
      results.push({ index: bad.index, ok: false, error: bridgeErr(bad.error as OpError) });
    }

    if (runnable.length === 0) continue;

    const res = await deps.runOp("batch", {
      ops: runnable.map((it) => ({ op: it.op, params: it.params })),
      chunk: { index: chunkIndex, total: chunkTotal },
    });
    if (res.warnings?.length) warnings.push(...res.warnings);

    if (!res.ok) {
      // Whole-chunk transport failure → mark every runnable item in this chunk
      // failed at its exact original index (partial commit of prior chunks
      // stands).
      const e = res.error ?? { code: ErrorCode.INTERNAL, message: "batch chunk failed" };
      for (const it of runnable) {
        results.push({ index: it.index, ok: false, error: { code: e.code, message: e.message, ...(e.hint ? { hint: e.hint } : {}) } });
      }
      continue;
    }

    // Plugin returns per-item outcomes in chunk order; map back to original idx.
    const items = (res.result as { items?: Array<{ ok: boolean; result?: unknown; error?: { code: ErrorCode; message: string; hint?: string } }> } | undefined)?.items ?? [];
    runnable.forEach((it, i) => {
      const out = items[i];
      if (out && out.ok) {
        results.push({ index: it.index, ok: true, result: resultDetail === "ids" ? trimToId(out.result) : out.result });
      } else if (out) {
        results.push({ index: it.index, ok: false, error: out.error ?? { code: ErrorCode.INTERNAL, message: "batch item failed" } });
      } else {
        results.push({ index: it.index, ok: false, error: { code: ErrorCode.INTERNAL, message: "no result for batch item", hint: "Plugin returned fewer items than sent." } });
      }
    });
  }

  results.sort((a, b) => a.index - b.index);
  const okCount = results.filter((r) => r.ok).length;
  return { total, ok: okCount, failed: total - okCount, results };
}

function bridgeErr(e: OpError): { code: ErrorCode; message: string; hint?: string } {
  return { code: e.code, message: e.message, ...(e.hint ? { hint: e.hint } : {}) };
}

/**
 * Reduce a batch item's result to just its id (resultDetail:"ids"). Most write
 * ops return { id, node: {...} }; keep only the id, falling back to the raw
 * value when there is no id to extract.
 */
function trimToId(result: unknown): unknown {
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (typeof r.id === "string") return { id: r.id };
    const node = r.node as Record<string, unknown> | undefined;
    if (node && typeof node.id === "string") return { id: node.id };
  }
  return result;
}

function isObj(v: unknown): v is object {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * One-shot per session: the first create that paints with LITERAL colors while
 * the session has no design tokens gets a warning telling the agent to reuse
 * the file's variables (figma_rules) or propose a palette to the user and
 * setupTokens it. Observed live: without this, agents hardcode a guessed
 * palette and every screen drifts. Fires once — it is a nudge, not nagging.
 */
function maybeNudgePalette(
  op: AnyOperation,
  params: Record<string, unknown>,
  session: Session,
  warnings: string[],
): void {
  if (session.paletteNudged) return;
  if (op !== "create" && op !== "create_overlay") return;
  const paintsLiteral =
    params["fills"] !== undefined || params["fill"] !== undefined || params["strokes"] !== undefined;
  if (!paintsLiteral) return;
  const tokens = session.state["tokens"];
  const hasTokens = isObj(tokens) && Object.keys(tokens as object).length > 0;
  if (hasTokens) return;
  session.paletteNudged = true;
  warnings.push(
    "First draw with literal colors and no session tokens. If this file has variables/styles, read figma_rules and reuse them (applyVariable). If it has none, propose a small palette to the user (primary/surface/text/muted/border), then figma.setupTokens({colors:{...}}) so all screens share one system. A design.md in the codebase, if present, is the source of truth. (Shown once per session.)",
  );
}

/**
 * Make a serialized node ergonomic for sandbox code: keep the wire keys
 * (w/h) AND provide the official-API aliases (width/height) so both
 * `n.w` and `n.width` read the same number.
 */
function flattenNode(node: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...node };
  if (typeof out.w === "number" && out.width === undefined) out.width = out.w;
  if (typeof out.h === "number" && out.height === undefined) out.height = out.h;
  return out;
}

function flattenNodes(nodes: unknown[]): Record<string, unknown>[] {
  return nodes.filter(isObj).map((n) => flattenNode(n as Record<string, unknown>));
}

function fmt(args: unknown[]): string {
  return args
    .map((a) => (typeof a === "string" ? a : safeStringify(a)))
    .join(" ");
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Ensure the returned value crosses the vm boundary as plain JSON data. */
function safeSerialize(v: unknown): unknown {
  if (v === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return String(v);
  }
}

export { isReadOp };
