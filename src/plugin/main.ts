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

declare const __VERSION__: string;
const PLUGIN_VERSION =
  typeof __VERSION__ === "string" ? __VERSION__ : "0.0.0-dev";

/**
 * Messages exchanged with ui.html (postMessage). The UI relays WS traffic to
 * the main thread and vice-versa.
 */
type UiToMain =
  | { kind: "handshake" }
  | { kind: "request"; payload: BridgeRequest }
  | { kind: "hello-request" }
  | { kind: "save-channel"; channel: string | null };

type MainToUi =
  | { kind: "handshake"; pluginVersion: string; protocolVersion: number }
  | { kind: "hello"; hello: HelloData }
  | { kind: "response"; payload: BridgeResponse; op: Operation }
  | { kind: "progress"; payload: BridgeResponse; op: Operation };

interface HelloData {
  protocolVersion: number;
  pluginVersion: string;
  fileKey: string | null;
  fileName: string;
  pageName: string;
  editorType: string;
  /** Channel persisted for this file (clientStorage); null on first run. */
  channel: string | null;
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

function helloData(): HelloData {
  return {
    protocolVersion: PROTOCOL_VERSION,
    pluginVersion: PLUGIN_VERSION,
    fileKey: (figma as unknown as { fileKey?: string }).fileKey ?? null,
    fileName: figma.root.name,
    pageName: figma.currentPage.name,
    editorType: figma.editorType,
    channel: storedChannel,
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
    const item = items[i]!;
    const localWarnings: string[] = [];
    const subCtx = makeContext(item.params ?? {}, progress);
    // capture warnings from the sub-context
    const origWarn = subCtx.warn;
    subCtx.warn = (m: string) => {
      origWarn(m);
      if (!localWarnings.includes(m)) localWarnings.push(m);
    };

    try {
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
figma.showUI(__html__, { visible: true, width: 320, height: 560 });

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
    if (typeof v === "string" && v.length > 0) storedChannel = v;
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
      try {
        if (msg.channel) {
          await figma.clientStorage.setAsync(channelStorageKey(), msg.channel);
        } else {
          await figma.clientStorage.deleteAsync(channelStorageKey());
        }
      } catch {
        /* non-fatal: channel just won't persist across restarts */
      }
      break;
    }
    case "request": {
      const res = await dispatch(msg.payload);
      post({ kind: "response", payload: res, op: msg.payload.op });
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
