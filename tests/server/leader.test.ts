import { describe, it, expect, afterEach } from "vitest";
import { Bridge } from "../../src/server/bridge.js";
import { Follower } from "../../src/server/follower.js";
import type { LeaderInfo } from "../../src/shared/protocol.js";

/**
 * These tests exercise the leader/follower auth contract without spinning up a
 * full Coordinator (which would need a bound DEFAULT_PORT). We stand up a
 * leader Bridge with a known token and verify:
 *   - a follower with the correct token forwards successfully,
 *   - a follower with a bad token is rejected (401 → UNAUTHORIZED),
 *   - /health probing works for discovery.
 */

const bridges: Bridge[] = [];
async function leaderBridge(token: string, onRpc: (op: string, params: Record<string, unknown>) => Promise<unknown>): Promise<{ bridge: Bridge; info: LeaderInfo }> {
  const bridge = new Bridge({ onRpc });
  bridges.push(bridge);
  const port = await bridge.listen(42000 + Math.floor(Math.random() * 500), token);
  return { bridge, info: { port, token, pid: 1234, startedAt: Date.now(), version: "0.0.0" } };
}

afterEach(async () => {
  while (bridges.length) await bridges.pop()?.close();
});

describe("leader/follower auth", () => {
  it("follower with the correct token forwards an op", async () => {
    const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
    const { info } = await leaderBridge("good-token", async (op, params) => {
      calls.push({ op, params });
      return { op, ok: true };
    });

    const follower = new Follower(info);
    const result = (await follower.forward("get_selection", { a: 1 }, "sess-1")) as { op: string; ok: boolean };
    expect(result.op).toBe("get_selection");
    expect(result.ok).toBe(true);
    expect(calls[0]?.op).toBe("get_selection");
  });

  it("rejects a follower presenting a bad token", async () => {
    const { info } = await leaderBridge("real-token", async () => ({ ok: true }));
    const impostor = new Follower({ ...info, token: "forged-token" });
    await expect(impostor.forward("get_selection", {})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("propagates a leader-side op error as an OpError with code+hint", async () => {
    const { info } = await leaderBridge("t", async () => {
      const { OpError } = await import("../../src/server/errors.js");
      throw new OpError("NODE_NOT_FOUND" as never, "no such node", "double-check the id");
    });
    const follower = new Follower(info);
    await expect(follower.forward("get_node", { nodeId: "9:9" })).rejects.toMatchObject({
      code: "NODE_NOT_FOUND",
      message: "no such node",
      hint: "double-check the id",
    });
  });

  it("checkHealth resolves true for a live leader, false for a dead port", async () => {
    const { info } = await leaderBridge("t", async () => ({}));
    expect(await Follower.checkHealth(info.port)).toBe(true);
    // An unused high port should be unreachable.
    expect(await Follower.checkHealth(59999, 300)).toBe(false);
  });
});
