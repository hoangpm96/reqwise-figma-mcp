/**
 * Leader election + coordinator.
 *
 * First process to bind the bridge port becomes the LEADER: it writes
 * LeaderInfo (with a random token) to $TMPDIR/reqwise-figma-mcp/
 * leader-<port>.json at mode 0600 and services operations directly against
 * its bridge. Discovery is PER-PORT: a leader owns its port exclusively, so
 * it owns its discovery file exclusively — several legitimate leaders on
 * different ports (custom FIGMA_MCP_PORT cohorts, default port once squatted)
 * coexist without ever contending for one file. The legacy global leader.json
 * is still written best-effort for old-version followers.
 *
 * A process that hits EADDRINUSE verifies the incumbent via GET /health and
 * becomes a FOLLOWER, forwarding every operation via POST /rpc with the
 * leader's Bearer token. Followers run a jittered 3–5 s health monitor and,
 * on leader death (health unreachable + stale/removed token file), attempt
 * takeover by re-running election. A 401 from the leader triggers a re-read
 * of the discovery file (the leader restarted with a fresh token) before the
 * error is surfaced.
 *
 * CRITICAL: the `runValidated` callback — passed in by index.ts — wraps
 * validateOperation() and is invoked in exactly ONE place per role:
 *   - leader: for both its own tool calls AND for /rpc forwards (Bridge.onRpc).
 *   - follower: before forwarding, the follower ALSO validates locally so a
 *     bad op never even leaves the machine; the leader validates again on
 *     receipt. Either way an op cannot reach the bridge unvalidated.
 */
import { mkdir, writeFile, readFile, rename, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { Bridge } from "./bridge.js";
import { DEFAULT_PORT, PORT_RANGE, type LeaderInfo } from "../shared/protocol.js";
import { baseDir, leaderFilePath, leaderFilePathFor } from "./paths.js";
import { VERSION } from "./version.js";
import { ErrorCode, OpError, toBridgeError } from "./errors.js";
import { Follower } from "./follower.js";

export type Role = "leader" | "follower";

/**
 * Runs one validated op end-to-end (validate → bridge dispatch). index.ts
 * supplies this; it is the single validation choke point. Signature matches
 * both the leader-direct path and the /rpc path. `channel` targets a specific
 * Figma window; `sessionId` also feeds Figma-side session→channel bindings.
 */
export type RunValidated = (
  op: string,
  params: Record<string, unknown>,
  sessionId?: string,
  channel?: string,
) => Promise<unknown>;

export interface CoordinatorDeps {
  /** Validate + dispatch (leader path). Also used for /rpc forwards. */
  runValidated: RunValidated;
  /**
   * Fires for EVERY bridge this coordinator ever creates — the initial
   * election AND any follower→leader takeover. Wiring (sessions provider,
   * etc.) must happen here, not once after start(); a takeover creates a NEW
   * Bridge and one-time wiring left the replacement bridge dead (real bug:
   * every op after a takeover failed NOT_CONNECTED).
   */
  onBridgeCreated?: (bridge: Bridge) => void;
  /** Health poll interval bounds (ms); default 3000–5000 jittered. */
  healthIntervalMs?: [number, number];
  startPort?: number;
}

export class Coordinator {
  role: Role = "leader";
  bridge?: Bridge;
  follower?: Follower;
  private leaderInfo?: LeaderInfo;
  private healthTimer?: NodeJS.Timeout;
  private closed = false;
  /**
   * Guards against an unbounded elect→follow→elect loop (e.g. a foreign
   * process squatting the port with no valid leader file) WITHIN one election
   * run. Reset at the top of every start(): the counter previously persisted
   * across runs, so once a takeover attempt exhausted it, every later attempt
   * threw instantly — the follower could never take over even after the
   * blocking condition cleared.
   */
  private electionAttempts = 0;
  private static readonly MAX_ELECTION_ATTEMPTS = 5;

  constructor(private readonly deps: CoordinatorDeps) {}

  /**
   * Elect role by walking the port range once. For each port, in order:
   *   1. If a live Reqwise server already answers /health there → FOLLOW it
   *      (read its token from leader-<port>.json, falling back to the legacy
   *      leader.json). This is the fix for the "every window becomes its own
   *      leader" bug: a second instance now discovers the incumbent instead
   *      of grabbing the next free port.
   *   2. Else try to BIND it → become LEADER. A foreign process that squats a
   *      port (health check fails) is skipped so a Reqwise leader can still
   *      live on a higher port (the plugin walks the same range to find it).
   * Ties/races on the same port (bind loses to a peer that just came up) are
   * resolved by a bounded retry of the whole election. Each start() call is a
   * fresh run with a fresh retry budget.
   */
  async start(): Promise<Role> {
    this.electionAttempts = 0;
    return this.elect();
  }

  private async elect(): Promise<Role> {
    this.electionAttempts++;
    if (this.electionAttempts > Coordinator.MAX_ELECTION_ATTEMPTS) {
      throw new Error(
        `Could not become leader or follower after ${Coordinator.MAX_ELECTION_ATTEMPTS} attempts — ` +
          `port ${this.deps.startPort ?? DEFAULT_PORT}..+${PORT_RANGE - 1} may be held by a non-Reqwise process. ` +
          `Free one of those ports, or set FIGMA_MCP_PORT to a free port in ` +
          `${DEFAULT_PORT}-${DEFAULT_PORT + PORT_RANGE - 1} (the range the Figma plugin scans).`,
      );
    }
    const startPort = this.deps.startPort ?? DEFAULT_PORT;
    const token = randomBytes(24).toString("hex");

    for (let i = 0; i < PORT_RANGE; i++) {
      const port = startPort + i;

      // 1. A Reqwise leader already lives here → follow it (or retry on race).
      if (await Follower.checkHealth(port)) {
        const followed = await this.tryFollowOn(port);
        if (followed) return "follower";
        // It answers /health but its discovery file isn't visible/matching
        // yet (it is still starting up). Back off and re-run the election.
        await delay(250);
        return this.elect();
      }

      // 2. Nothing (or a foreign process) here → try to become leader.
      const bridge = new Bridge({
        // The /rpc forward path: a follower forwarded an op → leader runs it
        // through the SAME validate+dispatch choke point as its own calls.
        onRpc: (op, params, sessionId, channel) => this.deps.runValidated(op, params, sessionId, channel),
      });
      try {
        const bound = await bridge.listen(port, token);
        this.bridge = bridge;
        this.role = "leader";
        this.leaderInfo = { port: bound, token, pid: process.pid, startedAt: Date.now(), version: VERSION };
        await this.writeLeaderFile(this.leaderInfo);
        this.electionAttempts = 0;
        this.deps.onBridgeCreated?.(bridge);
        return "leader";
      } catch (err) {
        await bridge.close().catch(() => {});
        if (!isAddrInUse(err)) throw err;
        // The port was taken between the health check and our bind. If a
        // Reqwise peer grabbed it, re-run election so we follow it; if a
        // foreign process took it, move on to the next port.
        if (await Follower.checkHealth(port)) {
          await delay(200);
          return this.elect();
        }
        continue;
      }
    }

    // Whole range is held by foreign/unhealthy processes.
    await delay(250);
    return this.elect();
  }

  /**
   * Become a follower of the Reqwise leader on `port`, using the token from
   * leader-<port>.json (or the legacy leader.json for an old-version leader).
   * Returns false if no discovery file matches (startup race) so the caller
   * can retry election.
   */
  private async tryFollowOn(port: number): Promise<boolean> {
    const info = await this.readLeaderFile(port);
    if (!info || info.port !== port || !info.token) return false;
    this.role = "follower";
    this.follower = new Follower(info);
    this.startHealthMonitor();
    this.electionAttempts = 0;
    return true;
  }

  /** Follower path used by index.ts to run an op (validate happens upstream). */
  async forward(
    op: string,
    params: Record<string, unknown>,
    sessionId?: string,
    channel?: string,
    timeoutMs?: number,
  ): Promise<unknown> {
    if (!this.follower) {
      throw new OpError(ErrorCode.INTERNAL, "forward() called without a follower.", "This is a server bug.");
    }
    try {
      return await this.follower.forward(op, params, sessionId, channel, timeoutMs);
    } catch (err) {
      // 401: the leader restarted on the same port with a fresh token (e.g.
      // the user reloaded that window's MCP server). /health stays green, so
      // the health monitor never notices — without this refresh every forward
      // 401s forever and the only way out was restarting this follower too.
      if (
        err instanceof OpError &&
        err.code === ErrorCode.UNAUTHORIZED &&
        (await this.refreshFollowerInfo())
      ) {
        return this.follower.forward(op, params, sessionId, channel, timeoutMs);
      }
      throw err;
    }
  }

  /**
   * Re-read the discovery file for the followed port and adopt a CHANGED
   * token. Returns true only when a fresh, different token was found — the
   * caller then retries exactly once (an unchanged token means the 401 has
   * some other cause and must surface).
   */
  private async refreshFollowerInfo(): Promise<boolean> {
    const stale = this.follower?.info;
    if (!stale) return false;
    const fresh = await this.readLeaderFile(stale.port);
    if (!fresh || fresh.port !== stale.port || !fresh.token || fresh.token === stale.token) {
      return false;
    }
    this.follower = new Follower(fresh);
    return true;
  }

  private startHealthMonitor(): void {
    const [lo, hi] = this.deps.healthIntervalMs ?? [3000, 5000];
    const tick = async () => {
      if (this.closed || this.role !== "follower" || !this.follower) return;
      const alive = await Follower.checkHealth(this.follower.info.port).catch(() => false);
      if (!alive) {
        // Leader looks dead — attempt takeover by re-electing.
        this.stopHealthMonitor();
        try {
          await this.removeLeaderFileIfStale(this.follower.info);
          await this.start();
        } catch {
          // Election lost the race (someone else took over) → resume follow.
          this.startHealthMonitor();
        }
        return;
      }
      this.scheduleHealth(lo, hi, tick);
    };
    this.scheduleHealth(lo, hi, tick);
  }

  private scheduleHealth(lo: number, hi: number, tick: () => void): void {
    const jitter = lo + Math.floor(Math.random() * Math.max(1, hi - lo));
    this.healthTimer = setTimeout(tick, jitter);
    this.healthTimer.unref?.();
  }

  private stopHealthMonitor(): void {
    if (this.healthTimer) clearTimeout(this.healthTimer);
    this.healthTimer = undefined;
  }

  // ---- leader file I/O ----

  /**
   * Publish this leader's info.
   *
   * The authoritative record is PER-PORT (leader-<port>.json). Owning the
   * bound port means owning that file — no other LIVE leader can legitimately
   * write it, so publication never contends. (The previous single global
   * leader.json meant a second leader on another port — normal when
   * FIGMA_MCP_PORT is set — either clobbered a healthy incumbent's entry and
   * later deleted it on exit, stranding an undiscoverable live leader, or
   * "deferred" and became undiscoverable itself, wedging every later
   * election. Per-port files remove the shared resource entirely.)
   *
   * The legacy global leader.json is still written for old-version followers
   * (mixed-version rollout), best-effort: defer to a DIFFERENT live leader —
   * never clobber a healthy incumbent's entry — but take over from a corpse.
   */
  private async writeLeaderFile(info: LeaderInfo): Promise<void> {
    await mkdir(baseDir(), { recursive: true });
    await writeInfoFileAtomic(leaderFilePathFor(info.port), info);
    const current = await readInfoFile(leaderFilePath());
    if (current && current.port !== info.port && (await Follower.checkHealth(current.port))) {
      return; // a live incumbent owns the legacy entry
    }
    await writeInfoFileAtomic(leaderFilePath(), info);
  }

  /**
   * Discovery read for the leader on `port`: leader-<port>.json first, then
   * the legacy leader.json (an old-version leader publishes only there).
   */
  async readLeaderFile(port: number): Promise<LeaderInfo | undefined> {
    const perPort = await readInfoFile(leaderFilePathFor(port));
    if (perPort && perPort.port === port) return perPort;
    const legacy = await readInfoFile(leaderFilePath());
    if (legacy && legacy.port === port) return legacy;
    return undefined;
  }

  /**
   * Remove discovery files that still record `known` — and ONLY then.
   * Identity is pid + startedAt + port: matching on pid+startedAt alone let a
   * leader on ANOTHER port delete the live leader's legacy entry on shutdown,
   * leaving a healthy leader with no discoverable token — every new process
   * then failed election and exited silently.
   */
  private async removeLeaderFileIfStale(known: LeaderInfo): Promise<void> {
    const owns = (info: LeaderInfo | undefined): boolean =>
      !!info &&
      info.pid === known.pid &&
      info.startedAt === known.startedAt &&
      info.port === known.port;
    if (owns(await readInfoFile(leaderFilePathFor(known.port)))) {
      await rm(leaderFilePathFor(known.port), { force: true });
    }
    if (owns(await readInfoFile(leaderFilePath()))) {
      await rm(leaderFilePath(), { force: true });
    }
  }

  info(): LeaderInfo | undefined {
    return this.leaderInfo ?? this.follower?.info;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopHealthMonitor();
    if (this.role === "leader") {
      await this.removeLeaderFileIfStale(this.leaderInfo!).catch(() => {});
      await this.bridge?.close().catch(() => {});
    }
  }
}

function isAddrInUse(err: unknown): boolean {
  if (err instanceof OpError) {
    // Bridge maps "whole range busy" to INTERNAL; treat as addr-in-use too so
    // a fully-occupied range still results in follower election.
    return err.code === ErrorCode.INTERNAL && /No free port/.test(err.message);
  }
  return !!err && typeof err === "object" && (err as { code?: string }).code === "EADDRINUSE";
}

/** Parse a discovery file; undefined on absence, torn JSON, or bad shape. */
async function readInfoFile(path: string): Promise<LeaderInfo | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    const info = JSON.parse(raw) as LeaderInfo;
    if (typeof info.port === "number" && typeof info.token === "string") {
      return info;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write at mode 0600 (only the owner may read the token) via tmp + rename:
 * readers never observe a torn file, and two racing writers can't interleave
 * — the last rename wins wholesale.
 */
async function writeInfoFileAtomic(path: string, info: LeaderInfo): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(info, null, 2), { mode: 0o600 });
  await rename(tmp, path);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}

export { toBridgeError };
