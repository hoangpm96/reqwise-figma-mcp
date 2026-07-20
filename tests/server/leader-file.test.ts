import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LeaderInfo } from "../../src/shared/protocol.js";
import { Coordinator } from "../../src/server/leader.js";
import { leaderFilePath, leaderFilePathFor, baseDir } from "../../src/server/paths.js";

/**
 * Discovery-file ownership.
 *
 * The authoritative record is per-port (leader-<port>.json): a leader owns its
 * port exclusively, so it owns that file exclusively — no contention possible.
 * The legacy global leader.json is still written for old-version followers.
 *
 * Regression history (all on the legacy single global path):
 *  - close() identified "its own" file by pid+startedAt only, so a short-lived
 *    leader on a custom FIGMA_MCP_PORT overwrote the incumbent's entry, then
 *    deleted it on shutdown, orphaning a healthy leader: /health still
 *    answered but no token file existed, so every new process burned all its
 *    election attempts and exited silently. Port must be part of ownership.
 *  - The write side of the same bug: B overwriting A's live entry is what
 *    made B the file's "legitimate" owner in the first place.
 */

let dir: string;
let prevTmp: string | undefined;

beforeEach(async () => {
  prevTmp = process.env["TMPDIR"];
  dir = await mkdtemp(join(tmpdir(), "reqwise-leaderfile-"));
  process.env["TMPDIR"] = dir;
});

afterEach(async () => {
  if (prevTmp === undefined) delete process.env["TMPDIR"];
  else process.env["TMPDIR"] = prevTmp;
  await rm(dir, { recursive: true, force: true });
});

// paths.ts calls tmpdir() per invocation, so patching TMPDIR in beforeEach is
// enough — no module cache busting needed.

const INCUMBENT: LeaderInfo = {
  port: 38470,
  token: "incumbent-token",
  pid: 4242,
  startedAt: 1_000,
  version: "0.1.0",
};

type WithPrivates = {
  writeLeaderFile(i: LeaderInfo): Promise<void>;
  role: string;
  leaderInfo: LeaderInfo;
};

describe("discovery-file ownership on startup", () => {
  it("publishes its own per-port file and does NOT clobber a LIVE leader's legacy entry", async () => {
    const { Bridge } = await import("../../src/server/bridge.js");
    const live = new Bridge({ onRpc: async () => ({}) });
    const livePort = await live.listen(46101, "live-token");
    try {
      await mkdir(baseDir(), { recursive: true });
      const incumbent: LeaderInfo = { ...INCUMBENT, port: livePort, token: "live-token" };
      await writeFile(leaderFilePath(), JSON.stringify(incumbent), { mode: 0o600 });

      const newcomer = new Coordinator({ runValidated: async () => ({}) });
      const mine: LeaderInfo = { ...INCUMBENT, port: livePort + 1, token: "newcomer-token" };
      await (newcomer as unknown as WithPrivates).writeLeaderFile(mine);

      // Legacy entry still points at the live incumbent.
      const legacy = JSON.parse(await readFile(leaderFilePath(), "utf8")) as LeaderInfo;
      expect(legacy.port).toBe(livePort);
      expect(legacy.token).toBe("live-token");
      // But the newcomer IS discoverable via its own per-port file.
      const perPort = JSON.parse(await readFile(leaderFilePathFor(livePort + 1), "utf8")) as LeaderInfo;
      expect(perPort.port).toBe(livePort + 1);
      expect(perPort.token).toBe("newcomer-token");
    } finally {
      await live.close();
    }
  });

  it("DOES take over the legacy entry when the recorded leader is dead", async () => {
    // A crashed leader must not permanently block publication, or discovery
    // would stay pinned to a corpse.
    await mkdir(baseDir(), { recursive: true });
    // 46199 has nothing listening on it.
    await writeFile(leaderFilePath(), JSON.stringify({ ...INCUMBENT, port: 46199 }), { mode: 0o600 });

    const newcomer = new Coordinator({ runValidated: async () => ({}) });
    const mine: LeaderInfo = { ...INCUMBENT, port: 46200, token: "mine" };
    await (newcomer as unknown as WithPrivates).writeLeaderFile(mine);

    const after = JSON.parse(await readFile(leaderFilePath(), "utf8")) as LeaderInfo;
    expect(after.port).toBe(46200);
    expect(after.token).toBe("mine");
    expect(existsSync(leaderFilePathFor(46200))).toBe(true);
  });
});

describe("discovery-file ownership on shutdown", () => {
  it("does NOT delete files owned by a leader on a different port", async () => {
    await mkdir(baseDir(), { recursive: true });
    await writeFile(leaderFilePath(), JSON.stringify(INCUMBENT), { mode: 0o600 });
    await writeFile(leaderFilePathFor(INCUMBENT.port), JSON.stringify(INCUMBENT), { mode: 0o600 });

    // A second process that became leader on ANOTHER port, sharing pid+startedAt
    // with the file's owner, would previously match and delete the legacy file.
    const other = new Coordinator({ runValidated: async () => ({}) });
    (other as unknown as WithPrivates).role = "leader";
    (other as unknown as WithPrivates).leaderInfo = {
      ...INCUMBENT,
      port: 38477, // same pid/startedAt, different port
      token: "other-token",
    };

    await other.close();

    // The incumbent's files must survive — deleting them strands a healthy leader.
    expect(existsSync(leaderFilePath())).toBe(true);
    expect(existsSync(leaderFilePathFor(INCUMBENT.port))).toBe(true);
    const still = JSON.parse(await readFile(leaderFilePath(), "utf8")) as LeaderInfo;
    expect(still.port).toBe(38470);
    expect(still.token).toBe("incumbent-token");
  });

  it("still removes its own files (same pid, startedAt AND port)", async () => {
    await mkdir(baseDir(), { recursive: true });
    await writeFile(leaderFilePath(), JSON.stringify(INCUMBENT), { mode: 0o600 });
    await writeFile(leaderFilePathFor(INCUMBENT.port), JSON.stringify(INCUMBENT), { mode: 0o600 });

    const own = new Coordinator({ runValidated: async () => ({}) });
    (own as unknown as WithPrivates).role = "leader";
    (own as unknown as WithPrivates).leaderInfo = { ...INCUMBENT };

    await own.close();

    // Normal shutdown must still clean up, or a dead leader's token files would
    // linger and followers would try to reach a corpse.
    expect(existsSync(leaderFilePath())).toBe(false);
    expect(existsSync(leaderFilePathFor(INCUMBENT.port))).toBe(false);
  });
});
