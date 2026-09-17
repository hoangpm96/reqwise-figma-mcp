import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { Bridge } from "../../src/server/bridge.js";
import { Follower } from "../../src/server/follower.js";
import type { LeaderInfo } from "../../src/shared/protocol.js";

/**
 * Regression suite for: "follower kills a healthy long-running op at 130s".
 *
 * The leader's per-op timeout resets on every progress ping, so a legitimate
 * long-running draw can run for many minutes. The forward
 * used to carry a fixed socket timeout that rejected mid-op with a bogus
 * PLUGIN_TIMEOUT — and a retry then duplicated work. Now a timeout is fatal
 * only when the leader is actually dead (or the hard cap elapsed); while
 * /health answers, the wait re-arms.
 */

const bridges: Bridge[] = [];
async function leaderBridge(
  token: string,
  onRpc: (op: string, params: Record<string, unknown>) => Promise<unknown>,
): Promise<{ bridge: Bridge; info: LeaderInfo }> {
  const bridge = new Bridge({ onRpc });
  bridges.push(bridge);
  const port = await bridge.listen(44000 + Math.floor(Math.random() * 500), token);
  return { bridge, info: { port, token, pid: 1234, startedAt: Date.now(), version: "0.0.0" } };
}

afterEach(async () => {
  while (bridges.length) await bridges.pop()?.close();
});

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("forward timeout extends while the leader is alive", () => {
  it("waits out a slow op instead of failing at timeoutMs", async () => {
    const { info } = await leaderBridge("tok", async () => {
      await delay(900);
      return { done: true };
    });
    const follower = new Follower(info);

    // timeoutMs=300 < the op's 900s — three re-arms — yet it must RESOLVE.
    const result = await follower.forward("build_demo", {}, "s-1", undefined, 300, {
      extendWhileAlive: true,
    });
    expect(result).toEqual({ done: true });
  });

  it("rejects quickly once the leader is actually dead", async () => {
    // A fake leader: /rpc hangs forever (the op that never finishes), and
    // /health answers until we flip it off — then every probe times out.
    let healthOn = true;
    const server = http.createServer((req, res) => {
      if (req.url === "/health" && healthOn) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      // /rpc and dead /health: never respond.
    });
    const port = 45000 + Math.floor(Math.random() * 500);
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
    try {
      const follower = new Follower({ port, token: "tok", pid: 1, startedAt: 0, version: "0.0.0" });
      const pending = follower.forward("build_demo", {}, "s-1", undefined, 300, {
        extendWhileAlive: true,
      });
      // First timeout (~300ms) sees a live leader and re-arms; then the
      // leader dies and the next timeout must reject — not wait out the cap.
      await delay(400);
      healthOn = false;
      const started = Date.now();
      await expect(pending).rejects.toMatchObject({ code: "PLUGIN_TIMEOUT" });
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("a non-extendable (diagnostic) call still fails at its own timeout", async () => {
    const { info } = await leaderBridge("tok", () => new Promise(() => {}));
    const follower = new Follower(info);

    const started = Date.now();
    await expect(
      follower.forward("__status__", {}, "s-1", undefined, 300),
    ).rejects.toMatchObject({ code: "PLUGIN_TIMEOUT" });
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
