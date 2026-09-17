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
 * Hard ceiling for one forwarded op, however healthy the leader stays. The
 * leader's own per-op budget resets on every progress ping, so a legitimate
 * long-running draw (a large generate or build) can run for many minutes — a fixed 130s
 * socket timeout used to kill the HTTP forward mid-op and report a bogus
 * PLUGIN_TIMEOUT while the leader kept working. Now a timeout is only fatal
 * when the leader has actually died; while it answers /health the wait is
 * re-armed, up to this ceiling.
 */
const FORWARD_HARD_CAP_MS = 30 * 60_000;
/** Budgets at or above this may extend while the leader stays healthy; a
 * shorter one (the __status__ diagnostic) must stay sharp — a busy leader
 * would otherwise hold a 2s status call open until the hard cap. */
const EXTENDABLE_TIMEOUT_FLOOR_MS = 60_000;
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
  /** Present on newer leaders; public /health may omit `channels`. */
  channelCount?: number;
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
          // A response stream errors on ECONNRESET or when req.destroy()
          // lands mid-read — without this the 'error' event is an
          // uncaughtException and kills the follower on exactly the
          // leader-death path the monitor exists to survive.
          res.on("error", () => resolve(undefined));
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
    opts?: {
      /**
       * May a socket timeout extend into a re-armed wait while the leader
       * still answers /health? Defaults to true for op-sized budgets — the
       * leader's own per-op timer resets on progress, so a live leader can
       * legitimately outlive timeoutMs — and false for short diagnostics
       * (__status__), which must not be held open by a busy leader.
       */
      extendWhileAlive?: boolean;
    },
  ): Promise<unknown> {
    const body = JSON.stringify({
      op,
      params,
      ...(sessionId ? { sessionId } : {}),
      ...(channel ? { channel } : {}),
    });
    // Long ops stay within their leader-side budget via progress pings, so a
    // single request can legitimately outlive timeoutMs — a fixed socket
    // timeout used to kill the forward mid-op with a bogus PLUGIN_TIMEOUT and
    // invite a work-duplicating retry. The wait is therefore a watchdog, not
    // a socket timeout: every timeoutMs it asks whether the leader is still
    // alive; only a dead leader (or the hard cap) fails the call. A socket
    // 'timeout' event would NOT work for this — it fires once and calling
    // setTimeout again does not re-arm it.
    const extendable =
      opts?.extendWhileAlive ?? timeoutMs >= EXTENDABLE_TIMEOUT_FLOOR_MS;
    const hardDeadline = Date.now() + Math.max(timeoutMs, FORWARD_HARD_CAP_MS);
    return new Promise((resolve, reject) => {
      let watchdog: NodeJS.Timeout | undefined;
      let checking = false;
      const settle = (fn: () => void) => {
        if (watchdog) {
          clearInterval(watchdog);
          watchdog = undefined;
        }
        fn();
      };
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: this.info.port,
          path: "/rpc",
          method: "POST",
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
          // Same uncaught-'error' guard as fetchHealth: req.destroy() from the
          // watchdog or a dead leader mid-stream would otherwise crash us.
          res.on("error", (err) => settle(() => reject(toOpError(err))));
          res.on("end", () => {
            if (res.statusCode === 401) {
              settle(() =>
                reject(
                  new OpError(
                    ErrorCode.UNAUTHORIZED,
                    "Leader rejected the bridge token (401).",
                    // The coordinator auto-refreshes from the discovery file on
                    // 401 — reaching the user means that refresh found no newer
                    // token, so a restart is genuinely the next step.
                    "The leader restarted with a new token and no fresh discovery file was found — restart this MCP process to re-elect.",
                  ),
                ),
              );
              return;
            }
            settle(() => {
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
          });
        },
      );
      req.on("error", (err) => settle(() => reject(toOpError(err))));
      const timeoutError = (hint: string) =>
        new OpError(
          ErrorCode.PLUGIN_TIMEOUT,
          `Forward of "${op}" to leader timed out.`,
          hint,
        );
      watchdog = setInterval(() => {
        if (checking) return; // a health probe may outlive its own slot
        checking = true;
        void (async () => {
          try {
            if (!extendable || Date.now() >= hardDeadline) {
              const overCap = Date.now() >= hardDeadline;
              req.destroy();
              settle(() =>
                reject(
                  timeoutError(
                    overCap
                      ? `The op is still running on the leader after ${Math.round(FORWARD_HARD_CAP_MS / 60_000)}min — check Figma; retrying may duplicate work.`
                      : "The leader may be busy or dead — health monitor will attempt takeover.",
                  ),
                ),
              );
              return;
            }
            const alive = await Follower.checkHealth(this.info.port).catch(() => false);
            if (!alive) {
              req.destroy();
              settle(() =>
                reject(
                  timeoutError(
                    "The leader stopped answering /health mid-op — health monitor will attempt takeover.",
                  ),
                ),
              );
            }
          } finally {
            checking = false;
          }
        })();
      }, timeoutMs);
      watchdog.unref?.(); // the request socket owns the lifetime, not this timer
      req.write(body);
      req.end();
    });
  }
}

function toOpError(err: unknown): OpError {
  const be = toBridgeError(err, ErrorCode.NOT_CONNECTED, "Could not reach the leader server on /rpc — it may have died; takeover will be attempted.");
  return new OpError(be.code, be.message, be.hint);
}
