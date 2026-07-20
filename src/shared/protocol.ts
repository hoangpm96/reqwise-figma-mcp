/**
 * Shared protocol between the MCP server and the Figma plugin.
 * This file is the single source of truth for operation names, message
 * shapes, error codes and timeouts. Both sides import it; the executor
 * proxy, the server-side validator and the plugin handler registry are
 * all derived from OPERATIONS so the layers cannot drift.
 */

export const PROTOCOL_VERSION = 3;

/** Default bridge port; server falls back to +1..+9 when busy. */
export const DEFAULT_PORT = 38470;
export const PORT_RANGE = 10;

/** Read operations executed by the plugin. */
export const READ_OPERATIONS = [
  "get_document_info",
  "get_selection",
  "get_design_context",
  "get_node",
  "get_nodes",
  "search_nodes",
  "scan_text_nodes",
  "scan_nodes_by_types",
  "get_styles",
  "get_variables",
  "get_components",
  "get_component",
  "get_library_component",
  "get_design_system_kit",
  "generate_design_md",
  "screenshot",
  "export_node",
  "get_fonts",
  // Token export reads variables and serializes (DTCG/CSS/Tailwind).
  "export_tokens",
  "layout_audit",
  // Selection-first editing: deep read of the current selection in one call.
  "read_selection",
] as const;

/** Write operations executed by the plugin. */
export const WRITE_OPERATIONS = [
  "create",
  "modify",
  "delete",
  "clone",
  "move",
  "resize",
  "group",
  "ungroup",
  "flatten",
  "batch",
  "find_component",
  "find_or_create_component",
  "instantiate",
  "create_variants",
  "arrange_component_set",
  "set_component_description",
  "componentize",
  "setup_tokens",
  "apply_variable",
  "create_variable",
  "update_variable",
  "rename_variable",
  "delete_variable",
  "import_tokens",
  "set_text",
  "load_icon",
  "load_image",
  "create_page",
  "set_current_page",
  "create_overlay",
  "set_selection",
  "zoom_to_fit",
  // Composite edit-in-place write ops (business logic in the plugin, not a
  // 1:1 property set): borrowed/adapted from claude-/cursor-talk-to-figma.
  "get_instance_overrides",
  "set_instance_overrides",
  "detach_instance",
  "reset_instance_overrides",
  "set_selection_colors",
  "set_gradient",
  "set_effects",
] as const;

export type ReadOperation = (typeof READ_OPERATIONS)[number];
export type WriteOperation = (typeof WRITE_OPERATIONS)[number];
export type Operation = ReadOperation | WriteOperation;

export const OPERATIONS: readonly Operation[] = [
  ...READ_OPERATIONS,
  ...WRITE_OPERATIONS,
];

/**
 * Operations answered by the SERVER (bridge state), never dispatched to the
 * plugin. Kept out of OPERATIONS so the plugin handler registry — which must
 * cover every plugin-executed op — does not expect handlers for them.
 * Followers still forward these over /rpc like any other op.
 */
export const SERVER_OPERATIONS = ["list_channels"] as const;
export type ServerOperation = (typeof SERVER_OPERATIONS)[number];
export type AnyOperation = Operation | ServerOperation;

export enum ErrorCode {
  NOT_CONNECTED = "NOT_CONNECTED",
  NODE_NOT_FOUND = "NODE_NOT_FOUND",
  FONT_UNAVAILABLE = "FONT_UNAVAILABLE",
  INVALID_PARAMS = "INVALID_PARAMS",
  PLUGIN_TIMEOUT = "PLUGIN_TIMEOUT",
  QUEUE_FULL = "QUEUE_FULL",
  PAGE_LIMIT = "PAGE_LIMIT",
  COMPONENT_IN_USE = "COMPONENT_IN_USE",
  UNAUTHORIZED = "UNAUTHORIZED",
  SANDBOX_ERROR = "SANDBOX_ERROR",
  UNSUPPORTED_OPERATION = "UNSUPPORTED_OPERATION",
  /** Multiple Figma windows are connected and no channel was specified. */
  AMBIGUOUS_CHANNEL = "AMBIGUOUS_CHANNEL",
  /** A channel was specified but no plugin connection is joined to it. */
  CHANNEL_NOT_FOUND = "CHANNEL_NOT_FOUND",
  INTERNAL = "INTERNAL",
}

export interface BridgeError {
  code: ErrorCode;
  message: string;
  /** Concrete next step the calling agent can take to fix the problem. */
  hint?: string;
}

/** Server → plugin. */
export interface BridgeRequest {
  id: string;
  op: Operation;
  params: Record<string, unknown>;
  /** Set when this request is one chunk of a larger batch. */
  chunk?: { index: number; total: number };
}

/** Plugin → server. */
export interface BridgeResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: BridgeError;
  /** Non-fatal issues (e.g. "node will be clipped by parent"). */
  warnings?: string[];
  /** Progress ping for long ops; resets the server-side timeout. */
  progress?: { done: number; total: number; note?: string };
}

/** Plugin → server on WS connect, before any request is dispatched. */
export interface PluginHello {
  type: "hello";
  protocolVersion: number;
  pluginVersion: string;
  fileKey: string | null;
  fileName: string;
  pageName: string;
  editorType: "figma" | "figjam" | "slides" | string;
  /**
   * Channel this Figma window wants to join. Empty/absent (also every
   * protocol-v1 plugin) → the server assigns one and answers with
   * ChannelAssigned. Commands route per-channel, so multiple Figma windows
   * can stay connected simultaneously.
   */
  channel?: string | null;
}

/** Server → plugin after hello: the channel this connection is joined to. */
export interface ChannelAssigned {
  type: "assigned";
  channel: string;
}

/** One agent session as shown in the plugin UI picker. */
export interface SessionSummaryWire {
  id: string;
  writeCount: number;
  lastUsedMs: number;
  /** Channel this session is bound to (via the plugin UI), if any. */
  boundChannel?: string | null;
}

/**
 * Server → plugin: live snapshot of connected windows + agent sessions.
 * Pushed on every join/leave/bind and piggybacked on the heartbeat so the
 * plugin UI can render a picker ("which agent drives this window?").
 */
export interface ChannelsUpdate {
  type: "channels";
  /** The receiving connection's own channel. */
  self: string;
  channels: Array<{ channel: string; fileName: string; pageName: string }>;
  sessions: SessionSummaryWire[];
}

/**
 * Plugin → server: the user picked an agent session in the plugin UI. Binds
 * that session to this connection's channel — the session's subsequent ops
 * route to this window without the agent passing a channel.
 */
export interface BindRequest {
  type: "bind";
  sessionId: string;
}

export interface Heartbeat {
  type: "ping" | "pong";
  at: number;
}

/** WS envelope: everything on the wire is one of these. */
export type WireMessage =
  | { type: "request"; payload: BridgeRequest }
  | { type: "response"; payload: BridgeResponse }
  | PluginHello
  | ChannelAssigned
  | ChannelsUpdate
  | BindRequest
  | Heartbeat;

/** Heartbeat cadence (ms). Plugin sends ping; server answers pong. */
export const HEARTBEAT_INTERVAL_MS = 10_000;
/** No heartbeat for this long → connection considered dead. */
export const HEARTBEAT_DEAD_MS = 30_000;

/** Per-operation timeout budget (ms). Missing key → DEFAULT_OP_TIMEOUT_MS. */
export const DEFAULT_OP_TIMEOUT_MS = 30_000;
export const OP_TIMEOUTS: Partial<Record<Operation, number>> = {
  screenshot: 90_000,
  export_node: 90_000,
  get_design_context: 60_000,
  get_components: 60_000,
  get_component: 60_000,
  // Library import is a network round-trip to the published library.
  get_library_component: 60_000,
  get_design_system_kit: 60_000,
  generate_design_md: 60_000,
  // batch: 30s per chunk — progress messages reset the timer.
  batch: 30_000,
  // Whole-document usage scan before the replace-gate.
  delete_variable: 60_000,
  export_tokens: 60_000,
  import_tokens: 60_000,
};

/** Batch requests are split into chunks of this size and streamed. */
export const BATCH_CHUNK_SIZE = 20;

/** Max vm execution budget for one figma_write call (ms). */
export const VM_TIMEOUT_MS = 120_000;

/** Leader/follower discovery file inside $TMPDIR/reqwise-figma-mcp/. */
export const LEADER_FILE = "leader.json";
export interface LeaderInfo {
  port: number;
  token: string;
  pid: number;
  startedAt: number;
  version: string;
}
