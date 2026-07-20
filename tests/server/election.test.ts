import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LeaderInfo } from "../../src/shared/protocol.js";
import { Coordinator } from "../../src/server/leader.js";
import { Bridge } from "../../src/server/bridge.js";
import { leaderFilePathFor, baseDir } from "../../src/server/paths.js";

/**
 * Election regressions around per-port discovery (leader-<port>.json).
 *
 * All three of these were live failure modes of the single-global-file
 * design + a persistent election-attempt counter:
 *  1. A leader that yielded leader.json publication to a live incumbent
 *     became undiscoverable; any new process whose port walk reached it first
 *     burned every election attempt and exited ("deferred-leader livelock").
 *  2. electionAttempts survived across start() runs, so one exhausted
 *     takeover attempt poisoned the Coordinator forever.
 *  3. A leader restarting on the same port with a fresh token left followers
 *     401ing forever — /health stays green, so the health monitor never
 *     noticed, and the token was never re-read.
 */

let dir: string;
let prevTmp: string | undefined;
const coords: Coordinator[] = [];
const bridges: Bridge[] = [];

beforeEach(async () => {
  prevTmp = process.env["TMPDIR"];
  dir = await mkdtemp(join(tmpdir(), "reqwise-election-"));
  process.env["TMPDIR"] = dir;
});

afterEach(async () => {
  while (coords.length) await coords.pop()?.close().catch(() => {});
  while (bridges.length) await bridges.pop()?.close().catch(() => {});
  if (prevTmp === undefined) delete process.env["TMPDIR"];
  else process.env["TMPDIR"] = prevTmp;
  await rm(dir, { recursive: true, force: true });
});

function mkCoord(startPort: number): Coordinator {
  const c = new Coordinator({ runValidated: async () => ({}), startPort });
  coords.push(c);
  return c;
}

async function mkBridge(
  port: number,
  token: string,
  onRpc?: (op: string, params: Record<string, unknown>) => Promise<unknown>,
): Promise<Bridge> {
  const b = new Bridge({ onRpc: onRpc ?? (async () => ({})) });
  bridges.push(b);
  await b.listen(port, token);
  return b;
}

function infoFor(port: number, token: string): LeaderInfo {
  return { port, token, pid: 999999, startedAt: 1_000, version: "0.1.0" };
}

describe("multi-leader election (deferred-leader livelock regression)", () => {
  it("a new process still elects when a second leader holds an earlier port than the legacy entry", async () => {
    // A: published leader on the higher port (e.g. a FIGMA_MCP_PORT cohort).
    const a = mkCoord(46321);
    expect(await a.start()).toBe("leader");

    // C: default-cohort leader on the lower port. It defers the LEGACY entry
    // to live A, but its per-port file makes it discoverable regardless.
    const c = mkCoord(46320);
    expect(await c.start()).toBe("leader");

    // D: walks the range, reaches C's port first. Previously: health OK but
    // the (single) leader file pointed at A's port → tryFollowOn failed →
    // bounded retries → THROW, killing the MCP process despite two healthy
    // leaders. Now: leader-46320.json resolves C directly.
    const d = mkCoord(46320);
    expect(await d.start()).toBe("follower");
    expect(d.info()?.port).toBe(46320);
  }, 20_000);
});

describe("election attempt budget", () => {
  it("a failed election run does not poison later runs", async () => {
    // A healthy Reqwise server with NO discovery file (the live orphaned-
    // leader state): election must fail BOUNDED, not hang.
    await mkBridge(46330, "orphan-token");
    const d = mkCoord(46330);
    await expect(d.start()).rejects.toThrow(/after 5 attempts/);

    // The blocking condition clears (the leader's file appears). A new
    // start() must get a FRESH attempt budget. Previously the counter
    // persisted, so this second run threw instantly forever — a follower in
    // takeover could never recover.
    await mkdir(baseDir(), { recursive: true });
    await writeFile(leaderFilePathFor(46330), JSON.stringify(infoFor(46330, "orphan-token")), { mode: 0o600 });
    expect(await d.start()).toBe("follower");
  }, 20_000);
});

describe("follower token refresh on 401", () => {
  it("re-reads the discovery file and retries when the leader restarted with a new token", async () => {
    const seen: string[] = [];
    const old = await mkBridge(46340, "old-token", async (op) => {
      seen.push(`old:${op}`);
      return { via: "old" };
    });
    await mkdir(baseDir(), { recursive: true });
    await writeFile(leaderFilePathFor(46340), JSON.stringify(infoFor(46340, "old-token")), { mode: 0o600 });

    const d = mkCoord(46340);
    expect(await d.start()).toBe("follower");
    expect(await d.forward("get_selection", {})).toEqual({ via: "old" });

    // Leader restarts on the SAME port with a fresh token and republishes.
    // /health answers green throughout, so the health monitor sees nothing.
    await old.close();
    await mkBridge(46340, "new-token", async (op) => {
      seen.push(`new:${op}`);
      return { via: "new" };
    });
    await writeFile(leaderFilePathFor(46340), JSON.stringify(infoFor(46340, "new-token")), { mode: 0o600 });

    // Previously: 401 forever, hint told the user to restart this process.
    expect(await d.forward("get_selection", {})).toEqual({ via: "new" });
    expect(seen).toContain("new:get_selection");
  }, 20_000);

  it("surfaces the 401 when no fresh token exists (refresh must not loop)", async () => {
    await mkBridge(46341, "real-token");
    await mkdir(baseDir(), { recursive: true });
    // The discovery file carries a WRONG token and never gets updated.
    await writeFile(leaderFilePathFor(46341), JSON.stringify(infoFor(46341, "forged-token")), { mode: 0o600 });

    const d = mkCoord(46341);
    expect(await d.start()).toBe("follower");
    await expect(d.forward("get_selection", {})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  }, 20_000);
});
