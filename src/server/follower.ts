/**
 * Follower: forwards operations to the leader via POST /rpc with the leader's
 * Bearer token (read from leader.json). Also exposes a static /health probe
 * used by discovery + the health monitor.
 *
 * A follower validates locally before forwarding (defence in depth) and the
 * leader validates again on receipt — the /rpc handler routes through the same
 * validateOperation choke point, so there is no forwarded-op bypass.
 */
import { request as httpRequest } from "node:http";
import type { LeaderInfo } from "../shared/protocol.js";
import type { ChannelSummary } from "./bridge.js";
import { ErrorCode, OpError, toBridgeError } from "./errors.js";

const RPC_TIMEOUT_MS = 130_000; // > VM_TIMEOUT_MS so the leader owns the timeout
/**
 * Diagnostic calls (__status__) read leader-local state and never touch the
 * plugin, so they must not inherit the drawing-op timeout — a figma_status that
 * blocks for 130s is worse than one that reports "unknown" in 2s.
 */
export const STATUS_RPC_TIMEOUT_MS = 2_000;

/** The leader's GET /health body. Every field is optional — an older leader
 * may not send all of them, and a missing field means UNKNOWN, not false. */
export interface HealthPayload {
  ok?: boolean;
  port?: number;
  pluginConnected?: boolean;
  plugin?: {
    version: string;
    protocolVersion: number;
    fileName: string;
    pageName: string;
    editorType: string;
  } | null;
  channels?: ChannelSummary[];
  lastHeartbeatMs?: number;
  queueLength?: number;
  pendingCount?: number;
}

export class Follower {
  constructor(public readonly info: LeaderInfo) {}

  /** GET /health — resolves true iff the leader answers with ok:true. */
  static async checkHealth(port: number, timeoutMs = 1500): Promise<boolean> {
    const payload = await Follower.fetchHealth(port, timeoutMs);
    return payload?.ok === true;
  }

  /**
   * GET /health — the leader's full status payload, or undefined if it could
   * not be read. Unauthenticated and present in EVERY server version, so it is
   * the compatibility fallback when a leader is too old to know __status__
   * (mixed-version rollout: new follower, old leader still running).
   */
  static fetchHealth(port: number, timeoutMs = 1500): Promise<HealthPayload | undefined> {
    return new Promise((resolve) => {
      const req = httpRequest(
        { host: "127.0.0.1", port, path: "/health", method: "GET", timeout: timeoutMs },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            try {
              resolve(JSON.parse(data) as HealthPayload);
            } catch {
              resolve(undefined);
            }
          });
        },
      );
      req.on("error", () => resolve(undefined));
      req.on("timeout", () => {
        req.destroy();
        resolve(undefined);
      });
      req.end();
    });
  }

  /** Forward one op to the leader. Throws OpError on transport/leader error. */
  forward(
    op: string,
    params: Record<string, unknown>,
    sessionId?: string,
    channel?: string,
    timeoutMs: number = RPC_TIMEOUT_MS,
  ): Promise<unknown> {
    const body = JSON.stringify({
      op,
      params,
      ...(sessionId ? { sessionId } : {}),
      ...(channel ? { channel } : {}),
    });
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: this.info.port,
          path: "/rpc",
          method: "POST",
          timeout: timeoutMs,
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
            authorization: `Bearer ${this.info.token}`,
          },
        },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            if (res.statusCode === 401) {
              reject(
                new OpError(
                  ErrorCode.UNAUTHORIZED,
                  "Leader rejected the bridge token (401).",
                  // The coordinator auto-refreshes from the discovery file on
                  // 401 — reaching the user means that refresh found no newer
                  // token, so a restart is genuinely the next step.
                  "The leader restarted with a new token and no fresh discovery file was found — restart this MCP process to re-elect.",
                ),
              );
              return;
            }
            try {
              const json = JSON.parse(data) as {
                ok?: boolean;
                result?: unknown;
                error?: { code: ErrorCode; message: string; hint?: string };
              };
              if (json.ok === true) {
                resolve(json.result);
              } else if (json.error) {
                reject(new OpError(json.error.code, json.error.message, json.error.hint));
              } else {
                reject(new OpError(ErrorCode.INTERNAL, "Malformed /rpc response from leader.", "Leader/follower version mismatch — restart both."));
              }
            } catch {
              reject(new OpError(ErrorCode.INTERNAL, `Unparseable /rpc response (HTTP ${res.statusCode}).`, "Check the leader is a Reqwise MCP server."));
            }
          });
        },
      );
      req.on("error", (err) => reject(toOpError(err)));
      req.on("timeout", () => {
        req.destroy();
        reject(new OpError(ErrorCode.PLUGIN_TIMEOUT, `Forward of "${op}" to leader timed out.`, "The leader may be busy or dead — health monitor will attempt takeover."));
      });
      req.write(body);
      req.end();
    });
  }
}

function toOpError(err: unknown): OpError {
  const be = toBridgeError(err, ErrorCode.NOT_CONNECTED, "Could not reach the leader server on /rpc — it may have died; takeover will be attempted.");
  return new OpError(be.code, be.message, be.hint);
}
