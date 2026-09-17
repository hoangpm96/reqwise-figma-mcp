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
import { ErrorCode, OpError, toBridgeError } from "./errors.js";
import { assertSafeImageUrl } from "./security.js";
import type { Session } from "./session.js";
import { validateOperation, isReadOp } from "./validate.js";
import { loadIconSvg, searchIcons as searchIconsSvc, type Fetcher, type IconLibrary } from "./icons.js";
import { runUserflow } from "./userflow.js";

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
  setupTokens: "setup_tokens",
  setupTextStyles: "setup_text_styles",
  setTextStyle: "set_text_style",
  setupEffectStyles: "setup_effect_styles",
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
  deletePage: "delete_page",
  deleteStyle: "delete_style",
  deleteUnusedStyles: "delete_unused_styles",
  overlay: "create_overlay",
  zoomToFit: "zoom_to_fit",
  setSelection: "set_selection",
  // Edit-in-place composite write ops (business logic lives in the plugin).
  setSelectionColors: "set_selection_colors",
  setGradient: "set_gradient",
  setEffects: "set_effects",
  setReactions: "set_reactions",
  // Put a drawn diagram's arrows back on its boxes after they were moved.
  reflowDiagram: "reflow_diagram",
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
  designFingerprint: "design_fingerprint",
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

/**
 * Per-session serialization of figma_write calls. The sandbox snapshots
 * session.state on entry and REPLACES it on exit (__syncState), so two writes
 * running concurrently on one session each overwrite the other's mutations —
 * and mid-call host reads (setupTokens' token map) race the same way. MCP
 * tool calls run concurrently, so the chain lives here, keyed by the Session
 * object both call paths resolve through the same registry.
 */
const writeChains = new WeakMap<Session, Promise<unknown>>();

export function executeWrite(code: string, session: Session, deps: ExecutorDeps): Promise<WriteResult> {
  const prev = writeChains.get(session) ?? Promise.resolve();
  const next = prev.then(() => executeWriteInner(code, session, deps));
  // Store a rejection-proof tail so one failed write never wedges the chain.
  writeChains.set(session, next.catch(() => undefined));
  return next;
}

async function executeWriteInner(code: string, session: Session, deps: ExecutorDeps): Promise<WriteResult> {
  const logs: string[] = [];
  const warnings: string[] = [];

  // Values crossing OUT of the context (console args, the result) are
  // stringified INSIDE the context under a CPU budget — JSON.stringify runs
  // caller-supplied toJSON/getters, which on the host would be unbounded (a
  // `while(true){}` toJSON froze the server). Bound late: the context doesn't
  // exist yet. The pre-context fallback is only reachable in tests.
  let serToText: (v: unknown) => string = safeStringify;
  let serResult: (v: unknown) => unknown = (v) => {
    if (v === undefined) return undefined;
    try {
      return JSON.parse(JSON.stringify(v));
    } catch {
      return String(v);
    }
  };

  const console_ = {
    log: (...a: unknown[]) => logs.push(fmt(a, serToText)),
    info: (...a: unknown[]) => logs.push(fmt(a, serToText)),
    warn: (...a: unknown[]) => logs.push(`WARN: ${fmt(a, serToText)}`),
    error: (...a: unknown[]) => logs.push(`ERROR: ${fmt(a, serToText)}`),
    debug: (...a: unknown[]) => logs.push(fmt(a, serToText)),
  };

  // Host-side writes to session.state made DURING this call (setupTokens'
  // token map). The sandbox works on a context-realm copy of session.state
  // that is synced back on exit; overlay keys re-apply on top of that copy so
  // host-side writes survive the sync.
  const stateOverlay: Record<string, unknown> = {};
  const figmaProxy = buildFigmaProxy(session, deps, warnings, stateOverlay);

  // ---- realm-boundary design (why this looks the way it does) ----
  //
  // node:vm gives a separate REALM, not a separate trust domain: any host
  // object reachable from sandbox code hands it the host realm's Function
  // through `value.constructor.constructor`, which then reads the real
  // `process` — a full escape. Scrubbing the injected roots was not enough:
  // values that cross the boundary AT RUNTIME leak the same way — the object
  // a figma.* call resolves, the Error a failed op throws, the host Error a
  // banned-global stub throws, even the Promise a call returns. So the rule:
  //
  //   NOTHING host-realm may become reachable from user code. Only
  //   primitives (JSON strings) cross the boundary; everything else is
  //   rebuilt inside the context realm by the bootstrap below.
  //
  // - `__invoke` always resolves a JSON envelope string (never rejects, never
  //   returns objects) and is removed from the globals by the bootstrap —
  //   user code can never hold its host Promise.
  // - `figma` is rebuilt inside the context as async wrappers that `await`
  //   the bridge internally and re-throw a context-realm Error (code/hint).
  // - `state` is a JSON snapshot parsed inside the context; the wrapped IIFE
  //   syncs it back through `__syncState` in `finally`.
  // - banned globals are context stubs — a host-thrown Error would itself
  //   leak the host realm.
  // - `console` and `__syncState` are the only host values left reachable:
  //   scrubbed by the bootstrap and returning only primitives.
  const invoke = async (method: string, argsJson: string): Promise<string> => {
    try {
      // Reads go through the proxy's get-trap so unknown methods resolve to
      // the DX stub (mapped suggestion / nearest-method hint), whose thrown
      // OpError lands in the error envelope below.
      const fn = (figmaProxy as Record<string, unknown>)[method];
      if (typeof fn !== "function") {
        return JSON.stringify({
          ok: false,
          error: { code: ErrorCode.INVALID_PARAMS, message: `figma.${method} is not a function.` },
        });
      }
      const args: unknown = JSON.parse(argsJson);
      const result = await (fn as (...a: unknown[]) => unknown)(...(Array.isArray(args) ? args : [args]));
      return JSON.stringify({ ok: true, result });
    } catch (err) {
      const be = toBridgeError(err);
      return JSON.stringify({
        ok: false,
        error: { code: be.code, message: be.message, ...(be.hint ? { hint: be.hint } : {}) },
      });
    }
  };

  const syncState = (json: string): void => {
    try {
      const parsed: unknown = JSON.parse(json);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        session.state = { ...(parsed as Record<string, unknown>), ...stateOverlay };
      }
    } catch {
      /* malformed state JSON — keep the last known-good session.state */
    }
  };

  let stateJson = "{}";
  try {
    stateJson = JSON.stringify(session.state ?? {});
  } catch {
    /* unserializable prior state — this call starts from {} */
  }

  // Explicit, minimal global surface. Anything not listed is undefined in the
  // sandbox. The __-prefixed entries are bootstrap inputs consumed below;
  // figma/state and the banned globals are installed inside the context.
  const sandbox: Record<string, unknown> = {
    __invoke: invoke,
    __syncState: syncState,
    __stateData: stateJson,
    __hostFigma: figmaProxy,
    console: console_,
    figma: undefined,
    state: undefined,
    require: undefined,
    process: undefined,
    fetch: undefined,
    setTimeout: undefined,
    setInterval: undefined,
    setImmediate: undefined,
    globalThis: undefined,
    // `eval`/`Function` are intentionally NOT pre-shadowed: the bootstrap
    // needs the real context Function.prototype before installing its stubs.
  };

  const context = vm.createContext(sandbox, { name: "figma_write" });

  const bootstrap = new vm.Script(
    `(() => {
      // Capture context intrinsics BEFORE they are shadowed below.
      const CtxObjectProto = Object.prototype;
      const CtxFunctionProto = Function.prototype;
      const __inv = __invoke;
      const hostFigma = __hostFigma;
      const stateJson = __stateData;

      // Host values that must not stay reachable — a host function's return
      // value is a host object, and .constructor.constructor on any host
      // value is the HOST Function (realm escape). __syncState is the only
      // bridge left in place: the wrapper calls it in finally, it takes and
      // returns only primitives, and it is scrubbed below.
      __invoke = undefined;
      __hostFigma = undefined;
      __stateData = undefined;

      // Banned globals as context-realm stubs — a host-thrown Error would
      // itself leak the host realm.
      const ban = (name) => () => {
        const e = new Error('"' + name + '" is not available in figma_write.');
        e.code = "SANDBOX_ERROR";
        e.hint = "Sandbox bans require/process/fetch/timers/eval. Use figma.* ops and plain JS only.";
        throw e;
      };
      require = ban("require");
      process = ban("process");
      fetch = ban("fetch");
      setTimeout = ban("setTimeout");
      setInterval = ban("setInterval");
      setImmediate = ban("setImmediate");
      eval = ban("eval");
      Function = ban("Function");
      globalThis = undefined;

      // A poison constructor: '.constructor' reached on a scrubbed value
      // lands here — a context-realm function, never the host one. The scrub
      // recursion poisons Poison itself, so Poison.constructor is Poison and
      // the chain dead-ends.
      const Poison = function Poison() { throw new TypeError("blocked"); };
      const seen = new Set();
      const scrub = (v) => {
        if (v === null || (typeof v !== "object" && typeof v !== "function")) return;
        if (seen.has(v)) return;
        seen.add(v);
        // Reparent onto the context realm's prototype so the host realm is
        // unreachable through [[Prototype]].
        try { Object.setPrototypeOf(v, typeof v === "function" ? CtxFunctionProto : CtxObjectProto); } catch (_) {}
        // Own, non-configurable 'constructor' — can't be redefined away.
        try {
          Object.defineProperty(v, "constructor", {
            value: Poison, writable: false, enumerable: false, configurable: false,
          });
        } catch (_) {}
        // Recurse into EVERY object/function-valued own prop plus accessors —
        // a host object nested a level deep is the same escape hatch.
        for (const k of Object.getOwnPropertyNames(v)) {
          let d; try { d = Object.getOwnPropertyDescriptor(v, k); } catch (_) { continue; }
          if (!d) continue;
          if (d.value && (typeof d.value === "object" || typeof d.value === "function")) scrub(d.value);
          if (typeof d.get === "function") scrub(d.get);
          if (typeof d.set === "function") scrub(d.set);
        }
      };
      scrub(console);
      scrub(__syncState);
      scrub(__inv);

      // state: a context-realm copy of the session object. The wrapped IIFE
      // syncs it back to the host in 'finally' via __syncState.
      try { state = JSON.parse(stateJson || "{}"); } catch (_) { state = {}; }
      if (state === null || typeof state !== "object" || Array.isArray(state)) state = {};

      // figma: every method becomes a context-realm async wrapper around the
      // host bridge. The host Promise returned by __inv is awaited INSIDE the
      // wrapper and never reaches user code; only the resolved JSON string
      // (a primitive — no prototype chain, nothing to escape through) crosses.
      const callMethod = async (m, args) => {
        const env = JSON.parse(await __inv(m, JSON.stringify(args)));
        if (env && env.ok === true) return env.result;
        const info = (env && env.error) || {};
        const err = new Error(typeof info.message === "string" ? info.message : ("figma." + m + " failed"));
        if (typeof info.code === "string") err.code = info.code;
        if (typeof info.hint === "string") err.hint = info.hint;
        throw err;
      };
      const rebuilt = {};
      for (const name of Object.getOwnPropertyNames(hostFigma)) {
        const v = hostFigma[name];
        if (typeof v === "function") {
          rebuilt[name] = ((m) => (...args) => callMethod(m, args))(name);
        } else {
          // Data props (the "mixed" sentinel) cross as a JSON copy.
          try { rebuilt[name] = JSON.parse(JSON.stringify(v)); } catch (_) {}
        }
      }
      try {
        Object.defineProperty(rebuilt, "constructor", {
          value: Poison, writable: false, enumerable: false, configurable: false,
        });
        Object.defineProperty(state, "constructor", {
          value: Poison, writable: false, enumerable: false, configurable: false,
        });
      } catch (_) {}
      // Unknown-method trap, mirroring the host proxy's DX guard: an unknown
      // name resolves to a wrapper so the host-side stub produces the mapped,
      // actionable error. Non-call probes (then/toJSON/symbols) stay
      // undefined so normal JS semantics hold.
      figma = new Proxy(rebuilt, {
        get(t, prop) {
          if (typeof prop === "symbol") return Reflect.get(t, prop);
          const v = t[prop];
          if (v !== undefined) return v;
          if (prop === "then" || prop === "toJSON" || prop === "constructor" || prop === "inspect") {
            return undefined;
          }
          return (...args) => callMethod(String(prop), args);
        },
      });
    })();`,
    { filename: "figma_write.bootstrap.js" },
  );
  bootstrap.runInContext(context);

  // Bound the stringify of context values leaving the sandbox: a hostile
  // toJSON/getter would otherwise run unbounded on the host event loop during
  // JSON.stringify. Rebuilt per call because it needs this context.
  const serScript = new vm.Script("JSON.stringify(__serArg)", { filename: "figma_write.serialize.js" });
  const serInContext = (v: unknown): string | undefined => {
    sandbox.__serArg = v;
    try {
      const s = serScript.runInContext(context, { timeout: VM_TIMEOUT_MS });
      return typeof s === "string" ? s : undefined;
    } finally {
      sandbox.__serArg = undefined;
    }
  };
  serToText = (v: unknown): string => {
    try {
      return serInContext(v) ?? "[unserializable value]";
    } catch {
      return "[unserializable value]";
    }
  };
  serResult = (v: unknown): unknown => {
    if (v === undefined) return undefined;
    try {
      const s = serInContext(v);
      return s === undefined ? "[unserializable result]" : JSON.parse(s);
    } catch {
      return "[unserializable result]";
    }
  };

  // Wrap user code in an async IIFE so top-level await + returns work; the
  // outer try/finally syncs the mutated `state` back to the session even when
  // the code throws. Strict mode makes a bare call's `this` undefined.
  const wrapped =
    `(async function () {\n"use strict";\n` +
    `try {\nreturn await (async function () {\n${code}\n})();\n` +
    `} finally {\ntry { __syncState(JSON.stringify(state)); } catch (_) {}\n}\n` +
    `}).call(undefined)`;

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
    return { ok: true, result: serResult(result), logs, warnings };
  } catch (err) {
    if (err instanceof OpError) {
      return { ok: false, logs, warnings, error: { code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) } };
    }
    // Context-realm errors are not `instanceof Error` in the host realm —
    // read .message as a prop so the text doesn't come out "Error: ...".
    // They also carry code/hint as own props (banned-global stubs, figma.*
    // failures) — primitives, safe to read across the boundary.
    const ce = err as { code?: unknown; hint?: unknown; message?: unknown } | null;
    const message = ce && typeof ce.message === "string" ? ce.message : String(err);
    const ctxCode = ce && typeof ce.code === "string" ? (ce.code as ErrorCode) : undefined;
    const ctxHint = ce && typeof ce.hint === "string" ? ce.hint : undefined;
    const isTimeout = /Script execution timed out/i.test(message);
    return {
      ok: false,
      logs,
      warnings,
      error: {
        code: ctxCode ?? (isTimeout ? ErrorCode.PLUGIN_TIMEOUT : ErrorCode.SANDBOX_ERROR),
        message: isTimeout && ctxCode === undefined ? `figma_write exceeded the ${VM_TIMEOUT_MS}ms budget.` : message,
        hint:
          ctxHint ??
          (isTimeout
            ? "Split the work across multiple figma_write calls or use figma.batch() for many similar ops."
            : "The error is from your code or a figma op — check the message and figma_docs(section=\"api\")."),
      },
    };
  }
}

function buildFigmaProxy(
  session: Session,
  deps: ExecutorDeps,
  warnings: string[],
  stateOverlay: Record<string, unknown>,
): Record<string, unknown> {
  // One figma_write call is one placement group: when its screens have to
  // move clear of existing work, they move together and stay a row.
  const placeGroup = `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const call = async (op: AnyOperation, params: Record<string, unknown>): Promise<unknown> => {
    maybeNudgePalette(op, params, session, warnings);
    const res = await deps.runOp(op, withPlaceGroup(op, params, placeGroup));
    // Dedupe: the same safe-default warning fires on every node of a large
    // draw, and N identical copies teach the agent nothing the first one did
    // not — they just cost tokens.
    if (res.warnings?.length) {
      for (const w of res.warnings) if (!warnings.includes(w)) warnings.push(w);
    }
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
  ) =>
    runBatch(
      Array.isArray(ops) ? ops.map((o) => (o && isObj(o.params) ? { ...o, params: withPlaceGroup(o.op as AnyOperation, o.params, placeGroup) } : o)) : ops,
      deps,
      warnings,
      opts.resultDetail === "ids" ? "ids" : "full",
    );

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
    // The sandbox works on a context-realm copy of state synced back on exit;
    // record the host-side write so the sync does not lose it.
    stateOverlay["tokens"] = map;
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


  // userflow: the graph is the AGENT's analysis of the spec (screens, happy
  // path, error and edge cases). The layout runs server-side and the plugin
  // only draws; graph findings come back as warnings so the next pass can fill
  // the holes the arrows just made visible.
  proxy["userflow"] = async (spec: unknown) => {
    // `call` unwraps the bridge response, so plugin warnings land in the
    // sandbox-wide sink rather than in the value returned here. Fold whatever
    // this call added back into the result, so `figma.userflow(...)` and the
    // figma_diagram tool report the same findings in the same place.
    const before = warnings.length;
    const res = await runUserflow(spec, call, warnings);
    const merged = res.warnings.slice();
    for (const w of warnings.slice(before)) if (!merged.includes(w)) merged.push(w);
    return { ...res, warnings: merged };
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
        "Pass an https URL (public hosts only), a data:image/...;base64,... URI, or raw base64 bytes.",
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
  const safe = assertSafeImageUrl(url);
  try {
    if (deps.imageFetcher) return await deps.imageFetcher(safe.href);
    const res = await (globalThis.fetch as unknown as (u: string) => Promise<Response>)(safe.href);
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
      return { nodeId: first, ...(isObj(second) ? (second as object) : {}) };
    case "get_node":
      return { nodeId: first, ...(isObj(second) ? (second as object) : {}) };
    case "get_nodes":
      return { nodeIds: first };
    case "get_component":
      return isObj(first) ? (first as Record<string, unknown>) : { componentId: first };
    case "get_library_component":
      return isObj(first) ? (first as Record<string, unknown>) : { key: first };
    case "set_text":
      return { nodeId: first, content: second };
    case "apply_variable":
      return { nodeId: first, field: second, tokenName: args[2] };
    case "setup_tokens":
      return isObj(first) ? (first as Record<string, unknown>) : { tokens: first };
    case "setup_text_styles":
      // setupTextStyles(stylesArray) → {styles}; ({styles: [...]}) passes through.
      return Array.isArray(first)
        ? { styles: first }
        : isObj(first)
          ? (first as Record<string, unknown>)
          : { styles: first };
    case "set_text_style":
      // setTextStyle(nodeId, styleNameOrId) → {nodeId, style}.
      return { nodeId: first, style: second };
    case "setup_effect_styles":
      // setupEffectStyles(stylesArray) → {styles}; ({styles:[...]}) passes through.
      return Array.isArray(first)
        ? { styles: first }
        : isObj(first)
          ? (first as Record<string, unknown>)
          : { styles: first };
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
    case "delete_page":
      // deletePage(idOrName, {force}) or ({page, force})
      return isObj(first)
        ? (first as Record<string, unknown>)
        : { page: first, ...(isObj(second) ? (second as object) : {}) };
    case "delete_style":
      // deleteStyle(nameOrId, {type, replaceWith, force}) or ({style, ...})
      return isObj(first)
        ? (first as Record<string, unknown>)
        : { style: first, ...(isObj(second) ? (second as object) : {}) };
    case "delete_unused_styles":
      // deleteUnusedStyles() previews; ({confirm, types, keep}) deletes.
      return isObj(first) ? (first as Record<string, unknown>) : {};
    // Demo reels: deleteDemo("id") / getDemoSpec("id"), or the opts bag.
    case "set_current_page":
      return isObj(first) ? (first as Record<string, unknown>) : { pageId: first };
    case "load_image":
      return isObj(first) ? (first as Record<string, unknown>) : { source: first };
    case "group":
      return isObj(first) ? (first as Record<string, unknown>) : { nodeIds: first };
    case "search_nodes":
      return isObj(first) ? (first as Record<string, unknown>) : { query: first };
    case "get_fonts":
      // getFonts(["Inter"]) — documented positional family list; also a bare
      // family name or the {families} bag.
      return isObj(first)
        ? (first as Record<string, unknown>)
        : first === undefined
          ? {}
          : { families: Array.isArray(first) ? first : [first] };
    case "screenshot":
      // screenshot({nodeId, scale}) documented; tolerate screenshot("1:2").
      return isObj(first)
        ? (first as Record<string, unknown>)
        : first === undefined
          ? {}
          : { nodeId: first, ...(isObj(second) ? (second as object) : {}) };
    case "reflow_diagram":
      // reflowDiagram({frameId?}) — tolerate a bare frame id.
      return isObj(first)
        ? (first as Record<string, unknown>)
        : first === undefined
          ? {}
          : { frameId: first, ...(isObj(second) ? (second as object) : {}) };
    case "get_design_context":
      // getDesignContext({nodeId?, detail?, depth?}) — tolerate a bare nodeId.
      return isObj(first)
        ? (first as Record<string, unknown>)
        : first === undefined
          ? {}
          : { nodeId: first, ...(isObj(second) ? (second as object) : {}) };
    case "scan_text_nodes":
      // scanTextNodes({nodeId?, limit?}) — tolerate a bare nodeId.
      return isObj(first)
        ? (first as Record<string, unknown>)
        : first === undefined
          ? {}
          : { nodeId: first, ...(isObj(second) ? (second as object) : {}) };
    case "scan_nodes_by_types":
      // scanNodesByTypes({types?, nodeId?}) — an array arg is the type list,
      // a string arg a scope nodeId.
      return isObj(first)
        ? (first as Record<string, unknown>)
        : Array.isArray(first)
          ? { types: first, ...(isObj(second) ? (second as object) : {}) }
          : first === undefined
            ? {}
            : { nodeId: first, ...(isObj(second) ? (second as object) : {}) };
    case "read_selection":
      // readSelection({detail?, depth?}) — tolerate a bare detail string.
      return isObj(first)
        ? (first as Record<string, unknown>)
        : first === undefined
          ? {}
          : { detail: first };
    case "set_selection":
      // setSelection(["1:2", "3:4"]) or setSelection({nodeIds}).
      return isObj(first)
        ? (first as Record<string, unknown>)
        : Array.isArray(first)
          ? { nodeIds: first }
          : first === undefined
            ? {}
            : { nodeIds: [first] };
    // Edit-in-place composite ops — keep the (targetish, opts) ergonomics.
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
    case "set_reactions":
      // setReactions(nodeId, reactions) → {nodeId, reactions}.
      return { nodeId: first, reactions: second };
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
      // get_document_info / get_selection / get_styles / get_variables /
      // get_components / get_design_system_kit / generate_design_md /
      // design_fingerprint / list_channels → single object spec (or {}).
      // A stray scalar used to be wrapped into {value} — a param NO op reads,
      // so the arg was silently dropped (figma.screenshot("1:2") screenshotted
      // the whole page). Fail loud instead.
      if (isObj(first)) return first as Record<string, unknown>;
      if (first === undefined) return {};
      throw new OpError(
        ErrorCode.INVALID_PARAMS,
        `"${op}" takes an options object, not a bare ${Array.isArray(first) ? "array" : typeof first}.`,
        "Pass the options as one object — see figma_docs(section=\"api\") for the call shape.",
      );
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
    // Dedupe: the same safe-default warning fires on every node of a large
    // draw, and N identical copies teach the agent nothing the first one did
    // not — they just cost tokens.
    if (res.warnings?.length) {
      for (const w of res.warnings) if (!warnings.includes(w)) warnings.push(w);
    }

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

/** Ops that can put a node straight onto the page, where it must keep clear. */
const PLACED_OPS = new Set<string>(["create", "instantiate", "clone"]);

function withPlaceGroup(op: AnyOperation, params: Record<string, unknown>, group: string): Record<string, unknown> {
  if (!PLACED_OPS.has(op) || !isObj(params) || params.placeGroup !== undefined) return params;
  return { ...params, placeGroup: group };
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
    "First draw with literal colors and no session tokens. If this file has variables/styles, read figma_rules and reuse them (applyVariable). If it has none and there is no design.md, read figma_docs(section=\"style\") for a ready default scale/palette/elevation instead of inventing values (inventing is what makes output look generic), then figma.setupTokens/setupTextStyles from it so all screens share one system. A design.md in the codebase, if present, is the source of truth. (Shown once per session.)",
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

function fmt(args: unknown[], ser: (v: unknown) => string): string {
  return args
    .map((a) => (typeof a === "string" ? a : ser(a)))
    .join(" ");
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export { isReadOp };
