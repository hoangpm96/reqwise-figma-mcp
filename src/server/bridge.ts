/**
 * Bridge: HTTP + WebSocket server the plugin connects to and followers
 * forward through.
 *
 *   WS   /ws      — Figma plugin UIs. A `hello` handshake is required before
 *                   any request is dispatched. Heartbeat ping/pong.
 *                   MULTI-CHANNEL: each connection is joined to a channel
 *                   (requested in hello, or assigned by the server and echoed
 *                   back with a `{type:"assigned"}` message). Multiple Figma
 *                   windows stay connected simultaneously, one per channel. A
 *                   new hello on an EXISTING channel replaces only that
 *                   channel's connection (its in-flight requests are failed
 *                   fast) — other channels are untouched.
 *   GET  /health  — diagnostics JSON (used by follower discovery + status).
 *   POST /rpc     — follower → leader forwarding, Bearer-token authed. The
 *                   forwarded op still goes through the same validate + queue
 *                   + bridge path as a leader-direct op.
 *
 * Routing: dispatch() resolves the target connection from opts.channel —
 *   explicit channel → that connection (CHANNEL_NOT_FOUND if absent);
 *   no channel + exactly one connection → it (zero-config single-window UX);
 *   no channel + none → held in an unrouted queue until a plugin connects
 *     (same wait-for-plugin behaviour the single-connection bridge had);
 *   no channel + several → AMBIGUOUS_CHANNEL listing the open channels.
 *
 * Correlation: every dispatched request gets an id; responses/progress are
 * matched via the owning connection's `pending` map. Each op has a per-op
 * timeout from OP_TIMEOUTS; a `progress` message resets that timer (long
 * batches / exports must never trip the timeout while the plugin is actively
 * working). Timers arm at DISPATCH (dequeue), never while queued.
 */
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { randomUUID, randomInt } from "node:crypto";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { safeEqualString, newResumeToken } from "./security.js";
import {
  DEFAULT_OP_TIMEOUT_MS,
  HEARTBEAT_DEAD_MS,
  HEARTBEAT_INTERVAL_MS,
  OP_TIMEOUTS,
  WRITE_OPERATIONS,
  type BridgeRequest,
  type BridgeResponse,
  type Operation,
  type PluginHello,
  type SessionSummaryWire,
  type WireMessage,
} from "../shared/protocol.js";
import { ErrorCode, OpError, toBridgeError } from "./errors.js";

/**
 * Does this operation CHANGE the document? A timeout on a read is just a
 * missing answer; a timeout on a write leaves the caller not knowing whether
 * the work happened, which is a different problem and needs a different hint.
 */
const MUTATING = new Set<string>(WRITE_OPERATIONS as readonly string[]);
function mutates(op: string): boolean {
  return MUTATING.has(op);
}

/** Cap on requests waiting for a plugin slot (per connection + unrouted). */
const MAX_QUEUE = 100;
/**
 * Cap on concurrent in-flight requests handed to ONE plugin connection.
 *
 * ARCHITECTURE root-cause #16 — per-connection write serialization: the Figma
 * Plugin API is single-threaded and races/times out when two mutations overlap
 * (`code.js` runs on one main thread; overlapping async handlers corrupt each
 * other's transient state). The simplest correct fix is to serialize ALL
 * dispatch through a single in-flight gate per plugin connection: at most one
 * op is on the wire at a time, the rest wait FIFO. Reads are cheap and rare
 * enough that serializing them too costs nothing and removes an entire class of
 * interleaving bugs. Different channels are different Figma windows (separate
 * main threads), so they run in parallel — the gate is per connection, not
 * global.
 */
const MAX_IN_FLIGHT = 1;

/**
 * WS upgrade Origin allowlist (CSWSH guard). Browsers always send an Origin
 * header on WebSocket upgrades, and every browser page — including a
 * malicious tab — may open a cross-origin socket to 127.0.0.1. The Figma
 * plugin iframe is a sandboxed opaque origin, so its upgrades carry
 * `Origin: null`; non-browser clients (the `ws` library, tests, drivers)
 * send none. Anything presenting a real http(s) origin is a web page posing
 * as the plugin — the upgrade is refused before a socket ever opens.
 */
const TRUSTED_WS_ORIGINS = new Set(["https://www.figma.com", "https://figma.com"]);

/** How long a socket may sit staged (connected but no `hello`) before it is
 * terminated. A connect-and-say-nothing client is pure resource cost — the
 * heartbeat monitor only watches established channels. */
const DEFAULT_HELLO_TIMEOUT_MS = 30_000;

/** Largest WS frame accepted on the plugin channel. Responses carry base64
 * screenshots/exports, so this sits well above those and far below the `ws`
 * default (100 MiB). */
const DEFAULT_MAX_PAYLOAD = 64 * 1024 * 1024;

/** Word lists for human-friendly generated channel names (adj-noun-NN). */
const CHANNEL_ADJECTIVES = [
  "brave", "calm", "eager", "fancy", "gentle", "happy", "jolly", "kind",
  "lively", "merry", "noble", "proud", "quick", "sunny", "swift", "witty",
];
const CHANNEL_NOUNS = [
  "otter", "falcon", "panda", "tiger", "whale", "fox", "lynx", "koala",
  "heron", "bison", "gecko", "dolphin", "badger", "crane", "maple", "cedar",
];

export interface PluginInfo {
  version: string;
  /** When the bundle Figma is running was built; absent on an older plugin. */
  build?: string;
  protocolVersion: number;
  fileKey: string | null;
  fileName: string;
  pageName: string;
  editorType: string;
  connectedAt: number;
}

/** One row of list_channels / figma_status.channels / health.channels. */
export interface ChannelSummary {
  channel: string;
  plugin: PluginInfo;
  queueLength: number;
  pendingCount: number;
  lastHeartbeatMs: number;
}

interface Pending {
  id: string;
  op: Operation;
  resolve: (r: BridgeResponse) => void;
  reject: (e: OpError) => void;
  /**
   * The per-op timeout timer. Undefined while the request sits in the queue —
   * it is armed only when the op is actually dispatched to the plugin
   * (`drainQueue`), so a queued op never burns its timeout budget waiting for
   * the in-flight op ahead of it to settle. The clock starts at dispatch.
   */
  timer?: NodeJS.Timeout;
  timeoutMs: number;
  onProgress?: (p: NonNullable<BridgeResponse["progress"]>) => void;
}

interface QueueItem {
  request: BridgeRequest;
  pending: Pending;
}

export interface DispatchOptions {
  timeoutMs?: number;
  chunk?: BridgeRequest["chunk"];
  onProgress?: (p: NonNullable<BridgeResponse["progress"]>) => void;
  /**
   * Target channel (Figma window). Omit for the zero-config default: with one
   * window connected everything routes there; with several the dispatch fails
   * AMBIGUOUS_CHANNEL so the caller picks one via list_channels — unless the
   * calling session was bound to a window from the plugin UI (see sessionId).
   */
  channel?: string;
  /**
   * The calling agent session. Used for Figma-side pairing: when the user
   * picks this session in a plugin window's UI, ops from the session route to
   * that window without an explicit channel.
   */
  sessionId?: string;
}

export interface BridgeHandlers {
  /** Called for POST /rpc after Bearer auth passes. Returns the op result. */
  onRpc?: (
    op: string,
    params: Record<string, unknown>,
    sessionId?: string,
    channel?: string,
  ) => Promise<unknown>;
}

export interface BridgeOptions {
  /** ms a socket may stay staged (connected, no `hello`) before termination. */
  helloTimeoutMs?: number;
  /** Max accepted WS frame size in bytes. */
  maxPayloadBytes?: number;
}

/**
 * One established (hello-completed) plugin connection joined to a channel.
 * Owns its own queue, in-flight gate, pending map and heartbeat clock so
 * channels never serialize or fail each other.
 */
class PluginConnection {
  readonly pending = new Map<string, Pending>();
  readonly queue: QueueItem[] = [];
  inFlight = 0;
  lastHeartbeatAt = Date.now();

  constructor(
    public readonly channel: string,
    public ws: WebSocket,
    public info: PluginInfo,
    /** Secret required to replace this connection on reconnect. */
    public readonly resumeToken: string,
  ) {}

  get open(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  get lastHeartbeatMs(): number {
    return Date.now() - this.lastHeartbeatAt;
  }

  enqueue(request: BridgeRequest, pending: Pending): void {
    if (this.queue.length >= MAX_QUEUE) {
      pending.reject(
        new OpError(
          ErrorCode.QUEUE_FULL,
          `Request queue for channel "${this.channel}" is full (${this.queue.length}/${MAX_QUEUE}) — plugin is busy (${this.inFlight} in flight).`,
          "Wait for in-flight operations to finish, or batch related ops into one figma_write.",
        ),
      );
      return;
    }
    this.pending.set(pending.id, pending);
    this.queue.push({ request, pending });
    this.drainQueue();
  }

  drainQueue(): void {
    if (!this.open) {
      return; // hold until the socket is replaced or closed (close fails all)
    }
    while (this.queue.length > 0 && this.inFlight < MAX_IN_FLIGHT) {
      const item = this.queue.shift();
      if (!item) break;
      if (!this.pending.has(item.pending.id)) {
        continue; // already timed out / cancelled while queued
      }
      this.inFlight++;
      // Arm the per-op timeout only now, as the op goes on the wire — the clock
      // starts at dispatch, not at enqueue. With MAX_IN_FLIGHT === 1 this is the
      // serialization gate: the next op is not sent until the current one
      // settles (settle() calls drainQueue()).
      item.pending.timer = this.armTimer(item.pending.id, item.pending.op, item.pending.timeoutMs);
      this.send({ type: "request", payload: item.request });
    }
  }

  onResponse(res: BridgeResponse): void {
    const pending = this.pending.get(res.id);
    if (!pending) {
      return; // late response for an already-settled request
    }

    // A progress message is any message carrying `progress` but NO final result
    // and no error. It resets the timer but must NOT settle the request. The
    // plugin sends progress with `ok:true` (dispatch always stamps ok:true), so
    // we must NOT gate on `res.ok !== true` here — doing so made a batch's final
    // progress ping settle the request in place of the real result message,
    // leaving res.result undefined and every batch item reported as "no result".
    if (res.progress && res.error === undefined && !hasResult(res)) {
      pending.onProgress?.(res.progress);
      this.resetTimer(pending);
      return;
    }
    if (res.progress) {
      pending.onProgress?.(res.progress);
    }

    this.settle(res.id);
    pending.resolve(res);
  }

  private armTimer(id: string, op: Operation, timeoutMs: number): NodeJS.Timeout {
    const t = setTimeout(() => {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.settle(id);
      pending.reject(
        new OpError(
          ErrorCode.PLUGIN_TIMEOUT,
          `Operation "${op}" timed out after ${timeoutMs}ms.`,
          mutates(op)
            ? // The plugin is not cancelled by this timeout — it keeps going and
              // usually finishes. Saying only "timed out" invites a retry, and a
              // retry of a draw that actually landed is how a page ends up with
              // every diagram on it twice. Ask before repeating the work.
              `The Figma plugin did not answer in time, but it was NOT cancelled — "${op}" may well have completed. Do NOT simply retry: check with figma_read op:"get_page_model" (or get_design_context) first, and if the frame is there, use \`update\` with its id rather than drawing a second one. figma_status shows whether the window is throttled (lastHeartbeatMs well over ~2s means it is in the background).`
            : "The Figma plugin did not respond in time — check figma_status; the window may be minimized or the op may be very large.",
        ),
      );
    }, timeoutMs);
    // Do not keep the process alive purely for a pending timer.
    t.unref?.();
    return t;
  }

  private resetTimer(pending: Pending): void {
    clearTimeout(pending.timer);
    pending.timer = this.armTimer(pending.id, pending.op, pending.timeoutMs);
  }

  private settle(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (this.inFlight > 0) this.inFlight--;
    this.drainQueue();
  }

  failAllPending(err: OpError): void {
    const all = [...this.pending.values()];
    this.pending.clear();
    this.queue.length = 0;
    this.inFlight = 0;
    for (const p of all) {
      clearTimeout(p.timer);
      p.reject(err);
    }
  }

  send(msg: WireMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  summary(): ChannelSummary {
    return {
      channel: this.channel,
      plugin: this.info,
      queueLength: this.queue.length,
      pendingCount: this.pending.size,
      lastHeartbeatMs: this.lastHeartbeatMs,
    };
  }
}

export class Bridge {
  private http?: HttpServer;
  private wss?: WebSocketServer;
  /** Established connections by channel. One Figma window per channel. */
  private readonly channels = new Map<string, PluginConnection>();
  /** Reverse lookup for socket events. */
  private readonly bySocket = new Map<WebSocket, PluginConnection>();
  /** Sockets that have NOT yet completed their hello handshake, mapped to
   * their hello deadline timer. Kept apart from `channels` so a socket that
   * dies before handshaking never disturbs established connections and their
   * in-flight requests. */
  private readonly stagedSockets = new Map<WebSocket, NodeJS.Timeout>();
  /**
   * Ops dispatched with NO channel while NO plugin is connected. They wait
   * here (timers not armed — the clock starts at dispatch) and drain to the
   * first connection that completes hello. This preserves the "start the
   * agent first, open Figma second" flow the single-connection bridge had.
   */
  private readonly unrouted: QueueItem[] = [];
  /**
   * Figma-side pairing: sessionId → channel, set when the user picks an agent
   * session in a plugin window's UI ({type:"bind"}). `notified` flips after
   * the first op routed through the binding has carried a warning back to the
   * agent, so the agent learns about the pairing without polling status.
   */
  private readonly sessionBindings = new Map<string, { channel: string; notified: boolean }>();
  /** Supplied by index.ts so channel pushes can list agent sessions. */
  private sessionsProvider?: () => SessionSummaryWire[];

  private boundPort = 0;
  private authToken = "";
  private heartbeatTimer?: NodeJS.Timeout;

  private readonly helloTimeoutMs: number;
  private readonly maxPayloadBytes: number;

  constructor(private readonly handlers: BridgeHandlers = {}, opts: BridgeOptions = {}) {
    this.helloTimeoutMs = opts.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
    this.maxPayloadBytes = opts.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD;
  }

  setSessionsProvider(fn: () => SessionSummaryWire[]): void {
    this.sessionsProvider = fn;
  }

  /** The channel a session is bound to (via the plugin UI), if any. */
  sessionBinding(sessionId: string): string | undefined {
    return this.sessionBindings.get(sessionId)?.channel;
  }

  get port(): number {
    return this.boundPort;
  }

  get pluginConnected(): boolean {
    for (const conn of this.channels.values()) {
      if (conn.open) return true;
    }
    return false;
  }

  /** Info of the single connected plugin, when exactly one is connected.
   * With several windows use channels() — there is no single "the plugin". */
  get plugin(): PluginInfo | undefined {
    if (this.channels.size !== 1) return undefined;
    const first = this.channels.values().next().value as PluginConnection | undefined;
    return first?.info;
  }

  get lastHeartbeatMs(): number {
    // Most recent heartbeat across connections; -1 when none ever connected.
    let best = -1;
    for (const conn of this.channels.values()) {
      const ms = conn.lastHeartbeatMs;
      if (best === -1 || ms < best) best = ms;
    }
    return best;
  }

  get queueLength(): number {
    let n = this.unrouted.length;
    for (const conn of this.channels.values()) n += conn.queue.length;
    return n;
  }

  get pendingCount(): number {
    let n = this.unrouted.length;
    for (const conn of this.channels.values()) n += conn.pending.size;
    return n;
  }

  get channelCount(): number {
    return this.channels.size;
  }

  /** list_channels / figma_status / health: one row per connected window. */
  channelSummaries(): ChannelSummary[] {
    return [...this.channels.values()].map((c) => c.summary());
  }

  /**
   * Bind exactly ONE port (`startPort`) and become the bridge for it. On
   * EADDRINUSE this rejects with the raw error so the CALLER (the Coordinator)
   * decides whether the occupant is a Reqwise leader to follow or a foreign
   * process to skip. Binding the whole fallback range here was the root cause
   * of the "every window becomes its own leader" bug — the range walk masked
   * EADDRINUSE so leader election never saw it. Port selection now lives in the
   * Coordinator, which interleaves bind-attempts with /health follow-checks.
   */
  async listen(startPort: number, authToken: string): Promise<number> {
    this.authToken = authToken;
    await this.tryListen(startPort);
    this.boundPort = startPort;
    this.startHeartbeatMonitor();
    return startPort;
  }

  private tryListen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const http = createServer((req, res) => this.handleHttp(req, res));
      const wss = new WebSocketServer({ noServer: true, maxPayload: this.maxPayloadBytes });

      http.on("upgrade", (req, socket, head) => {
        let pathname: string;
        try {
          pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        } catch {
          // Malformed request-target (e.g. absolute-form with an invalid
          // port) — llhttp accepts it, URL does not. Never let it throw.
          socket.destroy();
          return;
        }
        if (pathname !== "/ws") {
          socket.destroy();
          return;
        }
        // CSWSH guard — see TRUSTED_WS_ORIGINS. A browser page may open a
        // cross-origin WebSocket to this loopback port; only the Figma
        // plugin's opaque origin ("null"), figma.com itself, and non-browser
        // clients (no Origin header) are allowed through.
        const origin = req.headers.origin;
        if (origin !== undefined && origin !== "null" && !TRUSTED_WS_ORIGINS.has(origin)) {
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (client) => this.onWsConnection(client));
      });

      const onError = (err: unknown) => {
        http.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        http.removeListener("error", onError);
        this.http = http;
        this.wss = wss;
        resolve();
      };
      http.once("error", onError);
      http.once("listening", onListening);
      http.listen(port, "127.0.0.1");
    });
  }

  // ---- WebSocket (plugin) ----

  private onWsConnection(client: WebSocket): void {
    // Stage the socket until it completes its hello handshake. Several sockets
    // may be staged at once (several Figma windows opening the plugin
    // together) — none of them disturbs an established connection until its
    // hello resolves a channel.
    this.stagedSockets.set(client, this.armHelloDeadline(client));

    client.on("message", (data) => this.onWsMessage(client, data));
    client.on("close", () => this.onWsClose(client));
    client.on("error", () => {
      /* close handler does the cleanup */
    });
  }

  /** A staged socket gets one deadline: `hello` within helloTimeoutMs or the
   * socket is terminated. Without it a connect-and-say-nothing client holds
   * the slot forever — nothing else reaps staged sockets. */
  private armHelloDeadline(client: WebSocket): NodeJS.Timeout {
    const t = setTimeout(() => {
      if (!this.stagedSockets.delete(client)) return;
      try {
        client.terminate();
      } catch {
        /* close handler cleans up */
      }
    }, this.helloTimeoutMs);
    t.unref?.();
    return t;
  }

  private onWsMessage(client: WebSocket, data: RawData): void {
    let msg: WireMessage;
    try {
      msg = JSON.parse(data.toString()) as WireMessage;
    } catch {
      return; // ignore malformed frames
    }
    // JSON.parse can yield null / primitives — a bare `null` or `"5"` frame
    // must not reach `msg.type` and crash the listener.
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") {
      return;
    }

    const conn = this.bySocket.get(client);

    switch (msg.type) {
      case "hello": {
        this.acceptHello(client, msg);
        break;
      }
      case "ping": {
        if (!conn) break; // only established sockets heartbeat
        conn.lastHeartbeatAt = Date.now();
        conn.send({ type: "pong", at: Date.now() });
        break;
      }
      case "pong": {
        if (!conn) break;
        conn.lastHeartbeatAt = Date.now();
        break;
      }
      case "response": {
        if (!conn) break; // ignore responses from a stale/staged socket
        const payload = msg.payload;
        if (!payload || typeof payload !== "object" || typeof payload.id !== "string") break;
        conn.onResponse(payload);
        break;
      }
      case "bind": {
        // The user picked an agent session in this window's plugin UI: bind
        // the session to this channel. The session's next op carries a
        // warning so the agent learns about the pairing immediately.
        if (!conn) break;
        if (typeof msg.sessionId !== "string" || msg.sessionId.length === 0 || msg.sessionId.length > 128) break;
        // Unbounded growth guard: any client can mint session ids — cap the
        // map and evict the oldest binding first (Map iterates in insertion
        // order).
        if (this.sessionBindings.size >= 512 && !this.sessionBindings.has(msg.sessionId)) {
          const oldest = this.sessionBindings.keys().next().value;
          if (oldest !== undefined) this.sessionBindings.delete(oldest);
        }
        this.sessionBindings.set(msg.sessionId, { channel: conn.channel, notified: false });
        this.broadcastChannels();
        break;
      }
      default:
        break; // "request"/"assigned"/"channels" are server→plugin only
    }
  }

  /** Push the current windows+sessions snapshot to every established plugin. */
  private broadcastChannels(): void {
    const channels = [...this.channels.values()].map((c) => ({
      channel: c.channel,
      fileName: c.info.fileName,
      pageName: c.info.pageName,
    }));
    const sessions = (this.sessionsProvider?.() ?? []).map((s) => ({
      ...s,
      boundChannel: this.sessionBindings.get(s.id)?.channel ?? null,
    }));
    for (const conn of this.channels.values()) {
      conn.send({ type: "channels", self: conn.channel, channels, sessions });
    }
  }

  private acceptHello(client: WebSocket, hello: PluginHello): void {
    const established = this.bySocket.get(client);
    if (established) {
      // Re-hello from an established socket: the plugin refreshes its file /
      // page info (ui.html re-sends hello on page change). Update info in
      // place; the channel of a live connection never changes (changing
      // channel is a reconnect in the UI).
      established.info = {
        ...established.info,
        version: hello.pluginVersion,
        ...(hello.pluginBuild ? { build: hello.pluginBuild } : {}),
        protocolVersion: hello.protocolVersion,
        fileKey: hello.fileKey,
        fileName: hello.fileName,
        pageName: hello.pageName,
        editorType: hello.editorType,
      };
      established.lastHeartbeatAt = Date.now();
      return;
    }

    const staged = this.stagedSockets.get(client);
    if (!staged) {
      return; // a hello from a socket we already discarded
    }
    clearTimeout(staged);
    this.stagedSockets.delete(client);

    const requested = sanitizeChannel(hello.channel);
    const offeredResume =
      typeof hello.resumeToken === "string" && hello.resumeToken.length > 0
        ? hello.resumeToken
        : "";

    // Reclaiming an existing channel requires the resume token issued on
    // first assign. A hello that only knows the channel *name* (e.g. from
    // unauthenticated GET /health) gets a fresh channel instead of stealing.
    let channel = requested;
    let resumeToken = newResumeToken();
    const previous = channel ? this.channels.get(channel) : undefined;
    if (previous) {
      if (offeredResume && safeEqualString(offeredResume, previous.resumeToken)) {
        resumeToken = previous.resumeToken;
        previous.failAllPending(
          new OpError(
            ErrorCode.NOT_CONNECTED,
            `Plugin connection on channel "${channel}" was replaced by a new Figma window.`,
            "Retry the operation; the new plugin connection is now active.",
          ),
        );
        this.bySocket.delete(previous.ws);
        if (previous.ws !== client) {
          try {
            previous.ws.close(1000, "replaced");
          } catch {
            /* ignore */
          }
        }
      } else {
        channel = "";
      }
    }
    if (!channel) channel = this.generateChannel();

    const info: PluginInfo = {
      version: hello.pluginVersion,
      ...(hello.pluginBuild ? { build: hello.pluginBuild } : {}),
      protocolVersion: hello.protocolVersion,
      fileKey: hello.fileKey,
      fileName: hello.fileName,
      pageName: hello.pageName,
      editorType: hello.editorType,
      connectedAt: Date.now(),
    };

    const conn = new PluginConnection(channel, client, info, resumeToken);
    this.channels.set(channel, conn);
    this.bySocket.set(client, conn);

    // Tell the plugin which channel it is joined to (it shows this to the
    // user so they can point specific agents at specific windows).
    conn.send({ type: "assigned", channel, resumeToken });

    // Zero-config path: ops issued before any window connected wait in the
    // unrouted queue — hand them to this connection now.
    if (this.unrouted.length > 0 && this.channels.size === 1) {
      for (const item of this.unrouted.splice(0)) {
        conn.enqueue(item.request, item.pending);
      }
    }

    conn.drainQueue();
    this.broadcastChannels();
  }

  private onWsClose(client: WebSocket): void {
    const staged = this.stagedSockets.get(client);
    if (staged) {
      clearTimeout(staged);
      this.stagedSockets.delete(client);
      return; // a never-handshaked socket died; nothing else to do
    }
    const conn = this.bySocket.get(client);
    if (!conn) {
      return; // an old, already-replaced socket closing
    }
    this.bySocket.delete(client);
    this.channels.delete(conn.channel);
    conn.failAllPending(
      new OpError(
        ErrorCode.NOT_CONNECTED,
        `Figma plugin on channel "${conn.channel}" disconnected.`,
        "Open the Reqwise plugin in Figma (Plugins → Reqwise) and wait for it to reconnect.",
      ),
    );
    // Session bindings to this channel are kept: the window usually reconnects
    // on the same channel (the plugin UI persists it). Resolution skips dead
    // bindings, so they are harmless while the window is away.
    this.broadcastChannels();
  }

  // ---- dispatch / routing ----

  /**
   * Send one validated op to the plugin on the resolved channel and await its
   * response. Callers must have run it through validateOperation() first.
   * `batch` streaming is done by executor.ts issuing one dispatch per chunk.
   */
  dispatch(op: Operation, params: Record<string, unknown>, opts: DispatchOptions = {}): Promise<BridgeResponse> {
    return new Promise<BridgeResponse>((resolve, reject) => {
      const id = randomUUID();
      const timeoutMs = opts.timeoutMs ?? OP_TIMEOUTS[op] ?? DEFAULT_OP_TIMEOUT_MS;
      // The timeout timer is NOT armed here: a queued op must not spend its
      // budget while waiting behind an in-flight op. The connection arms it at
      // the moment the op is put on the wire (drainQueue).
      const pending: Pending = {
        id,
        op,
        resolve,
        reject,
        timeoutMs,
        ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
      };
      const request: BridgeRequest = { id, op, params, ...(opts.chunk ? { chunk: opts.chunk } : {}) };

      // Explicit channel → exactly that window.
      if (opts.channel) {
        const conn = this.channels.get(opts.channel);
        if (!conn) {
          reject(
            new OpError(
              ErrorCode.CHANNEL_NOT_FOUND,
              `No Figma window is connected on channel "${opts.channel}".`,
              this.channels.size > 0
                ? `Connected channels: ${this.describeChannels()}. Use figma_read {op:"list_channels"} and pick one, or enter "${opts.channel}" in the plugin UI of the window you want.`
                : "No plugin is connected at all. Open the Reqwise plugin in Figma and check its channel chip.",
            ),
          );
          return;
        }
        conn.enqueue(request, pending);
        return;
      }

      // Figma-side pairing: the user bound this agent session to a window in
      // the plugin UI. The first routed op carries a warning back so the
      // agent learns about the pairing without polling figma_status.
      if (opts.sessionId) {
        const binding = this.sessionBindings.get(opts.sessionId);
        const conn = binding ? this.channels.get(binding.channel) : undefined;
        if (binding && conn) {
          if (!binding.notified) {
            binding.notified = true;
            const notice = `The user bound this session to channel "${binding.channel}" (${conn.info.fileName || "untitled"}) from the Figma plugin UI — operations now route to that window by default.`;
            const inner = pending.resolve;
            pending.resolve = (res) =>
              inner({ ...res, warnings: [...(res.warnings ?? []), notice] });
          }
          conn.enqueue(request, pending);
          return;
        }
      }

      // No channel: zero-config when unambiguous.
      if (this.channels.size === 1) {
        const conn = this.channels.values().next().value as PluginConnection;
        conn.enqueue(request, pending);
        return;
      }
      if (this.channels.size === 0) {
        // Wait for the first window — same UX as the single-connection bridge.
        if (this.unrouted.length >= MAX_QUEUE) {
          reject(
            new OpError(
              ErrorCode.QUEUE_FULL,
              `Request queue is full (${this.unrouted.length}/${MAX_QUEUE}) — no plugin is connected to drain the queue.`,
              "Open the Reqwise Figma plugin so queued operations can run.",
            ),
          );
          return;
        }
        this.unrouted.push({ request, pending });
        return;
      }

      // Several windows and no channel — make the caller pick.
      reject(
        new OpError(
          ErrorCode.AMBIGUOUS_CHANNEL,
          `${this.channels.size} Figma windows are connected — specify which channel to target.`,
          `Connected channels: ${this.describeChannels()}. Pass channel in the tool call (figma_write/figma_read {channel}), list details with figma_read {op:"list_channels"} — or ask the user to pick this agent session in the plugin UI of the window they want.`,
        ),
      );
    });
  }

  private describeChannels(): string {
    return [...this.channels.values()]
      .map((c) => `"${c.channel}" (${c.info.fileName || "untitled"} · ${c.info.pageName || "?"})`)
      .join(", ");
  }

  private generateChannel(): string {
    for (let attempt = 0; attempt < 32; attempt++) {
      const adj = CHANNEL_ADJECTIVES[randomInt(CHANNEL_ADJECTIVES.length)];
      const noun = CHANNEL_NOUNS[randomInt(CHANNEL_NOUNS.length)];
      const name = `${adj}-${noun}-${randomInt(10, 100)}`;
      if (!this.channels.has(name)) return name;
    }
    return `channel-${randomUUID().slice(0, 8)}`;
  }

  // ---- HTTP ----

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      // Absolute-form request-targets llhttp accepts but URL rejects (e.g. an
      // out-of-range port) must not escape the 'request' listener.
      this.respondJson(res, 400, { error: "bad request" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/health") {
      this.respondJson(res, 200, this.healthPayload(this.isAuthorized(req)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/rpc") {
      void this.handleRpc(req, res);
      return;
    }
    this.respondJson(res, 404, { error: "not found" });
  }

  private async handleRpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = req.headers["authorization"];
    const token = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!this.authToken || !token || !safeEqualString(token, this.authToken)) {
      this.respondJson(res, 401, {
        error: { code: ErrorCode.UNAUTHORIZED, message: "Invalid or missing bridge token.", hint: "Follower must send Authorization: Bearer <leader token from leader.json>." },
      });
      return;
    }

    let body: { op?: string; params?: Record<string, unknown>; sessionId?: string; channel?: string };
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      this.respondJson(res, 400, {
        error: { code: ErrorCode.INVALID_PARAMS, message: "Body must be JSON.", hint: "POST { op, params, sessionId?, channel? }." },
      });
      return;
    }

    if (!this.handlers.onRpc) {
      this.respondJson(res, 500, {
        error: { code: ErrorCode.INTERNAL, message: "RPC handler not wired.", hint: "This is a server bug." },
      });
      return;
    }

    try {
      // NOTE: onRpc runs the op through the SAME validateOperation choke point
      // as leader-direct calls — see index.ts wiring. No bypass.
      const result = await this.handlers.onRpc(body.op ?? "", body.params ?? {}, body.sessionId, body.channel);
      this.respondJson(res, 200, { ok: true, result });
    } catch (err) {
      this.respondJson(res, 200, { ok: false, error: toBridgeError(err) });
    }
  }

  /**
   * Public /health stays minimal so channel names / file names are not an
   * unauthenticated local oracle for WS hijacks. Pass the bridge Bearer
   * token for the full diagnostics payload (followers that need detail use
   * __status__ over /rpc instead).
   */
  private healthPayload(detailed: boolean): Record<string, unknown> {
    const base: Record<string, unknown> = {
      ok: true,
      port: this.boundPort,
      pluginConnected: this.pluginConnected,
      lastHeartbeatMs: this.lastHeartbeatMs,
      queueLength: this.queueLength,
      pendingCount: this.pendingCount,
      channelCount: this.channels.size,
    };
    if (!detailed) return base;
    return {
      ...base,
      plugin: this.plugin ?? null,
      channels: this.channelSummaries(),
    };
  }

  private isAuthorized(req: IncomingMessage): boolean {
    const auth = req.headers["authorization"];
    const token = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : "";
    return Boolean(this.authToken && token && safeEqualString(token, this.authToken));
  }

  // ---- heartbeat monitor ----

  private startHeartbeatMonitor(): void {
    this.heartbeatTimer = setInterval(() => {
      for (const conn of this.channels.values()) {
        if (conn.ws.readyState === WebSocket.OPEN) {
          // Proactively ping so we notice a silent-dead socket within DEAD window.
          conn.send({ type: "ping", at: Date.now() });
          if (Date.now() - conn.lastHeartbeatAt > HEARTBEAT_DEAD_MS) {
            try {
              conn.ws.terminate();
            } catch {
              /* close handler cleans up */
            }
          }
        }
      }
      // Keep the plugin UI's session picker fresh (activity/lastUsed change
      // without any WS event).
      if (this.channels.size > 0) this.broadcastChannels();
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  // ---- utils ----

  private respondJson(res: ServerResponse, status: number, body: unknown): void {
    const json = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(json) });
    res.end(json);
  }

  async close(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    const shutdownErr = new OpError(ErrorCode.INTERNAL, "Bridge shutting down.", "Server is stopping.");
    for (const conn of this.channels.values()) {
      conn.failAllPending(shutdownErr);
    }
    for (const item of this.unrouted.splice(0)) {
      clearTimeout(item.pending.timer);
      item.pending.reject(shutdownErr);
    }
    // Terminate any live sockets first — WebSocketServer.close() otherwise
    // waits indefinitely for open clients to close.
    if (this.wss) {
      for (const client of this.wss.clients) {
        try {
          client.terminate();
        } catch {
          /* ignore */
        }
      }
    }
    this.channels.clear();
    this.bySocket.clear();
    for (const t of this.stagedSockets.values()) clearTimeout(t);
    this.stagedSockets.clear();
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      if (!this.http) return resolve();
      this.http.closeAllConnections?.();
      this.http.close(() => resolve());
    });
  }
}

/** Allow letters, digits, dashes, underscores, dots; cap length. Anything
 * else (or empty) → "" so the server assigns a generated channel. */
function sanitizeChannel(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!/^[\w.-]{1,64}$/.test(trimmed)) return "";
  return trimmed;
}

function hasResult(res: BridgeResponse): boolean {
  return Object.prototype.hasOwnProperty.call(res, "result");
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => {
      data += c;
      if (data.length > 8 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy(); // stop the client streaming into memory after the cap
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
