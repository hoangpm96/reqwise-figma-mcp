import { describe, it, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import { Bridge } from "../../src/server/bridge.js";
import type { WireMessage, BridgeRequest, PluginHello } from "../../src/shared/protocol.js";

/** A fake Figma plugin that connects over WS, sends hello, and lets the test
 *  drive how it responds to each incoming request. */
class FakePlugin {
  ws?: WebSocket;
  onRequest?: (req: BridgeRequest, ws: WebSocket) => void;
  /** Channel the server assigned/confirmed in the "assigned" message. */
  assignedChannel?: string;
  /** Latest "channels" snapshot pushed by the server. */
  lastChannelsUpdate?: { self: string; channels: Array<{ channel: string }>; sessions: Array<{ id: string }> };

  async connect(port: number, hello?: Partial<PluginHello>): Promise<void> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as WireMessage;
      if (msg.type === "request") this.onRequest?.(msg.payload, ws);
      if (msg.type === "ping") ws.send(JSON.stringify({ type: "pong", at: Date.now() }));
      if (msg.type === "assigned") this.assignedChannel = msg.channel;
      if (msg.type === "channels") this.lastChannelsUpdate = msg;
    });
    const helloMsg: PluginHello = {
      type: "hello",
      protocolVersion: 1,
      pluginVersion: "1.0.0",
      fileKey: "abc",
      fileName: "Test File",
      pageName: "Page 1",
      editorType: "figma",
      ...hello,
    };
    ws.send(JSON.stringify(helloMsg));
    // give the server a tick to process hello
    await delay(30);
  }

  respond(id: string, body: Record<string, unknown>): void {
    this.ws?.send(JSON.stringify({ type: "response", payload: { id, ...body } }));
  }

  close(): void {
    this.ws?.close();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const bridges: Bridge[] = [];
async function newBridge(): Promise<{ bridge: Bridge; port: number }> {
  const bridge = new Bridge();
  bridges.push(bridge);
  // Random-ish start port to avoid collisions across tests.
  const port = await bridge.listen(41000 + Math.floor(Math.random() * 500), "token-" + Math.random());
  return { bridge, port };
}

afterEach(async () => {
  while (bridges.length) {
    await bridges.pop()?.close();
  }
});

describe("bridge request/response correlation", () => {
  it("matches responses to the right pending request by id", async () => {
    const { bridge, port } = await newBridge();
    const plugin = new FakePlugin();
    plugin.onRequest = (req) => {
      // Reply with the op name so we can prove correlation.
      plugin.respond(req.id, { ok: true, result: { op: req.op, echo: req.params } });
    };
    await plugin.connect(port);

    const [a, b] = await Promise.all([
      bridge.dispatch("get_node", { nodeId: "1:1" }),
      bridge.dispatch("get_selection", {}),
    ]);
    expect((a.result as { op: string }).op).toBe("get_node");
    expect((b.result as { op: string }).op).toBe("get_selection");
    expect(bridge.pendingCount).toBe(0);
  });

  it("times out when the plugin never responds", async () => {
    const { bridge, port } = await newBridge();
    const plugin = new FakePlugin();
    plugin.onRequest = () => {
      /* swallow — never respond */
    };
    await plugin.connect(port);

    const res = bridge.dispatch("get_node", { nodeId: "1:1" }, { timeoutMs: 120 });
    await expect(res).rejects.toMatchObject({ code: "PLUGIN_TIMEOUT" });
  });

  it("progress messages reset the timeout so a slow op still completes", async () => {
    const { bridge, port } = await newBridge();
    const plugin = new FakePlugin();
    plugin.onRequest = async (req) => {
      // Beyond the 150ms timeout in total, but each progress ping resets it.
      for (let i = 1; i <= 4; i++) {
        await delay(100);
        plugin.respond(req.id, { ok: false, progress: { done: i, total: 4 } });
      }
      await delay(100);
      plugin.respond(req.id, { ok: true, result: { finished: true } });
    };
    await plugin.connect(port);

    const seen: number[] = [];
    const res = await bridge.dispatch("export_node", { nodeId: "1:1" }, {
      timeoutMs: 150,
      onProgress: (p) => seen.push(p.done),
    });
    expect((res.result as { finished: boolean }).finished).toBe(true);
    expect(seen).toEqual([1, 2, 3, 4]);
  });

  it("does NOT settle on a progress message that carries ok:true (the real plugin shape)", async () => {
    // Regression: the plugin stamps ok:true on every message, including progress
    // pings. A batch's final progress ping (ok:true, has `progress`, no `result`)
    // must NOT settle the request in place of the real result — otherwise
    // res.result is undefined and every batch item reads as "no result".
    const { bridge, port } = await newBridge();
    const plugin = new FakePlugin();
    plugin.onRequest = async (req) => {
      await delay(20);
      // progress WITH ok:true (matches src/plugin/main.ts)
      plugin.respond(req.id, { ok: true, progress: { done: 2, total: 2, note: "batch 2/2" } });
      await delay(20);
      // the actual result arrives afterwards
      plugin.respond(req.id, { ok: true, result: { items: [{ ok: true }, { ok: true }], okCount: 2, failCount: 0 } });
    };
    await plugin.connect(port);

    const res = await bridge.dispatch("batch", { ops: [] }, { timeoutMs: 500 });
    const result = res.result as { items: unknown[]; okCount: number };
    expect(result.okCount, "must settle on the result message, not the progress ping").toBe(2);
    expect(result.items).toHaveLength(2);
  });

  it("fails fast pending requests when the SAME channel is replaced by a new hello", async () => {
    const { bridge, port } = await newBridge();
    const p1 = new FakePlugin();
    p1.onRequest = () => {
      /* never respond */
    };
    await p1.connect(port);
    expect(p1.assignedChannel).toBeTruthy();

    // Attach a rejection collector synchronously so the (synchronous) reject
    // fired inside p2's hello handler is never seen as "unhandled".
    let rejected: { code?: string } | undefined;
    const inflight = bridge
      .dispatch("get_node", { nodeId: "1:1" }, { timeoutMs: 10_000 })
      .then(() => undefined)
      .catch((e: { code?: string }) => {
        rejected = e;
      });

    // A second connection joins the SAME channel (same window reconnecting /
    // the user moving the channel) → replaces p1 within that channel only.
    const p2 = new FakePlugin();
    await p2.connect(port, { channel: p1.assignedChannel });
    await inflight;

    expect(rejected?.code).toBe("NOT_CONNECTED");
    expect(bridge.pluginConnected).toBe(true);
    expect(bridge.channelCount).toBe(1);
  });

  it("QUEUE_FULL names the cause when no plugin is connected", async () => {
    const { bridge } = await newBridge();
    // No plugin connected: fill the queue beyond MAX_QUEUE (100).
    const promises: Array<Promise<unknown>> = [];
    let queueFullErr: unknown;
    for (let i = 0; i < 130; i++) {
      const p = bridge.dispatch("get_node", { nodeId: `${i}:0` }, { timeoutMs: 5000 }).catch((e) => {
        if ((e as { code?: string }).code === "QUEUE_FULL") queueFullErr = e;
      });
      promises.push(p);
    }
    await delay(20);
    expect(queueFullErr).toBeTruthy();
    expect((queueFullErr as { message: string }).message).toMatch(/no plugin is connected/);
    // Let the rest settle/time out without unhandled rejections.
    await bridge.close();
    await Promise.allSettled(promises);
  });

  it("reports plugin metadata after hello", async () => {
    const { bridge, port } = await newBridge();
    const plugin = new FakePlugin();
    await plugin.connect(port, { fileName: "My Design", pageName: "Home" });
    expect(bridge.pluginConnected).toBe(true);
    expect(bridge.plugin?.fileName).toBe("My Design");
    expect(bridge.plugin?.pageName).toBe("Home");
  });
});

describe("bridge per-connection write serialization (root-cause #16)", () => {
  it("runs two overlapping dispatches sequentially — second starts only after first settles", async () => {
    const { bridge, port } = await newBridge();
    const plugin = new FakePlugin();

    // Record the order in which the plugin SEES each request, and how many are
    // in flight at any moment. With a single in-flight gate, concurrency must
    // never exceed 1.
    const seenOrder: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const pendingReqs: BridgeRequest[] = [];

    plugin.onRequest = (req) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      seenOrder.push((req.params as { tag: string }).tag);
      pendingReqs.push(req);
      // Do NOT respond immediately — the test settles them one at a time.
    };
    await plugin.connect(port);

    const settled: string[] = [];
    const p1 = bridge.dispatch("modify", { nodeId: "1:1", tag: "first" }, { timeoutMs: 5000 }).then((r) => {
      settled.push((r.result as { tag: string }).tag);
    });
    const p2 = bridge.dispatch("modify", { nodeId: "1:2", tag: "second" }, { timeoutMs: 5000 }).then((r) => {
      settled.push((r.result as { tag: string }).tag);
    });

    await delay(60);
    // Only the first op has been handed to the plugin; the second is queued.
    expect(seenOrder).toEqual(["first"]);
    expect(concurrent).toBe(1);
    expect(bridge.queueLength).toBe(1); // second waiting
    expect(bridge.pendingCount).toBe(2); // both tracked (1 in-flight + 1 queued)

    // Settle the first → this must release the gate and dispatch the second.
    concurrent--;
    plugin.respond(pendingReqs[0]!.id, { ok: true, result: { tag: "first" } });
    await delay(60);
    expect(seenOrder).toEqual(["first", "second"]);
    expect(bridge.queueLength).toBe(0);

    // Settle the second.
    concurrent--;
    plugin.respond(pendingReqs[1]!.id, { ok: true, result: { tag: "second" } });
    await Promise.all([p1, p2]);

    expect(settled).toEqual(["first", "second"]);
    expect(maxConcurrent).toBe(1); // never two ops on the wire at once
    expect(bridge.pendingCount).toBe(0);
  });

  it("starts a queued op's timeout at DISPATCH, not at enqueue", async () => {
    const { bridge, port } = await newBridge();
    const plugin = new FakePlugin();
    const reqs: BridgeRequest[] = [];
    plugin.onRequest = (req) => {
      reqs.push(req);
      // Never auto-respond; the test drives settlement.
    };
    await plugin.connect(port);

    // First op holds the single in-flight slot; the second must queue behind it
    // for longer than its OWN timeout budget. If the timer started at enqueue,
    // the second would time out while merely waiting. It must not: the clock
    // starts when it is actually dispatched.
    const first = bridge.dispatch("modify", { nodeId: "1:1", tag: "hold" }, { timeoutMs: 5000 });
    const secondSettled: { code?: string; ok?: boolean } = {};
    const second = bridge
      .dispatch("modify", { nodeId: "1:2", tag: "queued" }, { timeoutMs: 150 })
      .then((r) => {
        secondSettled.ok = r.ok;
      })
      .catch((e: { code?: string }) => {
        secondSettled.code = e.code;
      });

    // Keep the first op in flight for well beyond the second's 150ms timeout.
    await delay(300);
    // The second is still queued and has NOT timed out (its timer isn't armed).
    expect(reqs.length).toBe(1);
    expect(secondSettled.code).toBeUndefined();
    expect(bridge.queueLength).toBe(1);

    // Release the first → the second dispatches now; its 150ms clock starts here.
    plugin.respond(reqs[0]!.id, { ok: true, result: { tag: "hold" } });
    await first;
    await delay(30);
    expect(reqs.length).toBe(2); // second is now on the wire

    // Respond to the second within its budget → it succeeds (proves the timer
    // was armed at dispatch, giving it a full fresh window).
    plugin.respond(reqs[1]!.id, { ok: true, result: { tag: "queued" } });
    await second;
    expect(secondSettled.ok).toBe(true);
    expect(secondSettled.code).toBeUndefined();
  });

  it("a queued op DOES time out if it stays undispatched-then-dispatched but the plugin never replies", async () => {
    const { bridge, port } = await newBridge();
    const plugin = new FakePlugin();
    const reqs: BridgeRequest[] = [];
    plugin.onRequest = (req) => {
      reqs.push(req);
    };
    await plugin.connect(port);

    const first = bridge.dispatch("modify", { nodeId: "1:1" }, { timeoutMs: 5000 });
    let secondCode: string | undefined;
    const second = bridge
      .dispatch("modify", { nodeId: "1:2" }, { timeoutMs: 120 })
      .catch((e: { code?: string }) => {
        secondCode = e.code;
      });

    await delay(50);
    // Release the first so the second dispatches; then never reply to it.
    plugin.respond(reqs[0]!.id, { ok: true, result: {} });
    await first;
    await second;
    expect(secondCode).toBe("PLUGIN_TIMEOUT"); // timed out from its dispatch time
  });
});

describe("multi-channel routing", () => {
  it("assigns a channel on hello and reports it via channelSummaries", async () => {
    const { bridge, port } = await newBridge();
    const p = new FakePlugin();
    await p.connect(port); // protocol-v1-style hello: no channel field
    expect(p.assignedChannel).toBeTruthy();
    const summaries = bridge.channelSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.channel).toBe(p.assignedChannel);
  });

  it("keeps a requested channel from hello", async () => {
    const { bridge, port } = await newBridge();
    const p = new FakePlugin();
    await p.connect(port, { channel: "my-team-channel" });
    expect(p.assignedChannel).toBe("my-team-channel");
    expect(bridge.channelSummaries()[0]!.channel).toBe("my-team-channel");
  });

  it("routes by explicit channel and runs two channels IN PARALLEL", async () => {
    const { bridge, port } = await newBridge();
    const p1 = new FakePlugin();
    const p2 = new FakePlugin();
    // p1 stalls; p2 answers instantly. If channels shared one in-flight gate,
    // p2's op could not settle while p1's is stuck.
    const p1Seen: string[] = [];
    p1.onRequest = (req) => {
      p1Seen.push(req.op);
      /* stall — never respond */
    };
    p2.onRequest = (req) => p2.respond(req.id, { ok: true, result: { from: "p2" } });
    await p1.connect(port, { channel: "chan-a", fileName: "File A" });
    await p2.connect(port, { channel: "chan-b", fileName: "File B" });
    expect(bridge.channelCount).toBe(2);

    const stalled = bridge
      .dispatch("get_selection", {}, { channel: "chan-a", timeoutMs: 5000 })
      .catch(() => undefined);
    const fast = await bridge.dispatch("get_selection", {}, { channel: "chan-b", timeoutMs: 1000 });

    expect((fast.result as { from: string }).from).toBe("p2");
    expect(p1Seen).toEqual(["get_selection"]); // really went to p1
    await bridge.close();
    await stalled;
  });

  it("auto-routes with a single window, AMBIGUOUS_CHANNEL with two", async () => {
    const { bridge, port } = await newBridge();
    const p1 = new FakePlugin();
    p1.onRequest = (req) => p1.respond(req.id, { ok: true, result: { ok: 1 } });
    await p1.connect(port, { channel: "solo", fileName: "Solo File" });

    // One window: no channel needed.
    const res = await bridge.dispatch("get_selection", {}, { timeoutMs: 1000 });
    expect(res.ok).toBe(true);

    // Two windows: channel-less dispatch must fail with the channel list.
    const p2 = new FakePlugin();
    await p2.connect(port, { channel: "duo", fileName: "Duo File" });
    await expect(bridge.dispatch("get_selection", {})).rejects.toMatchObject({
      code: "AMBIGUOUS_CHANNEL",
    });
    await expect(bridge.dispatch("get_selection", {})).rejects.toMatchObject({
      hint: expect.stringContaining("solo"),
    });
  });

  it("CHANNEL_NOT_FOUND names connected channels", async () => {
    const { bridge, port } = await newBridge();
    const p = new FakePlugin();
    await p.connect(port, { channel: "alive" });
    await expect(bridge.dispatch("get_selection", {}, { channel: "ghost" })).rejects.toMatchObject({
      code: "CHANNEL_NOT_FOUND",
      hint: expect.stringContaining("alive"),
    });
  });

  it("replacing one channel does not disturb another channel's in-flight op", async () => {
    const { bridge, port } = await newBridge();
    const pA = new FakePlugin();
    const pB = new FakePlugin();
    const bReqs: BridgeRequest[] = [];
    pA.onRequest = () => {
      /* stall */
    };
    pB.onRequest = (req) => {
      bReqs.push(req);
      /* respond later */
    };
    await pA.connect(port, { channel: "chan-a" });
    await pB.connect(port, { channel: "chan-b" });

    let aRejected: { code?: string } | undefined;
    const aOp = bridge
      .dispatch("get_selection", {}, { channel: "chan-a", timeoutMs: 10_000 })
      .catch((e: { code?: string }) => {
        aRejected = e;
      });
    const bOp = bridge.dispatch("get_selection", {}, { channel: "chan-b", timeoutMs: 10_000 });
    await delay(30);

    // A new window takes over chan-a → only chan-a's op fails.
    const pA2 = new FakePlugin();
    await pA2.connect(port, { channel: "chan-a" });
    await aOp;
    expect(aRejected?.code).toBe("NOT_CONNECTED");

    // chan-b's op is still alive and settles normally.
    pB.respond(bReqs[0]!.id, { ok: true, result: { fine: true } });
    const bRes = await bOp;
    expect((bRes.result as { fine: boolean }).fine).toBe(true);
    expect(bridge.channelCount).toBe(2);
  });

  it("ops dispatched before any window connects drain to the first connection", async () => {
    const { bridge, port } = await newBridge();
    const early = bridge.dispatch("get_selection", {}, { timeoutMs: 5000 });
    await delay(20); // sits in the unrouted queue

    const p = new FakePlugin();
    p.onRequest = (req) => p.respond(req.id, { ok: true, result: { drained: true } });
    await p.connect(port);

    const res = await early;
    expect((res.result as { drained: boolean }).drained).toBe(true);
  });

  it("session binding routes channel-less ops and notifies the agent once", async () => {
    const { bridge, port } = await newBridge();
    bridge.setSessionsProvider(() => [{ id: "s-agent1", writeCount: 0, lastUsedMs: 0 }]);

    const pA = new FakePlugin();
    const pB = new FakePlugin();
    pA.onRequest = (req) => pA.respond(req.id, { ok: true, result: { from: "A" } });
    pB.onRequest = (req) => pB.respond(req.id, { ok: true, result: { from: "B" } });
    await pA.connect(port, { channel: "chan-a", fileName: "File A" });
    await pB.connect(port, { channel: "chan-b", fileName: "File B" });

    // Without a binding, a channel-less dispatch is ambiguous.
    await expect(bridge.dispatch("get_selection", {}, { sessionId: "s-agent1" })).rejects.toMatchObject({
      code: "AMBIGUOUS_CHANNEL",
    });

    // The user picks the agent in window B's plugin UI.
    pB.ws!.send(JSON.stringify({ type: "bind", sessionId: "s-agent1" }));
    await delay(30);
    expect(bridge.sessionBinding("s-agent1")).toBe("chan-b");

    // First routed op: goes to B and carries the pairing notice.
    const first = await bridge.dispatch("get_selection", {}, { sessionId: "s-agent1", timeoutMs: 1000 });
    expect((first.result as { from: string }).from).toBe("B");
    expect(first.warnings?.join(" ")).toMatch(/bound this session to channel "chan-b"/);

    // Second op: still routed, no repeated notice.
    const second = await bridge.dispatch("get_selection", {}, { sessionId: "s-agent1", timeoutMs: 1000 });
    expect((second.result as { from: string }).from).toBe("B");
    expect(second.warnings ?? []).toHaveLength(0);

    // The channels push reflects the binding for every window's picker.
    expect(pA.lastChannelsUpdate?.sessions.find((s) => s.id === "s-agent1")).toMatchObject({
      boundChannel: "chan-b",
    });
  });

  it("pushes a channels update (windows + sessions) to every connected window", async () => {
    const { bridge, port } = await newBridge();
    bridge.setSessionsProvider(() => [
      { id: "s-one", writeCount: 3, lastUsedMs: 100 },
      { id: "s-two", writeCount: 0, lastUsedMs: 5000 },
    ]);
    const p1 = new FakePlugin();
    await p1.connect(port, { channel: "chan-1" });
    const p2 = new FakePlugin();
    await p2.connect(port, { channel: "chan-2" });
    await delay(30);

    expect(p1.lastChannelsUpdate?.self).toBe("chan-1");
    expect(p1.lastChannelsUpdate?.channels.map((c) => c.channel).sort()).toEqual(["chan-1", "chan-2"]);
    expect(p1.lastChannelsUpdate?.sessions.map((s) => s.id).sort()).toEqual(["s-one", "s-two"]);
    expect(p2.lastChannelsUpdate?.self).toBe("chan-2");
  });
});

describe("bridge /health + /rpc", () => {
  it("serves /health JSON", async () => {
    const { bridge, port } = await newBridge();
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; port: number };
    expect(json.ok).toBe(true);
    expect(json.port).toBe(port);
  });

  it("rejects /rpc without a valid Bearer token (401)", async () => {
    const bridge = new Bridge({ onRpc: async () => ({ ran: true }) });
    bridges.push(bridge);
    const port = await bridge.listen(41800 + Math.floor(Math.random() * 100), "secret-token");

    const bad = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong" },
      body: JSON.stringify({ op: "get_selection", params: {} }),
    });
    expect(bad.status).toBe(401);
    const badJson = (await bad.json()) as { error: { code: string } };
    expect(badJson.error.code).toBe("UNAUTHORIZED");

    const good = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer secret-token" },
      body: JSON.stringify({ op: "get_selection", params: {} }),
    });
    expect(good.status).toBe(200);
    const goodJson = (await good.json()) as { ok: boolean; result: { ran: boolean } };
    expect(goodJson.ok).toBe(true);
    expect(goodJson.result.ran).toBe(true);
  });
});
