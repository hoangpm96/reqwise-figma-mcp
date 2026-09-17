import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeWrite,
  fetchImageFollowingSafeRedirects,
  MAX_LOG_LINES,
  pinnedHttpsFetch,
} from "../../src/server/executor.js";
import { assertHostResolvesPublic } from "../../src/server/security.js";
import { handleDiagram, type ToolContext } from "../../src/server/tools.js";
import type { Session } from "../../src/server/session.js";

/**
 * Five holes from the 2026-09-17 review: each let something through that the
 * code around it had clearly meant to stop — a private address behind a
 * public name, a draw-only flag spelled as a patch, a stored rule that could
 * no longer be removed, one frame named twice with a space, and a log that
 * could grow without end. No test here touches real DNS or the network.
 */

const freshSession = () => ({ state: {}, writeCount: 0 }) as unknown as Session;

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---- 1. a public name that resolves to a private address ----

const dns = (table: Record<string, string[]>) => {
  const asked: string[] = [];
  const resolve = async (host: string) => {
    asked.push(host);
    const hit = table[host];
    if (!hit) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return hit.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  return { resolve, asked };
};

describe("loadImage: the host is judged by what it resolves to, not how it is spelled", () => {
  it("refuses a name resolving to loopback, metadata, or a private range", async () => {
    for (const ip of ["127.0.0.1", "169.254.169.254", "10.1.2.3", "::1", "fe80::1%en0", "::ffff:192.168.0.1"]) {
      const { resolve } = dns({ "evil.example.com": [ip] });
      await expect(assertHostResolvesPublic("evil.example.com", resolve)).rejects.toMatchObject({
        code: "INVALID_PARAMS",
        message: expect.stringMatching(/private or local/),
      });
    }
  });

  it("refuses when ANY of the addresses is private, not just the first", async () => {
    const { resolve } = dns({ "mixed.example.com": ["93.184.216.34", "127.0.0.1"] });
    await expect(assertHostResolvesPublic("mixed.example.com", resolve)).rejects.toMatchObject({
      code: "INVALID_PARAMS",
    });
  });

  it("accepts a name whose addresses are all public, and never looks up an IP literal", async () => {
    const { resolve, asked } = dns({ "cdn.example.com": ["93.184.216.34", "2606:2800:220:1::1"] });
    await expect(assertHostResolvesPublic("cdn.example.com", resolve)).resolves.toHaveLength(2);
    await assertHostResolvesPublic("93.184.216.34", resolve);
    expect(asked).toEqual(["cdn.example.com"]);
  });

  it("never fetches a URL whose host resolves private — first hop or a redirect hop", async () => {
    const { resolve } = dns({
      "rebind.example.com": ["127.0.0.1"],
      "ok.example.com": ["93.184.216.34"],
    });
    const reached: string[] = [];
    const fetchImpl = async (u: string) => {
      reached.push(u);
      return new Response(null, { status: 302, headers: { location: "https://rebind.example.com/x" } });
    };
    await expect(
      fetchImageFollowingSafeRedirects("https://rebind.example.com/a.png", fetchImpl, resolve),
    ).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    expect(reached).toEqual([]);

    await expect(
      fetchImageFollowingSafeRedirects("https://ok.example.com/a.png", fetchImpl, resolve),
    ).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    expect(reached).toEqual(["https://ok.example.com/a.png"]);
  });

  it("figma.loadImage refuses it end to end, before any transport is reached", async () => {
    const { resolve } = dns({ "rebind.example.com": ["169.254.169.254"] });
    const reached: string[] = [];
    const record = async (u: string) => {
      reached.push(u);
      return new Response(new Uint8Array([1]), { status: 200 });
    };
    vi.stubGlobal("fetch", record);
    const res = await executeWrite(
      `return await figma.loadImage("https://rebind.example.com/cat.png");`,
      freshSession(),
      { runOp: async () => ({ id: "x", ok: true, result: {} }), imageFetch: record, resolveHost: resolve } as never,
      { timeoutMs: 2000 },
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("INVALID_PARAMS");
    expect(reached).toEqual([]);
  }, 15_000);

  it("the default transport re-checks at connect time, so a rebinding answer never gets a socket", async () => {
    // Public for the pre-flight check, loopback for the lookup the socket
    // makes — the classic rebinding pair. The second answer must be refused.
    let calls = 0;
    const rebinding = async () => {
      calls++;
      return [{ address: calls === 1 ? "93.184.216.34" : "127.0.0.1", family: 4 }];
    };
    await expect(
      fetchImageFollowingSafeRedirects("https://rebind.example.com/a.png", undefined, rebinding),
    ).rejects.toMatchObject({ code: "INVALID_PARAMS", message: expect.stringMatching(/127\.0\.0\.1/) });
    expect(calls).toBe(2);

    await expect(
      pinnedHttpsFetch("https://rebind.example.com/a.png", {}, async () => [{ address: "10.0.0.5", family: 4 }]),
    ).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  });
});

// ---- 2-4. figma_diagram: patches, policies, and the batch's frame ids ----

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
      if (op === "get_diagram_spec") return stored;
      if (op === "layout_audit") return { nodeCount: 3, summary: { issues: [], styleHints: [] } };
      return { frameId: params.intoFrameId ?? "9:9", name: "F" };
    }),
  } as unknown as ToolContext;
  return { ctx, calls };
}

const drawnOptions = (calls: Array<[string, any]>) =>
  ((calls.find((c) => c[0] === "create_sequence" && !c[1].dryRun)![1].source as any).options ?? {}) as Record<
    string,
    unknown
  >;

describe("figma_diagram: a draw-only option set THROUGH a patch", () => {
  it("steers this draw and is not stored", async () => {
    const { ctx, calls } = recordingCtx();
    await handleDiagram(ctx, undefined, {
      update: "1:2",
      patch: [{ set: { "options.verify": false, "options.crossCheck": false } }],
    });
    expect(calls.map((c) => c[0])).not.toContain("layout_audit");
    const stored = drawnOptions(calls);
    expect(stored.verify).toBeUndefined();
    expect(stored.crossCheck).toBeUndefined();
  });

  it("does the same inside a batch entry", async () => {
    const { ctx, calls } = recordingCtx();
    await handleDiagram(ctx, undefined, {
      diagrams: [{ update: "1:2", patch: [{ set: { "options.verify": false } }] }],
    });
    expect(calls.map((c) => c[0])).not.toContain("layout_audit");
    expect(drawnOptions(calls).verify).toBeUndefined();
  });
});

describe("figma_diagram: stored policies can be removed from beside a patch", () => {
  const withRules = { kind: "sequence", spec: { ...SEQ, options: { policies: { "hold-minutes": 10, "retry-attempts": 3 } } } };
  const patch = [{ collection: "messages", id: "m1", set: { label: "x" } }];

  it("a rule set to null is removed and the rest are kept", async () => {
    const { ctx, calls } = recordingCtx(withRules);
    await handleDiagram(ctx, undefined, {
      update: "1:2",
      patch,
      options: { policies: { "hold-minutes": null } },
    });
    expect(drawnOptions(calls).policies).toEqual({ "retry-attempts": 3 });
  });

  it("policies:null removes every stored rule, in a single call and in a batch", async () => {
    const one = recordingCtx(withRules);
    await handleDiagram(one.ctx, undefined, { update: "1:2", patch, options: { policies: null } });
    expect(drawnOptions(one.calls).policies).toBeUndefined();

    const batch = recordingCtx(withRules);
    await handleDiagram(batch.ctx, undefined, { diagrams: [{ update: "1:2", patch }], options: { policies: null } });
    expect(drawnOptions(batch.calls).policies).toBeUndefined();
  });

  it("policies:{} still changes nothing", async () => {
    const { ctx, calls } = recordingCtx(withRules);
    await handleDiagram(ctx, undefined, { update: "1:2", patch, options: { policies: {} } });
    expect(drawnOptions(calls).policies).toEqual({ "hold-minutes": 10, "retry-attempts": 3 });
  });
});

describe("figma_diagram batch: frame ids are compared trimmed", () => {
  it("refuses \"1:2\" and \"1:2 \" as the same frame", async () => {
    const { ctx, calls } = recordingCtx();
    await expect(
      handleDiagram(ctx, undefined, {
        diagrams: [
          { update: "1:2", patch: [{ collection: "messages", id: "m1", set: { label: "A" } }] },
          { update: "1:2 ", patch: [{ collection: "messages", id: "m2", set: { label: "B" } }] },
        ],
      }),
    ).rejects.toMatchObject({ code: "INVALID_PARAMS", message: expect.stringMatching(/both update frame "1:2"/) });
    expect(calls).toHaveLength(0);
  });

  it("reads and draws into the trimmed id", async () => {
    const { ctx, calls } = recordingCtx();
    await handleDiagram(ctx, undefined, {
      diagrams: [{ update: " 1:2 ", patch: [{ collection: "messages", id: "m1", set: { label: "A" } }] }],
    });
    expect(calls.find((c) => c[0] === "get_diagram_spec")![1].nodeId).toBe("1:2");
    expect(calls.find((c) => c[0] === "create_sequence" && !c[1].dryRun)![1].intoFrameId).toBe("1:2");
  });
});

// ---- 5. figma_write logs are bounded ----

describe("figma_write: console output is capped", () => {
  it("keeps the first lines, drops the flood, and says how much it dropped", async () => {
    const total = MAX_LOG_LINES + 5000;
    const res = await executeWrite(
      `for (let i = 0; i < ${total}; i++) console.log("line " + i + " " + "x".repeat(50)); return 1;`,
      freshSession(),
      { runOp: async () => ({ id: "x", ok: true, result: {} }) } as never,
      { timeoutMs: 10_000 },
    );
    expect(res.ok).toBe(true);
    expect(res.logs.length).toBeLessThanOrEqual(MAX_LOG_LINES + 1);
    expect(res.logs[0]).toMatch(/^line 0 /);
    expect(res.logs[res.logs.length - 1]).toBe("… 5000 more log lines truncated");
  }, 30_000);

  it("bounds one enormous line and the total size", async () => {
    const res = await executeWrite(
      `console.log("y".repeat(5_000_000)); for (let i = 0; i < 200; i++) console.log("z".repeat(9000)); return 1;`,
      freshSession(),
      { runOp: async () => ({ id: "x", ok: true, result: {} }) } as never,
      { timeoutMs: 10_000 },
    );
    expect(res.ok).toBe(true);
    expect(res.logs[0]!.length).toBeLessThan(20_000);
    expect(res.logs.join("\n").length).toBeLessThan(150_000);
    expect(res.logs[res.logs.length - 1]).toMatch(/more log lines? truncated$/);
  }, 30_000);
});

// ---- the pinned image transport against a hostile host ----

import { execFileSync as execFileSyncTls } from "node:child_process";
import { mkdtempSync, readFileSync as readFileSyncTls } from "node:fs";
import { tmpdir as tmpdirTls } from "node:os";
import { join as joinTls } from "node:path";
import { createServer as createTlsServer } from "node:tls";

/** A throwaway self-signed cert, made at test time; skipped without openssl. */
function makeCert(): { key: Buffer; cert: Buffer } | null {
  try {
    const dir = mkdtempSync(joinTls(tmpdirTls(), "reqwise-tls-"));
    execFileSyncTls("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=127.0.0.1", "-days", "1",
      "-keyout", joinTls(dir, "k.pem"), "-out", joinTls(dir, "c.pem")], { stdio: "ignore" });
    return { key: readFileSyncTls(joinTls(dir, "k.pem")), cert: readFileSyncTls(joinTls(dir, "c.pem")) };
  } catch {
    return null;
  }
}
const tls = makeCert();

describe.skipIf(!tls)("pinnedHttpsFetch against a hostile host", () => {
  const serve = (onData: (sock: import("node:tls").TLSSocket) => void): Promise<number> =>
    new Promise((resolve) => {
      const s = createTlsServer({ key: tls!.key, cert: tls!.cert }, (sock) => {
        sock.once("data", () => onData(sock));
      });
      s.unref();
      s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
    });
  const call = (port: number, init: RequestInit = {}) => {
    const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    return pinnedHttpsFetch(`https://127.0.0.1:${port}/x.png`, init).finally(() => {
      if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
    });
  };

  it("an out-of-range status is a rejected fetch, not an uncaught crash or a hang", async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on("uncaughtException", onUncaught);
    try {
      const port = await serve((sock) => sock.end("HTTP/1.1 999 Weird\r\nContent-Length: 0\r\n\r\n"));
      await expect(call(port)).rejects.toThrow(/invalid HTTP status 999/);
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });

  it("refuses a body declared bigger than the cap without reading it", async () => {
    const port = await serve((sock) => sock.end("HTTP/1.1 200 OK\r\nContent-Length: 999999999\r\n\r\n"));
    await expect(call(port)).rejects.toThrow(/larger than 20MB/);
  });

  it("stops downloading when the caller's signal aborts", async () => {
    const port = await serve((sock) => {
      sock.write("HTTP/1.1 200 OK\r\nContent-Length: 100000\r\n\r\n");
      const t = setInterval(() => sock.write("x"), 50);
      sock.on("close", () => clearInterval(t));
    });
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 200);
    await expect(call(port, { signal: abort.signal })).rejects.toThrow(/cancelled/);
  });
});

describe("policies null on a fresh draw", () => {
  it("is accepted and means no rule, like beside a patch", async () => {
    const drawn: any[] = [];
    const ctx = {
      runValidated: vi.fn(async (op: string, params: any) => {
        if (op.startsWith("create_")) drawn.push(params);
        return { frameId: "9:9" };
      }),
    } as unknown as ToolContext;
    const spec = {
      title: "Pay",
      participants: [{ id: "a", name: "App" }, { id: "b", name: "API" }],
      messages: [{ id: "m1", from: "a", to: "b", label: "POST" }],
      options: { verify: false, policies: { "hold-minutes": null, retries: 3 } },
    };
    await handleDiagram(ctx, "sequence", spec as never);
    expect(drawn).toHaveLength(1);
    expect(drawn[0].source.options.policies).toEqual({ retries: 3 });
    await handleDiagram(ctx, "sequence", { ...spec, options: { verify: false, policies: null } } as never);
    expect(drawn[1].source.options?.policies).toBeUndefined();
  });
});
