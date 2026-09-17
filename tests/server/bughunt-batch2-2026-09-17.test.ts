import http from "node:http";
import { buildErd } from "../../src/shared/erd/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeWrite } from "../../src/server/executor.js";
import { Follower } from "../../src/server/follower.js";
import { handleDiagram, type ToolContext } from "../../src/server/tools.js";
import {
  validateActivitySpec,
  validateErdSpec,
  validateSequenceSpec,
  validateStateSpec,
} from "../../src/server/validate.js";
import { parseActivityText } from "../../src/shared/activity/text.js";
import { parseErdText } from "../../src/shared/erd/index.js";
import { parseSequenceText } from "../../src/shared/sequence/index.js";
import { parseStateText } from "../../src/shared/state/text.js";
import type { Session } from "../../src/server/session.js";

/**
 * The second round of silent-wrong answers from the 2026-09-17 bug hunt:
 * each one returned something plausible while doing something other than
 * what was asked — or let work happen that the caller had already given up on.
 */

const freshSession = () => ({ state: {}, writeCount: 0 }) as unknown as Session;

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---- #19 loadImage follows redirects without re-checking them ----

describe("loadImage: a redirect is vetted like the URL it came from", () => {
  /** A fetch that behaves like the real one: follows 3xx itself unless told
   * redirect:"manual". Records every URL it was asked to reach. */
  function redirectingFetch(hops: Record<string, string>) {
    const reached: string[] = [];
    const impl = async (url: string, init?: RequestInit): Promise<Response> => {
      let current = url;
      for (;;) {
        reached.push(current);
        const next = hops[current];
        if (!next) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
        if (init?.redirect === "manual") {
          return new Response(null, { status: 302, headers: { location: next } });
        }
        current = new URL(next, current).href;
      }
    };
    return { impl, reached };
  }

  const runOp = async () => ({ id: "x", ok: true, result: { id: "1:1" } });

  it("refuses a 302 to the cloud metadata address and never fetches it", async () => {
    const { impl, reached } = redirectingFetch({
      "https://images.example.com/cat.png": "https://169.254.169.254/latest/meta-data/",
    });
    vi.stubGlobal("fetch", impl);
    const res = await executeWrite(
      `return await figma.loadImage("https://images.example.com/cat.png");`,
      freshSession(),
      { runOp } as never,
      { timeoutMs: 2000 },
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("INVALID_PARAMS");
    expect(reached.some((u) => u.includes("169.254.169.254"))).toBe(false);
  }, 15_000);

  it("refuses a relative redirect that resolves to a blocked host, and a chain that never ends", async () => {
    const { impl, reached } = redirectingFetch({
      "https://a.example.com/1": "https://a.example.com/2",
      "https://a.example.com/2": "https://a.example.com/3",
      "https://a.example.com/3": "https://a.example.com/4",
      "https://a.example.com/4": "https://a.example.com/5",
    });
    vi.stubGlobal("fetch", impl);
    const res = await executeWrite(
      `return await figma.loadImage("https://a.example.com/1");`,
      freshSession(),
      { runOp } as never,
      { timeoutMs: 2000 },
    );
    expect(res.ok).toBe(false);
    expect(res.error?.message).toMatch(/redirected more than/);
    expect(reached.length).toBeLessThanOrEqual(4);
  }, 15_000);

  it("still follows a redirect between public hosts", async () => {
    const { impl } = redirectingFetch({ "https://a.example.com/img": "/cdn/img.png" });
    vi.stubGlobal("fetch", impl);
    const res = await executeWrite(
      `return await figma.loadImage("https://a.example.com/img");`,
      freshSession(),
      { runOp } as never,
      { timeoutMs: 2000 },
    );
    expect(res.ok).toBe(true);
  }, 15_000);
});

// ---- #20 an op the write gave up on must not stay queued ----

describe("figma_write: a timed-out call cancels the ops it left queued", () => {
  it("aborts the signal it handed to every op once the budget runs out", async () => {
    const signals: AbortSignal[] = [];
    const runOp = (_op: string, _params: unknown, ctx?: { signal: AbortSignal }) => {
      if (ctx) signals.push(ctx.signal);
      return new Promise(() => {}); // the plugin never answers
    };
    const res = await executeWrite(
      `await figma.getNode("1:2");`,
      freshSession(),
      { runOp } as never,
      { timeoutMs: 200 },
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("PLUGIN_TIMEOUT");
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(true);
  }, 20_000);
});

// ---- #22 a batch that names one frame twice / a bad `update` ----

const SEQ = {
  title: "Pay",
  participants: [
    { id: "a", name: "App" },
    { id: "b", name: "API" },
  ],
  messages: [
    { id: "m1", from: "a", to: "b", label: "POST /pay" },
    { id: "m2", from: "b", to: "a", label: "200 paid", kind: "return" as const },
  ],
};

function recordingCtx(stored: unknown = { kind: "sequence", spec: SEQ }) {
  const calls: Array<[string, any]> = [];
  const ctx = {
    runValidated: vi.fn(async (op: string, params: any) => {
      calls.push([op, params]);
      if (op === "get_diagram_spec") return typeof stored === "function" ? (stored as any)(params) : stored;
      if (op === "layout_audit") return { nodeCount: 3, summary: { issues: [], styleHints: [] } };
      return { frameId: params.intoFrameId ?? "9:9", name: "F" };
    }),
  } as unknown as ToolContext;
  return { ctx, calls };
}

describe("figma_diagram batch: entries are vetted before anything is read or drawn", () => {
  it("refuses two entries that update the same frame", async () => {
    const { ctx, calls } = recordingCtx();
    await expect(
      handleDiagram(ctx, undefined, {
        diagrams: [
          { update: "1:2", patch: [{ collection: "messages", id: "m1", set: { label: "A" } }] },
          { update: "1:2", patch: [{ collection: "messages", id: "m2", set: { label: "B" } }] },
        ],
      }),
    ).rejects.toMatchObject({ code: "INVALID_PARAMS", message: expect.stringMatching(/both update frame "1:2"/) });
    expect(calls).toHaveLength(0);
  });

  it("refuses a non-string `update` instead of drawing a new frame", async () => {
    const { ctx, calls } = recordingCtx();
    await expect(
      handleDiagram(ctx, undefined, { diagrams: [{ type: "sequence", update: 42, ...SEQ }] }),
    ).rejects.toMatchObject({ code: "INVALID_PARAMS", message: expect.stringMatching(/`update` must be the id/) });
    expect(calls.filter((c) => c[0].startsWith("create_"))).toHaveLength(0);
  });
});

// ---- #6a/b/c options beside a patch ----

describe("figma_diagram: draw-only options steer one draw and are never stored", () => {
  it("verify:false beside a patch skips this audit but is not written into the frame's model", async () => {
    const { ctx, calls } = recordingCtx();
    await handleDiagram(ctx, undefined, {
      update: "1:2",
      patch: [{ collection: "messages", id: "m1", set: { label: "x" } }],
      options: { verify: false, crossCheck: false },
    });
    expect(calls.map((c) => c[0])).not.toContain("layout_audit");
    const draw = calls.find((c) => c[0] === "create_sequence")![1];
    const storedOptions = (draw.source as any).options ?? {};
    expect(storedOptions.verify).toBeUndefined();
    expect(storedOptions.crossCheck).toBeUndefined();
  });

  it("a plain patch of a frame that stored verify:false (older build) is still audited", async () => {
    const { ctx, calls } = recordingCtx({ kind: "sequence", spec: { ...SEQ, options: { verify: false } } });
    await handleDiagram(ctx, undefined, {
      update: "1:2",
      patch: [{ collection: "messages", id: "m1", set: { label: "x" } }],
    });
    expect(calls.map((c) => c[0])).toContain("layout_audit");
  });

  it("a full spec drawn with checkFirst/verify does not store them either", async () => {
    const { ctx, calls } = recordingCtx();
    await handleDiagram(ctx, "sequence", { ...SEQ, options: { verify: false, checkFirst: true } });
    const draw = calls.find((c) => c[0] === "create_sequence" && !c[1].dryRun)![1];
    expect((draw.source as any).options?.verify).toBeUndefined();
    expect((draw.source as any).options?.checkFirst).toBeUndefined();
  });

  it("one policy beside a patch changes that policy and keeps the rest", async () => {
    const { ctx, calls } = recordingCtx({
      kind: "sequence",
      spec: { ...SEQ, options: { policies: { "hold-minutes": 10, "retry-attempts": 3 } } },
    });
    await handleDiagram(ctx, undefined, {
      update: "1:2",
      patch: [{ collection: "messages", id: "m1", set: { label: "x" } }],
      options: { policies: { "hold-minutes": 15 } },
    });
    const draw = calls.find((c) => c[0] === "create_sequence")![1];
    expect((draw.source as any).options.policies).toEqual({ "hold-minutes": 15, "retry-attempts": 3 });
  });

  it("in a batch, the frame's stored options lose to the batch's shared options", async () => {
    const { ctx, calls } = recordingCtx({ kind: "sequence", spec: { ...SEQ, options: { font: "Stored Font" } } });
    await handleDiagram(ctx, undefined, {
      diagrams: [{ update: "1:2", patch: [{ collection: "messages", id: "m1", set: { label: "x" } }] }],
      options: { font: "Batch Font" },
    });
    const draw = calls.find((c) => c[0] === "create_sequence" && c[1].intoFrameId === "1:2")!;
    expect(JSON.stringify(draw[1])).toContain("Batch Font");
    expect(JSON.stringify(draw[1])).not.toContain("Stored Font");
  });

  it("in a batch, the entry's own options beat the batch's shared options", async () => {
    const { ctx, calls } = recordingCtx({ kind: "sequence", spec: { ...SEQ, options: { font: "Stored Font" } } });
    await handleDiagram(ctx, undefined, {
      diagrams: [
        {
          update: "1:2",
          patch: [{ collection: "messages", id: "m1", set: { label: "x" } }],
          options: { font: "Entry Font" },
        },
      ],
      options: { font: "Batch Font" },
    });
    const draw = calls.find((c) => c[0] === "create_sequence" && c[1].intoFrameId === "1:2")!;
    expect(JSON.stringify(draw[1])).toContain("Entry Font");
  });
});

// ---- #23 text:"" beside valid arrays ----

describe("diagram specs: an empty `text` does not veto the arrays beside it", () => {
  it("accepts text:\"\" with arrays, for every kind that has a text form", () => {
    expect(() =>
      validateActivitySpec({ title: "T", text: "", nodes: [{ id: "a", label: "A" }] }),
    ).not.toThrow();
    expect(() => validateStateSpec({ title: "T", text: "", states: [{ id: "a" }] })).not.toThrow();
    expect(() =>
      validateErdSpec({ title: "T", text: "", entities: [{ id: "e", name: "E", attributes: [] }] }),
    ).not.toThrow();
    expect(() => validateSequenceSpec({ ...SEQ, text: "" })).not.toThrow();
  });

  it("still refuses a spec with neither", () => {
    expect(() => validateStateSpec({ title: "T", text: "" })).toThrow(/Pass either `text`/);
    expect(() => validateStateSpec({ title: "T", text: "   " })).toThrow(/Pass either `text`/);
  });

  it("blank text beside arrays draws the arrays, in the schema and in the builder alike", () => {
    expect(() =>
      validateErdSpec({ title: "T", text: "   ", entities: [{ id: "e", name: "E", attributes: [{ name: "id", key: "pk" }] }] }),
    ).not.toThrow();
    const built = buildErd({ title: "T", text: "  \n ", entities: [{ id: "e", name: "E", attributes: [{ name: "id", key: "pk" }] }] } as never);
    expect(built.model.entities!.map((e: { id: string }) => e.id)).toEqual(["e"]);
  });
});

// ---- #34 ids the plugin reads back with [^\s]+ ----

describe("diagram specs: a layer-handle id may not contain whitespace", () => {
  it("refuses a space in activity, state, ERD and sequence ids and their references", () => {
    expect(() => validateActivitySpec({ title: "T", nodes: [{ id: "place order", label: "A" }] })).toThrow(
      /must not contain whitespace/,
    );
    expect(() =>
      validateActivitySpec({ title: "T", nodes: [{ id: "a", label: "A" }], edges: [{ from: "a", to: "b c" }] }),
    ).toThrow(/must not contain whitespace/);
    expect(() => validateStateSpec({ title: "T", states: [{ id: "on hold" }] })).toThrow(/must not contain whitespace/);
    expect(() =>
      validateErdSpec({ title: "T", entities: [{ id: "Order Line", name: "Order Line", attributes: [] }] }),
    ).toThrow(/must not contain whitespace/);
    expect(() =>
      validateSequenceSpec({ ...SEQ, participants: [{ id: "web app", name: "Web" }, SEQ.participants[1]] }),
    ).toThrow(/must not contain whitespace/);
  });

  it("the compact text parsers never produce such an id", () => {
    const noSpace = (ids: string[]) => ids.forEach((id) => expect(id).toMatch(/^\S+$/));
    const act = parseActivityText('lane user "The User"\nuser: pick "Pick a seat"\nuser: pay "Pay now"\npick > pay "next"');
    noSpace([...act.lanes.map((l) => l.id), ...act.nodes.map((n) => n.id)]);
    const st = parseStateText('held "On hold"\n[*] -> held\nheld -> paid: Pay [ok] / charge');
    noSpace(st.states.map((s) => s.id));
    const erd = parseErdText('users "Our users"\n  id uuid pk\nbookings\n  user_id uuid fk\nusers.id 1-* bookings.user_id "books"');
    noSpace(erd.entities.map((e) => e.id));
    const seq = parseSequenceText('participant web "Web app"\nweb ->> api: POST /pay\napi -->> web: 200');
    noSpace([...seq.participants.map((p) => p.id), ...seq.messages.map((m) => m.id)]);
  });
});

// ---- #25 a non-envelope error body from the leader ----

describe("follower: a leader body whose `error` is not an envelope", () => {
  it("is reported as a malformed response, not an OpError with no code and no message", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    const port = 46000 + Math.floor(Math.random() * 500);
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
    try {
      const follower = new Follower({ port, token: "tok", pid: 1, startedAt: 0, version: "0.0.0" });
      const err = (await follower.forward("get_selection", {}, "s-1", undefined, 2000).catch((e) => e)) as {
        code?: string;
        message?: string;
      };
      expect(err.code).toBe("INTERNAL");
      expect(err.message).toMatch(/Malformed \/rpc response/);
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
