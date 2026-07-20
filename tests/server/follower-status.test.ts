import { describe, it, expect, afterEach } from "vitest";
import { Bridge } from "../../src/server/bridge.js";
import { Follower, STATUS_RPC_TIMEOUT_MS } from "../../src/server/follower.js";
import { handleStatus, type ToolContext, type Diagnostics } from "../../src/server/tools.js";
import { SessionRegistry } from "../../src/server/session.js";
import type { LeaderInfo } from "../../src/shared/protocol.js";

/**
 * Regression suite for: "figma_status lies on a follower".
 *
 * The original follower branch returned a HARDCODED pluginConnected:false /
 * lastHeartbeatMs:-1 / channels:[] while the plugin was connected and writing
 * fine. Clients gate on pluginConnected, so they marched users through plugin
 * restarts that could not possibly help.
 *
 * The contract these tests lock in:
 *   1. follower + plugin connected  → status reflects the LEADER's real state.
 *   2. follower + leader unreachable → status is UNKNOWN (null), never false,
 *      and the hints must not tell the user to go restart the plugin.
 */

const bridges: Bridge[] = [];
async function leaderBridge(
  token: string,
  onRpc: (op: string, params: Record<string, unknown>) => Promise<unknown>,
): Promise<{ bridge: Bridge; info: LeaderInfo }> {
  const bridge = new Bridge({ onRpc });
  bridges.push(bridge);
  const port = await bridge.listen(43000 + Math.floor(Math.random() * 500), token);
  return { bridge, info: { port, token, pid: 1234, startedAt: Date.now(), version: "0.0.0" } };
}

afterEach(async () => {
  while (bridges.length) await bridges.pop()?.close();
});

/** The real leader-side payload shape, as leaderPluginState() produces it. */
const CONNECTED_STATE = {
  pluginConnected: true,
  plugin: {
    version: "1.2.3",
    protocolVersion: 1,
    fileName: "Design File",
    pageName: "Page 1",
    editorType: "figma",
  },
  channels: [
    {
      channel: "ch-a",
      plugin: {
        version: "1.2.3",
        protocolVersion: 1,
        fileKey: "abc",
        fileName: "Design File",
        pageName: "Page 1",
        editorType: "figma",
        connectedAt: Date.now(),
      },
      queueLength: 0,
      pendingCount: 0,
      lastHeartbeatMs: 120,
      boundSessions: [],
    },
  ],
  lastHeartbeatMs: 120,
  queueLength: 0,
  pendingCount: 0,
};

function statusCtx(diagnostics: () => Promise<Diagnostics>): ToolContext {
  return {
    runValidated: async () => ({}),
    runWrite: async () => ({}),
    sessions: new SessionRegistry(),
    diagnostics,
  };
}

describe("follower forwards __status__ to the leader", () => {
  it("reports the leader's REAL plugin state (not a hardcoded false)", async () => {
    const seen: string[] = [];
    const { info } = await leaderBridge("tok", async (op) => {
      seen.push(op);
      if (op === "__status__") return CONNECTED_STATE;
      return {};
    });

    const follower = new Follower(info);
    const state = (await follower.forward(
      "__status__",
      {},
      "s-1",
      undefined,
      STATUS_RPC_TIMEOUT_MS,
    )) as typeof CONNECTED_STATE;

    expect(seen).toContain("__status__");
    expect(state.pluginConnected).toBe(true);
    expect(state.lastHeartbeatMs).toBe(120);
    expect(state.channels).toHaveLength(1);
    // channelSummaries() must survive the HTTP JSON round-trip intact.
    expect(state.channels[0]?.channel).toBe("ch-a");
    expect(state.channels[0]?.plugin.fileName).toBe("Design File");
  });

  it("uses the SHORT status timeout, not the 130s drawing-op timeout", async () => {
    // A leader that accepts the request and never answers. Without a dedicated
    // timeout, figma_status would block for over two minutes.
    const { info } = await leaderBridge("tok", () => new Promise(() => {}));
    const follower = new Follower(info);

    const started = Date.now();
    await expect(
      follower.forward("__status__", {}, "s-1", undefined, 300),
    ).rejects.toMatchObject({ code: "PLUGIN_TIMEOUT" });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(STATUS_RPC_TIMEOUT_MS).toBeLessThan(10_000);
  });
});

describe("GET /health fallback (mixed-version rollout)", () => {
  it("reads real plugin state from /health when the leader is too old for __status__", async () => {
    // Reproduces what a live check actually hit: a NEW follower talking to an
    // OLD leader, which rejects __status__ via validateOperation. /health is
    // unauthenticated and present in every version, so state is still real.
    const { bridge, info } = await leaderBridge("tok", async (op) => {
      throw new Error(`Unknown operation "${op}".`);
    });
    await expect(
      new Follower(info).forward("__status__", {}, "s-1", undefined, 300),
    ).rejects.toThrow();

    const health = await Follower.fetchHealth(info.port, 1000);
    expect(health?.ok).toBe(true);
    expect(health?.port).toBe(bridge.port);
    // No plugin attached in this test, but the field is MEASURED (a boolean),
    // which is what lets the fallback report it instead of "unknown".
    expect(typeof health?.pluginConnected).toBe("boolean");
    expect(Array.isArray(health?.channels)).toBe(true);
  });

  it("returns undefined (→ unknown) when nothing answers the port", async () => {
    expect(await Follower.fetchHealth(59998, 300)).toBeUndefined();
  });
});

describe("figma_status on a follower", () => {
  it("surfaces the leader's live state when the query succeeds", async () => {
    const ctx = statusCtx(async () => ({
      mode: "follower",
      port: 38470,
      bridgeAuth: "ok",
      statusSource: "leader",
      ...CONNECTED_STATE,
      defaultSessionId: "s-1",
    }));

    const out = await handleStatus(ctx);
    expect(out["pluginConnected"]).toBe(true);
    expect(out["statusSource"]).toBe("leader");
    expect(out["lastHeartbeatMs"]).toBe(120);
    expect(out["channels"]).toHaveLength(1);
    const hints = out["hints"] as string[];
    expect(hints.join(" ")).not.toContain("No Figma plugin connected");
  });

  it("reports UNKNOWN — not false — when the leader cannot be reached", async () => {
    const ctx = statusCtx(async () => ({
      mode: "follower",
      port: 38470,
      bridgeAuth: "ok",
      statusSource: "unknown",
      statusError: 'Forward of "__status__" to leader timed out.',
      pluginConnected: null,
      lastHeartbeatMs: null,
      queueLength: 0,
      pendingCount: 0,
      defaultSessionId: "s-1",
    }));

    const out = await handleStatus(ctx);
    // The heart of the bug: absence of data must not be reported as false.
    expect(out["pluginConnected"]).toBeNull();
    expect(out["pluginConnected"]).not.toBe(false);
    expect(out["statusSource"]).toBe("unknown");
    expect(out["statusError"]).toContain("timed out");
    // channels must be null (unknown), not [] (measured: none connected).
    expect(out["channels"]).toBeNull();
    expect(out["lastHeartbeatMs"]).toBeNull();

    const hints = (out["hints"] as string[]).join(" ");
    expect(hints).toContain("UNKNOWN");
    // Must NOT send the user off to restart a plugin we never asked about.
    expect(hints).not.toContain("No Figma plugin connected");
    expect(hints).not.toContain("Open Figma Desktop");
  });

  it("still reports a measured false when the leader says nothing is connected", async () => {
    const ctx = statusCtx(async () => ({
      mode: "follower",
      port: 38470,
      bridgeAuth: "ok",
      statusSource: "leader",
      pluginConnected: false,
      channels: [],
      lastHeartbeatMs: -1,
      queueLength: 0,
      pendingCount: 0,
      defaultSessionId: "s-1",
    }));

    const out = await handleStatus(ctx);
    expect(out["pluginConnected"]).toBe(false);
    expect(out["channels"]).toEqual([]);
    // Here the "go open the plugin" advice IS correct — we measured it.
    expect((out["hints"] as string[]).join(" ")).toContain("No Figma plugin connected");
  });
});
