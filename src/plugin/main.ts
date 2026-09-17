/// <reference types="@figma/plugin-typings" />
import {
  BridgeRequest,
  BridgeResponse,
  Operation,
  OPERATIONS,
  ErrorCode,
  PROTOCOL_VERSION,
  BATCH_CHUNK_SIZE,
} from "../shared/protocol.js";
import { makeContext } from "./context.js";
import { toBridgeError, err } from "./errors.js";
import { HANDLERS, assertRegistryComplete, Handler } from "./handlers/registry.js";
import { installDiagramLive } from "./diagram-live.js";

declare const __VERSION__: string;
declare const __BUILD__: string;
const PLUGIN_VERSION =
  typeof __VERSION__ === "string" ? __VERSION__ : "0.0.0-dev";
/**
 * When THIS bundle was built. Figma keeps the code a plugin was launched
 * with, so a rebuild is invisible here until somebody re-runs the plugin —
 * and that is indistinguishable, from the outside, from a fix that did not
 * work. The stamp travels in the handshake so figma_status can say which.
 */
const PLUGIN_BUILD = typeof __BUILD__ === "string" ? __BUILD__ : "dev";

/**
 * Messages exchanged with ui.html (postMessage). The UI relays WS traffic to
 * the main thread and vice-versa.
 */
type UiToMain =
  | { kind: "handshake" }
  | { kind: "request"; payload: BridgeRequest }
  | { kind: "hello-request" }
  | { kind: "save-channel"; channel: string | null; resumeToken?: string | null }
  // The panel is resizable: only the main thread may call figma.ui.resize(),
  // so the iframe measures the drag and sends the size here.
  | { kind: "resize"; width: number; height: number }
  // The panel driving the plugin directly, with no server in the loop: the
  // demo list and its Play button have to work when no agent is running.
  | { kind: "local"; id: string; op: string; params?: Record<string, unknown> };

type MainToUi =
  | { kind: "handshake"; pluginVersion: string; protocolVersion: number }
  | { kind: "hello"; hello: HelloData }
  | { kind: "response"; payload: BridgeResponse; op: Operation }
  | { kind: "progress"; payload: BridgeResponse; op: Operation }
  | {
      kind: "local";
      id: string;
      ok: boolean;
      result?: unknown;
      error?: { code: string; message: string; hint?: string };
      warnings?: string[];
    };

/**
 * The ops the PANEL may run on its own. Deliberately tiny: everything here is
 * about replaying a demo that already exists, which is the one job that must
 * not depend on an agent being connected. Authoring still goes through the
 * bridge, where it is validated.
 */
const LOCAL_OPS: Record<string, true> = {
  set_current_page: true,
};

interface HelloData {
  protocolVersion: number;
  pluginVersion: string;
  /** When this bundle was built — see PLUGIN_BUILD. */
  pluginBuild: string;
  fileKey: string | null;
  fileName: string;
  pageName: string;
  editorType: string;
  /** Channel persisted for this file (clientStorage); null on first run. */
  channel: string | null;
  /** Resume secret for reclaiming the channel after reload. */
  resumeToken: string | null;
}

function post(msg: MainToUi): void {
  figma.ui.postMessage(msg);
}

/** clientStorage key for this file's channel — a window shows one file, so
 * per-file persistence makes reopening the plugin rejoin the same channel. */
function channelStorageKey(): string {
  const fileKey = (figma as unknown as { fileKey?: string }).fileKey;
  return `reqwise:channel:${fileKey ?? figma.root.name}`;
}

/** Loaded once at startup; kept in sync by the save-channel message. */
let storedChannel: string | null = null;
let storedResumeToken: string | null = null;

function helloData(): HelloData {
  return {
    protocolVersion: PROTOCOL_VERSION,
    pluginVersion: PLUGIN_VERSION,
    pluginBuild: PLUGIN_BUILD,
    fileKey: (figma as unknown as { fileKey?: string }).fileKey ?? null,
    fileName: figma.root.name,
    pageName: figma.currentPage.name,
    editorType: figma.editorType,
    channel: storedChannel,
    resumeToken: storedResumeToken,
  };
}

/** Dispatch a single request to its handler and build a BridgeResponse. */
async function dispatch(req: BridgeRequest): Promise<BridgeResponse> {
  const emitProgress = (done: number, total: number, note?: string) => {
    post({
      kind: "progress",
      payload: { id: req.id, ok: true, progress: { done, total, note } },
      op: req.op,
    });
  };
  const ctx = makeContext(req.params ?? {}, emitProgress);

  if (!isOperation(req.op)) {
    return {
      id: req.id,
      ok: false,
      error: {
        code: ErrorCode.UNSUPPORTED_OPERATION,
        message: `Unknown operation "${String(req.op)}".`,
        hint: `Supported operations: ${OPERATIONS.join(", ")}.`,
      },
    };
  }

  try {
    let result: unknown;
    if (req.op === "batch") {
      result = await runBatch(req, ctx.progress);
    } else {
      const handler: Handler = HANDLERS[req.op];
      result = await handler(ctx);
    }
    const res: BridgeResponse = { id: req.id, ok: true, result };
    if (ctx.warnings.length > 0) res.warnings = ctx.warnings;
    return res;
  } catch (e) {
    const res: BridgeResponse = {
      id: req.id,
      ok: false,
      error: toBridgeError(e),
    };
    if (ctx.warnings.length > 0) res.warnings = ctx.warnings;
    return res;
  }
}

function isOperation(op: unknown): op is Operation {
  return typeof op === "string" && (OPERATIONS as readonly string[]).includes(op);
}

interface BatchItem {
  op: Operation;
  params: Record<string, unknown>;
}
interface BatchResult {
  ok: boolean;
  result?: unknown;
  error?: { code: ErrorCode; message: string; hint?: string };
  warnings?: string[];
}

/**
 * batch: sequential execution with per-item try/catch, partial commit, and a
 * progress ping at every BATCH_CHUNK_SIZE boundary + at completion of each
 * chunk. Returns per-index {ok, result|error}.
 */
async function runBatch(
  req: BridgeRequest,
  progress: (done: number, total: number, note?: string) => void,
): Promise<{ items: BatchResult[]; okCount: number; failCount: number }> {
  const rawItems = (req.params?.items ?? req.params?.ops) as unknown;
  if (!Array.isArray(rawItems)) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      "batch requires an items[] array of { op, params }.",
    );
  }
  const items = rawItems as BatchItem[];
  const results: BatchResult[] = [];
  let okCount = 0;
  let failCount = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    try {
      // Everything that touches `item` stays INSIDE the per-item try: a
      // malformed entry (null, a bare string) must fail this index and no
      // more — thrown outside, it would sink the batch and every result
      // already collected, and partial commit is the point of the op.
      if (!item || typeof item !== "object") {
        throw err(
          ErrorCode.INVALID_PARAMS,
          `Batch item ${i} is not an { op, params } object.`,
        );
      }
      const subCtx = makeContext(
        item.params && typeof item.params === "object" ? item.params : {},
        progress,
      );

      if (!isOperation(item.op)) {
        throw err(
          ErrorCode.UNSUPPORTED_OPERATION,
          `Unknown operation "${String(item.op)}" at batch index ${i}.`,
        );
      }
      if (item.op === "batch") {
        throw err(ErrorCode.INVALID_PARAMS, "Nested batch is not allowed.");
      }
      const handler = HANDLERS[item.op];
      const result = await handler(subCtx);
      const r: BatchResult = { ok: true, result };
      if (subCtx.warnings.length > 0) r.warnings = subCtx.warnings;
      results.push(r);
      okCount++;
    } catch (e) {
      results.push({ ok: false, error: toBridgeError(e) });
      failCount++;
    }

    // progress at each chunk boundary and at the very end of a chunk.
    if ((i + 1) % BATCH_CHUNK_SIZE === 0 || i === items.length - 1) {
      progress(i + 1, items.length, `batch ${i + 1}/${items.length}`);
    }
  }

  return { items: results, okCount, failCount };
}

// ---- wire-up ----
// The panel grew a Demo section; 560 made the lists fight for the same
// pixels. The wrap scrolls either way, but a panel you have to scroll to see
// the Play button is a panel nobody presses.
const PANEL_DEFAULT = { width: 320, height: 660 };
/** Small enough for a 13" laptop with the toolbar open; the wrap scrolls. */
const PANEL_MIN = { width: 280, height: 260 };
const PANEL_MAX = { width: 1600, height: 1600 };
const PANEL_SIZE_KEY = "reqwise:panel-size";
let panelSizeSave: ReturnType<typeof setTimeout> | null = null;

function clampPanel(width: number, height: number): { width: number; height: number } {
  const w = Math.round(Number(width));
  const h = Math.round(Number(height));
  return {
    width: Number.isFinite(w) ? Math.min(PANEL_MAX.width, Math.max(PANEL_MIN.width, w)) : PANEL_DEFAULT.width,
    height: Number.isFinite(h) ? Math.min(PANEL_MAX.height, Math.max(PANEL_MIN.height, h)) : PANEL_DEFAULT.height,
  };
}

figma.showUI(__html__, { visible: true, ...PANEL_DEFAULT });

// Reopen at the size the user dragged it to last time. showUI cannot wait for
// clientStorage (it is async), so the default paints first and the stored size
// is applied a tick later.
figma.clientStorage
  .getAsync(PANEL_SIZE_KEY)
  .then((v) => {
    if (!v || typeof v !== "object") return;
    const { width, height } = v as { width?: number; height?: number };
    if (typeof width !== "number" || typeof height !== "number") return;
    const size = clampPanel(width, height);
    if (size.width !== PANEL_DEFAULT.width || size.height !== PANEL_DEFAULT.height) {
      figma.ui.resize(size.width, size.height);
    }
  })
  .catch(() => {
    /* first run / storage unavailable — the default size stands */
  });

const missing = assertRegistryComplete();
if (missing.length > 0) {
  // Surface loudly during development; still run so partial ops work.
  console.error("Handler registry incomplete, missing:", missing.join(", "));
}

// Restore this file's channel before the UI connects (the UI asks for
// handshake/hello first, and hello carries the stored channel).
const channelLoaded: Promise<void> = figma.clientStorage
  .getAsync(channelStorageKey())
  .then((v) => {
    // Legacy: plain channel string. Current: { channel, resumeToken }.
    if (typeof v === "string" && v.length > 0) {
      storedChannel = v;
      return;
    }
    if (v && typeof v === "object") {
      const o = v as { channel?: unknown; resumeToken?: unknown };
      if (typeof o.channel === "string" && o.channel.length > 0) storedChannel = o.channel;
      if (typeof o.resumeToken === "string" && o.resumeToken.length > 0) {
        storedResumeToken = o.resumeToken;
      }
    }
  })
  .catch(() => {
    /* first run / storage unavailable — server will assign a channel */
  });

figma.ui.onmessage = async (msg: UiToMain) => {
  if (!msg || typeof msg !== "object") return;
  switch (msg.kind) {
    case "handshake":
      await channelLoaded;
      post({
        kind: "handshake",
        pluginVersion: PLUGIN_VERSION,
        protocolVersion: PROTOCOL_VERSION,
      });
      // Fall through to also send fresh hello data.
      post({ kind: "hello", hello: helloData() });
      break;
    case "hello-request":
      await channelLoaded;
      post({ kind: "hello", hello: helloData() });
      break;
    case "save-channel": {
      storedChannel = msg.channel;
      storedResumeToken =
        typeof msg.resumeToken === "string" && msg.resumeToken.length > 0
          ? msg.resumeToken
          : null;
      try {
        if (msg.channel) {
          await figma.clientStorage.setAsync(channelStorageKey(), {
            channel: msg.channel,
            ...(storedResumeToken ? { resumeToken: storedResumeToken } : {}),
          });
        } else {
          storedResumeToken = null;
          await figma.clientStorage.deleteAsync(channelStorageKey());
        }
      } catch {
        /* non-fatal: channel just won't persist across restarts */
      }
      break;
    }
    case "resize": {
      const size = clampPanel(msg.width, msg.height);
      figma.ui.resize(size.width, size.height);
      // A drag posts one size per animation frame; storing each of them would
      // be a clientStorage write per frame. Settle first, then remember.
      if (panelSizeSave !== null) clearTimeout(panelSizeSave);
      panelSizeSave = setTimeout(() => {
        panelSizeSave = null;
        figma.clientStorage.setAsync(PANEL_SIZE_KEY, size).catch(() => {
          /* non-fatal: the size just won't survive a restart */
        });
      }, 250);
      break;
    }
    case "request": {
      const res = await dispatch(msg.payload);
      post({ kind: "response", payload: res, op: msg.payload.op });
      break;
    }
    case "local": {
      // Panel-initiated, never forwarded to the server.
      if (!LOCAL_OPS[msg.op] || !isOperation(msg.op)) {
        post({
          kind: "local",
          id: msg.id,
          ok: false,
          error: {
            code: ErrorCode.UNSUPPORTED_OPERATION,
            message: `"${String(msg.op)}" cannot be run from the plugin panel.`,
            hint: `Panel ops: ${Object.keys(LOCAL_OPS).join(", ")}.`,
          },
        });
        break;
      }
      const ctx = makeContext(msg.params ?? {}, () => {});
      try {
        const result = await HANDLERS[msg.op](ctx);
        post({
          kind: "local",
          id: msg.id,
          ok: true,
          result,
          ...(ctx.warnings.length > 0 ? { warnings: ctx.warnings } : {}),
        });
      } catch (e) {
        const bridgeError = toBridgeError(e);
        post({
          kind: "local",
          id: msg.id,
          ok: false,
          error: bridgeError,
          ...(ctx.warnings.length > 0 ? { warnings: ctx.warnings } : {}),
        });
      }
      break;
    }
    default:
      break;
  }
};

// Keep hello data fresh when the user switches pages/files.
figma.on("currentpagechange", () => {
  post({ kind: "hello", hello: helloData() });
});

// A drawn diagram's arrows are plain vectors — Figma Design has no connector
// node — so something has to move them when their boxes move. This listener is
// that something, for as long as the plugin is open.
installDiagramLive();
