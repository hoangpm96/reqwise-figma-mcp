import { describe, it, expect } from "vitest";
import { executeWrite } from "../../src/server/executor.js";
import { SessionRegistry } from "../../src/server/session.js";
import type { AnyOperation as Operation, BridgeResponse } from "../../src/shared/protocol.js";

/** A fake op runner that records calls and returns canned results. */
function fakeRunner(
  impl: (op: Operation, params: Record<string, unknown>) => BridgeResponse | Promise<BridgeResponse>,
) {
  const calls: Array<{ op: Operation; params: Record<string, unknown> }> = [];
  const runOp = async (op: Operation, params: Record<string, unknown>): Promise<BridgeResponse> => {
    calls.push({ op, params });
    return impl(op, params);
  };
  return { runOp, calls };
}

const okRes = (result: unknown, warnings?: string[]): BridgeResponse => ({
  id: "x",
  ok: true,
  result,
  ...(warnings ? { warnings } : {}),
});

describe("executor sandbox", () => {
  it("bans require/process/fetch/setTimeout/eval", async () => {
    const sessions = new SessionRegistry();
    const { runOp } = fakeRunner(() => okRes(null));

    for (const banned of ["require('fs')", "process.exit(0)", "fetch('http://x')", "setTimeout(()=>{},1)", "eval('1+1')"]) {
      const res = await executeWrite(`return ${banned};`, sessions.get(), { runOp });
      expect(res.ok, banned).toBe(false);
      expect(res.error?.code).toBe("SANDBOX_ERROR");
    }
  });

  it("has no access to globalThis or Function constructor", async () => {
    const sessions = new SessionRegistry();
    const { runOp } = fakeRunner(() => okRes(null));
    const r1 = await executeWrite("return typeof globalThis;", sessions.get(), { runOp });
    expect(r1.ok).toBe(true);
    expect(r1.result).toBe("undefined");

    const r2 = await executeWrite("return Function('return 1')();", sessions.get(), { runOp });
    expect(r2.ok).toBe(false);
    expect(r2.error?.code).toBe("SANDBOX_ERROR");
  });

  it("cannot reach host process/require via the prototype-chain constructor", async () => {
    const sessions = new SessionRegistry();
    const { runOp } = fakeRunner(() => okRes(null));

    // Real escape vectors that previously LEAKED: the Function constructor
    // reached through `this.constructor.constructor` (and via {}.constructor)
    // ran in the host realm and could read the real `process` directly (not
    // just via `this.process`). The hardening prelude neutralizes the
    // constructor path, so each of these must now either throw or NOT return
    // host data. We assert the built function cannot observe the real process.
    // Each probe returns host data if the escape leaks the HOST realm, and a
    // benign sentinel otherwise. The security property: the escaped function
    // must never observe the real process (a numeric pid, a real platform
    // string, or a non-empty env). Whether the constructor path throws or
    // resolves to the sandbox realm's (empty) Function is fine — either way it
    // must not reach host globals.
    const escapes = [
      // audit's exact vector: F("return process.platform")() -> "darwin" (leak)
      `const F = this.constructor.constructor; const p = F("return typeof process!=='undefined' ? String(process.platform) : 'no-host'")(); return p;`,
      `const F = ({}).constructor.constructor; const p = F("return typeof process!=='undefined' ? String(process.pid) : 'no-host'")(); return p;`,
      `const F = (async()=>{}).constructor; const n = F("return typeof process!=='undefined' && process.env ? Object.keys(process.env).length : -1")(); return n;`,
    ];
    const hostPlatform = process.platform;
    const hostEnvCount = Object.keys(process.env).length;
    for (const code of escapes) {
      const res = await executeWrite(code, sessions.get(), { runOp });
      if (res.ok) {
        const val = res.result instanceof Promise ? await res.result : res.result;
        // Must NOT be real host data.
        expect(val, `escape leaked host platform: ${code}`).not.toBe(hostPlatform);
        if (typeof val === "string") {
          expect(val, `escape leaked host pid: ${code}`).not.toMatch(/^\d{2,}$/);
        }
        if (typeof val === "number") {
          expect(val, `escape leaked host env count: ${code}`).not.toBe(hostEnvCount);
          expect(val, `escape leaked host env: ${code}`).toBeLessThanOrEqual(0);
        }
      } else {
        expect(res.error?.code, code).toBe("SANDBOX_ERROR");
      }
    }

    // And a direct reference to the banned stubs still throws.
    for (const code of ["return process.env.PATH;", "return require('fs');", "return Function('return 1')();"]) {
      const r = await executeWrite(code, sessions.get(), { runOp });
      expect(r.ok, code).toBe(false);
      expect(r.error?.code, code).toBe("SANDBOX_ERROR");
    }
  });

  it("runs modern ES (optional chaining, nullish, spread, async/await)", async () => {
    const sessions = new SessionRegistry();
    const { runOp } = fakeRunner((op) => okRes({ echoed: op }));
    const code = `
      const a = { b: { c: 42 } };
      const val = a?.b?.c ?? 0;
      const arr = [1, 2, ...[3, 4]];
      const node = await figma.create({ type: "FRAME" });
      return { val, sum: arr.reduce((x, y) => x + y, 0), node };
    `;
    const res = await executeWrite(code, sessions.get(), { runOp });
    expect(res.ok).toBe(true);
    expect(res.result).toEqual({ val: 42, sum: 10, node: { echoed: "create" } });
  });

  it("captures console output", async () => {
    const sessions = new SessionRegistry();
    const { runOp } = fakeRunner(() => okRes(null));
    const res = await executeWrite(`console.log("hello", 1); console.warn("careful"); console.error("boom");`, sessions.get(), { runOp });
    expect(res.ok).toBe(true);
    expect(res.logs).toContain("hello 1");
    expect(res.logs).toContain("WARN: careful");
    expect(res.logs).toContain("ERROR: boom");
  });

  it("persists `state` across figma_write calls in the same session", async () => {
    const sessions = new SessionRegistry();
    const { runOp } = fakeRunner(() => okRes(null));
    const s = sessions.get("s1");

    const r1 = await executeWrite(`state.counter = (state.counter ?? 0) + 1; state.ids = ["a"]; return state.counter;`, s, { runOp });
    expect(r1.result).toBe(1);

    const s2 = sessions.get("s1");
    const r2 = await executeWrite(`state.counter += 1; state.ids.push("b"); return { counter: state.counter, ids: state.ids };`, s2, { runOp });
    expect(r2.result).toEqual({ counter: 2, ids: ["a", "b"] });
  });

  it("isolates state between different sessions", async () => {
    const sessions = new SessionRegistry();
    const { runOp } = fakeRunner(() => okRes(null));
    await executeWrite(`state.x = 1;`, sessions.get("A"), { runOp });
    const r = await executeWrite(`return state.x ?? "unset";`, sessions.get("B"), { runOp });
    expect(r.result).toBe("unset");
  });

  it("surfaces figma op errors with {code,message,hint}", async () => {
    const sessions = new SessionRegistry();
    const { runOp } = fakeRunner(() => ({ id: "x", ok: false, error: { code: "NODE_NOT_FOUND" as never, message: "no node 9:9", hint: "check id" } }));
    const res = await executeWrite(`await figma.modify("9:9", { x: 1 });`, sessions.get(), { runOp });
    expect(res.ok).toBe(false);
    expect(res.error).toMatchObject({ code: "NODE_NOT_FOUND", message: "no node 9:9", hint: "check id" });
  });

  it("collects warnings from ops", async () => {
    const sessions = new SessionRegistry();
    const { runOp } = fakeRunner(() => okRes({ id: "1:1" }, ["will be clipped by parent"]));
    const res = await executeWrite(`await figma.create({ type: "FRAME" }); return "done";`, sessions.get(), { runOp });
    expect(res.ok).toBe(true);
    expect(res.warnings).toContain("will be clipped by parent");
  });
});

describe("executor edit-in-place proxy → op mapping + arg normalization", () => {
  it("maps getInstanceOverrides → get_instance_overrides (with and without nodeId)", async () => {
    const sessions = new SessionRegistry();
    const { runOp, calls } = fakeRunner(() => okRes({ overrides: [] }));
    await executeWrite(`await figma.getInstanceOverrides("12:100");`, sessions.get(), { runOp });
    await executeWrite(`await figma.getInstanceOverrides();`, sessions.get(), { runOp });
    expect(calls[0]).toEqual({ op: "get_instance_overrides", params: { nodeId: "12:100" } });
    expect(calls[1]).toEqual({ op: "get_instance_overrides", params: {} });
  });

  it("maps setInstanceOverrides(sourceId, targetIds) → {sourceId, targetIds}", async () => {
    const sessions = new SessionRegistry();
    const { runOp, calls } = fakeRunner(() => okRes({ applied: 2 }));
    await executeWrite(`await figma.setInstanceOverrides("12:100", ["12:101", "12:102"]);`, sessions.get(), { runOp });
    expect(calls[0]).toEqual({
      op: "set_instance_overrides",
      params: { sourceId: "12:100", targetIds: ["12:101", "12:102"] },
    });
  });

  it("maps setSelectionColors(nodeId, opts) → {nodeId, ...opts}", async () => {
    const sessions = new SessionRegistry();
    const { runOp, calls } = fakeRunner(() => okRes({ recolored: 5 }));
    await executeWrite(`await figma.setSelectionColors("7:20", { from: "#2563EB", to: "#7C3AED", includeStrokes: true });`, sessions.get(), { runOp });
    expect(calls[0]).toEqual({
      op: "set_selection_colors",
      params: { nodeId: "7:20", from: "#2563EB", to: "#7C3AED", includeStrokes: true },
    });
  });

  it("maps setSelectionColors({opts}) with no nodeId → opts bag directly", async () => {
    const sessions = new SessionRegistry();
    const { runOp, calls } = fakeRunner(() => okRes({ recolored: 1 }));
    await executeWrite(`await figma.setSelectionColors({ to: "#111827" });`, sessions.get(), { runOp });
    expect(calls[0]).toEqual({ op: "set_selection_colors", params: { to: "#111827" } });
  });

  it("maps setGradient(nodeId, opts) → {nodeId, ...opts}", async () => {
    const sessions = new SessionRegistry();
    const { runOp, calls } = fakeRunner(() => okRes({ ok: true }));
    await executeWrite(
      `await figma.setGradient("1:1", { type: "LINEAR", stops: [{ position: 0, color: "#000" }, { position: 1, color: "#fff" }] });`,
      sessions.get(),
      { runOp },
    );
    expect(calls[0]).toEqual({
      op: "set_gradient",
      params: {
        nodeId: "1:1",
        type: "LINEAR",
        stops: [{ position: 0, color: "#000" }, { position: 1, color: "#fff" }],
      },
    });
  });

  it("maps setEffects(nodeId, effects) → {nodeId, effects}", async () => {
    const sessions = new SessionRegistry();
    const { runOp, calls } = fakeRunner(() => okRes({ ok: true }));
    await executeWrite(
      `await figma.setEffects("1:1", [{ type: "DROP_SHADOW", color: "#00000033", offset: { x: 0, y: 4 }, radius: 12, spread: 0 }]);`,
      sessions.get(),
      { runOp },
    );
    expect(calls[0]).toEqual({
      op: "set_effects",
      params: {
        nodeId: "1:1",
        effects: [{ type: "DROP_SHADOW", color: "#00000033", offset: { x: 0, y: 4 }, radius: 12, spread: 0 }],
      },
    });
  });

  it("maps readSelection(opts) → read_selection passthrough", async () => {
    const sessions = new SessionRegistry();
    const { runOp, calls } = fakeRunner(() => okRes({ nodes: [] }));
    await executeWrite(`await figma.readSelection({ detail: "compact", depth: 2 });`, sessions.get(), { runOp });
    expect(calls[0]).toEqual({ op: "read_selection", params: { detail: "compact", depth: 2 } });
  });

  it("maps design-system read helpers", async () => {
    const sessions = new SessionRegistry();
    const { runOp, calls } = fakeRunner(() => okRes({}));
    await executeWrite(
      `
      await figma.getComponent("1:1");
      await figma.getComponent({ nodeId: "1:2", depth: 1 });
      await figma.getDesignSystemKit({ detail: "design", depth: 2 });
      await figma.generateDesignMd({ includeJson: true });
      `,
      sessions.get(),
      { runOp },
    );
    expect(calls[0]).toEqual({ op: "get_component", params: { componentId: "1:1" } });
    expect(calls[1]).toEqual({ op: "get_component", params: { nodeId: "1:2", depth: 1 } });
    expect(calls[2]).toEqual({ op: "get_design_system_kit", params: { detail: "design", depth: 2 } });
    expect(calls[3]).toEqual({ op: "generate_design_md", params: { includeJson: true } });
  });

  it("maps setCurrentPage(idOrOptions)", async () => {
    const sessions = new SessionRegistry();
    const { runOp, calls } = fakeRunner(() => okRes({ current: true }));
    await executeWrite(
      `await figma.setCurrentPage("0:2");
       await figma.setCurrentPage({ name: "Desktop" });`,
      sessions.get(),
      { runOp },
    );
    expect(calls[0]).toEqual({ op: "set_current_page", params: { pageId: "0:2" } });
    expect(calls[1]).toEqual({ op: "set_current_page", params: { name: "Desktop" } });
  });
});

describe("executor batch chunking + partial errors", () => {
  it("splits >20 ops into chunks and reports per-index results", async () => {
    const sessions = new SessionRegistry();
    const chunkSizes: number[] = [];
    const runOp = async (op: Operation, params: Record<string, unknown>): Promise<BridgeResponse> => {
      expect(op).toBe("batch");
      const ops = (params["ops"] as unknown[]) ?? [];
      chunkSizes.push(ops.length);
      // Echo one item result per input; succeed all.
      return okRes({ items: ops.map((_, i) => ({ ok: true, result: { created: i } })) });
    };

    const N = 45; // 20 + 20 + 5
    const code = `
      const ops = Array.from({ length: ${N} }, (_, i) => ({ op: "create", params: { type: "FRAME", name: "f" + i } }));
      return await figma.batch(ops);
    `;
    const res = await executeWrite(code, sessions.get(), { runOp });
    expect(res.ok).toBe(true);
    const out = res.result as { total: number; ok: number; failed: number; results: Array<{ index: number; ok: boolean }> };
    expect(out.total).toBe(N);
    expect(out.ok).toBe(N);
    expect(out.failed).toBe(0);
    expect(chunkSizes).toEqual([20, 20, 5]);
    expect(out.results.map((r) => r.index)).toEqual([...Array(N).keys()]);
  });

  it("resultDetail:'ids' trims each successful item's result to just its id", async () => {
    const sessions = new SessionRegistry();
    const runOp = async (_op: Operation, params: Record<string, unknown>): Promise<BridgeResponse> => {
      const ops = (params["ops"] as unknown[]) ?? [];
      // Plugin echoes a full node per item; the executor should trim it.
      return okRes({
        items: ops.map((_, i) => ({ ok: true, result: { id: `9:${i}`, node: { id: `9:${i}`, name: "f", type: "FRAME", x: 0, y: 0, w: 10, h: 10 } } })),
      });
    };
    const code = `
      const ops = Array.from({ length: 3 }, (_, i) => ({ op: "create", params: { type: "FRAME" } }));
      return await figma.batch(ops, { resultDetail: "ids" });
    `;
    const res = await executeWrite(code, sessions.get(), { runOp });
    expect(res.ok).toBe(true);
    const out = res.result as { results: Array<{ ok: boolean; result?: unknown }> };
    expect(out.results.map((r) => r.result)).toEqual([{ id: "9:0" }, { id: "9:1" }, { id: "9:2" }]);
  });

  it("defaults to full results when resultDetail is omitted", async () => {
    const sessions = new SessionRegistry();
    const runOp = async (_op: Operation, params: Record<string, unknown>): Promise<BridgeResponse> => {
      const ops = (params["ops"] as unknown[]) ?? [];
      return okRes({ items: ops.map((_, i) => ({ ok: true, result: { id: `9:${i}`, node: { id: `9:${i}`, name: "f" } } })) });
    };
    const code = `return await figma.batch([{ op: "create", params: { type: "FRAME" } }]);`;
    const res = await executeWrite(code, sessions.get(), { runOp });
    const out = res.result as { results: Array<{ result?: { node?: unknown } }> };
    expect(out.results[0]!.result).toHaveProperty("node");
  });

  it("reports exact failing index without aborting the batch (partial commit)", async () => {
    const sessions = new SessionRegistry();
    const runOp = async (_op: Operation, params: Record<string, unknown>): Promise<BridgeResponse> => {
      const ops = (params["ops"] as Array<{ params: Record<string, unknown> }>) ?? [];
      return okRes({
        items: ops.map((o) =>
          o.params["name"] === "bad"
            ? { ok: false, error: { code: "INVALID_PARAMS", message: "bad spec", hint: "fix it" } }
            : { ok: true, result: { id: o.params["name"] } },
        ),
      });
    };
    const code = `
      return await figma.batch([
        { op: "create", params: { type: "FRAME", name: "ok0" } },
        { op: "create", params: { type: "FRAME", name: "bad" } },
        { op: "create", params: { type: "FRAME", name: "ok2" } },
      ]);
    `;
    const res = await executeWrite(code, sessions.get(), { runOp });
    const out = res.result as { ok: number; failed: number; results: Array<{ index: number; ok: boolean; error?: { message: string } }> };
    expect(out.ok).toBe(2);
    expect(out.failed).toBe(1);
    expect(out.results[1]?.ok).toBe(false);
    expect(out.results[1]?.error?.message).toBe("bad spec");
    expect(out.results[0]?.ok).toBe(true);
    expect(out.results[2]?.ok).toBe(true);
  });

  it("fails a batch item that does not pass validation, at its exact index, still running the rest", async () => {
    const sessions = new SessionRegistry();
    const runOp = async (_op: Operation, params: Record<string, unknown>): Promise<BridgeResponse> => {
      const ops = (params["ops"] as unknown[]) ?? [];
      return okRes({ items: ops.map(() => ({ ok: true, result: {} })) });
    };
    const code = `
      return await figma.batch([
        { op: "create", params: { type: "FRAME" } },
        { op: "modify", params: { /* missing nodeId */ props: {} } },
        { op: "create", params: { type: "TEXT" } },
      ]);
    `;
    const res = await executeWrite(code, sessions.get(), { runOp });
    const out = res.result as { ok: number; failed: number; results: Array<{ index: number; ok: boolean; error?: { code: string } }> };
    expect(out.failed).toBe(1);
    expect(out.results[1]?.ok).toBe(false);
    expect(out.results[1]?.error?.code).toBe("INVALID_PARAMS");
    expect(out.results[0]?.ok).toBe(true);
    expect(out.results[2]?.ok).toBe(true);
  });
});

/**
 * DX-trap regression tests — each of these was a real failure mode observed
 * live: a fresh agent using official-Figma-API muscle memory got silently
 * wrong behavior instead of an error (or instead of just working).
 */
describe("executor sandbox DX traps", () => {
  it("create(spec, parentId) merges the second arg as parentId (was: silently dropped)", async () => {
    const sessions = new SessionRegistry();
    const { runOp, calls } = fakeRunner(() => okRes({ id: "9:9" }));
    const res = await executeWrite(
      `return await figma.create({ type: "FRAME", name: "Child" }, "1:23");`,
      sessions.get(),
      { runOp },
    );
    expect(res.ok).toBe(true);
    expect(calls[0]?.params["parentId"]).toBe("1:23");
  });

  it("create(spec, nodeObject) uses the node's id as parentId", async () => {
    const sessions = new SessionRegistry();
    const { runOp, calls } = fakeRunner(() => okRes({ id: "9:9" }));
    const res = await executeWrite(
      `const parent = { id: "4:56", name: "Card" };
       return await figma.create({ type: "TEXT", characters: "hi" }, parent);`,
      sessions.get(),
      { runOp },
    );
    expect(res.ok).toBe(true);
    expect(calls[0]?.params["parentId"]).toBe("4:56");
  });

  it("explicit spec.parentId wins over the second arg", async () => {
    const sessions = new SessionRegistry();
    const { runOp, calls } = fakeRunner(() => okRes({ id: "9:9" }));
    await executeWrite(
      `return await figma.create({ type: "FRAME", parentId: "7:7" }, "1:23");`,
      sessions.get(),
      { runOp },
    );
    expect(calls[0]?.params["parentId"]).toBe("7:7");
  });

  it("getNode returns a FLAT snapshot with width/height aliases (was: {node} wrapper)", async () => {
    const sessions = new SessionRegistry();
    const { runOp } = fakeRunner(() =>
      okRes({ node: { id: "1:1", name: "Card", type: "FRAME", x: 0, y: 0, w: 320, h: 200 } }),
    );
    const res = await executeWrite(
      `const n = await figma.getNode("1:1");
       return { name: n.name, w: n.w, width: n.width, height: n.height };`,
      sessions.get(),
      { runOp },
    );
    expect(res.ok).toBe(true);
    expect(res.result).toEqual({ name: "Card", w: 320, width: 320, height: 200 });
  });

  it("getChildren returns an iterable ARRAY (was: non-iterable wrapper)", async () => {
    const sessions = new SessionRegistry();
    const { runOp, calls } = fakeRunner(() =>
      okRes({
        node: { id: "1:1", name: "Row", type: "FRAME" },
        children: [
          { id: "1:2", name: "A", type: "TEXT", w: 10, h: 5 },
          { id: "1:3", name: "B", type: "TEXT", w: 20, h: 5 },
        ],
      }),
    );
    const res = await executeWrite(
      `const kids = await figma.getChildren("1:1");
       const names = [];
       for (const k of kids) names.push(k.name + ":" + k.width);
       return names;`,
      sessions.get(),
      { runOp },
    );
    expect(res.ok).toBe(true);
    expect(res.result).toEqual(["A:10", "B:20"]);
    expect(calls[0]?.params["includeChildren"]).toBe(true);
  });

  it("figma.mixed is a real sentinel (was: undefined, matching every missing prop)", async () => {
    const sessions = new SessionRegistry();
    const { runOp } = fakeRunner(() => okRes(null));
    const res = await executeWrite(
      `const node = { fontSize: "mixed" };
       return {
         matchesMixed: node.fontSize === figma.mixed,
         undefinedIsNotMixed: node.missingProp === figma.mixed,
       };`,
      sessions.get(),
      { runOp },
    );
    expect(res.ok).toBe(true);
    expect(res.result).toEqual({ matchesMixed: true, undefinedIsNotMixed: false });
  });

  it("unknown official-API method throws a mapped, actionable error (was: bare TypeError)", async () => {
    const sessions = new SessionRegistry();
    const { runOp } = fakeRunner(() => okRes(null));
    const res = await executeWrite(
      `return await figma.getNodeByIdAsync("1:1");`,
      sessions.get(),
      { runOp },
    );
    expect(res.ok).toBe(false);
    expect(res.error?.message).toContain("getNodeByIdAsync");
    expect(res.error?.hint).toContain("figma.getNode");
  });

  it("unknown method with no mapping suggests near-miss methods", async () => {
    const sessions = new SessionRegistry();
    const { runOp } = fakeRunner(() => okRes(null));
    const res = await executeWrite(
      `return await figma.screenshotNode("1:1");`,
      sessions.get(),
      { runOp },
    );
    expect(res.ok).toBe(false);
    expect(res.error?.hint ?? "").toMatch(/screenshot|figma_docs/);
  });

  it("await figma (thenable probe) does not explode", async () => {
    const sessions = new SessionRegistry();
    const { runOp } = fakeRunner(() => okRes(null));
    const res = await executeWrite(
      `const f = figma; return typeof f.then;`,
      sessions.get(),
      { runOp },
    );
    expect(res.ok).toBe(true);
    expect(res.result).toBe("undefined");
  });
});

describe("palette nudge (once per session)", () => {
  it("first literal-color create with no tokens warns; later creates stay quiet", async () => {
    const sessions = new SessionRegistry();
    const session = sessions.get("nudge-test");
    const { runOp } = fakeRunner(() => okRes({ id: "1:1" }));

    const first = await executeWrite(
      `return await figma.create({ type: "FRAME", fills: [{ type: "SOLID", color: "#2563eb" }] });`,
      session,
      { runOp },
    );
    expect(first.ok).toBe(true);
    expect(first.warnings.join(" ")).toContain("propose a small palette");

    const second = await executeWrite(
      `return await figma.create({ type: "FRAME", fills: "#ffffff" });`,
      session,
      { runOp },
    );
    expect(second.ok).toBe(true);
    expect(second.warnings.join(" ")).not.toContain("propose a small palette");
  });

  it("does not nudge when the session already has tokens", async () => {
    const sessions = new SessionRegistry();
    const session = sessions.get("tokens-test");
    const { runOp } = fakeRunner((op) =>
      op === "setup_tokens" ? okRes({ created: 1 }) : okRes({ id: "1:1" }),
    );

    await executeWrite(
      `await figma.setupTokens({ colors: { primary: "#2563EB" } });`,
      session,
      { runOp },
    );
    const res = await executeWrite(
      `return await figma.create({ type: "FRAME", fills: "#2563EB" });`,
      session,
      { runOp },
    );
    expect(res.ok).toBe(true);
    expect(res.warnings.join(" ")).not.toContain("propose a small palette");
  });

  it("does not nudge paint-less creates (layout wrappers)", async () => {
    const sessions = new SessionRegistry();
    const session = sessions.get("wrapper-test");
    const { runOp } = fakeRunner(() => okRes({ id: "1:1" }));
    const res = await executeWrite(
      `return await figma.create({ type: "FRAME", layoutMode: "VERTICAL" });`,
      session,
      { runOp },
    );
    expect(res.ok).toBe(true);
    expect(res.warnings.join(" ")).not.toContain("propose a small palette");
  });
});

describe("executor — instantiate arg mapping", () => {
  it("maps instantiate(idOrName, opts) to {componentId, ...opts}", async () => {
    const sessions = new SessionRegistry();
    const { runOp, calls } = fakeRunner(() => okRes({ id: "I1:2;0:1" }));
    const res = await executeWrite(
      `return await figma.instantiate("Button/Primary", { parentId: "9:9" });`,
      sessions.get(),
      { runOp },
    );
    expect(res.ok).toBe(true);
    expect(calls[0]!.op).toBe("instantiate");
    expect(calls[0]!.params).toMatchObject({ componentId: "Button/Primary", parentId: "9:9" });
  });

  it("maps instantiate({component, ...}, opts) by spreading the object", async () => {
    const sessions = new SessionRegistry();
    const { runOp, calls } = fakeRunner(() => okRes({ id: "I1:2;0:1" }));
    const res = await executeWrite(
      `return await figma.instantiate({ component: "Button" }, { parentId: "9:9" });`,
      sessions.get(),
      { runOp },
    );
    expect(res.ok).toBe(true);
    expect(calls[0]!.params).toMatchObject({ component: "Button", parentId: "9:9" });
    expect(calls[0]!.params["componentId"]).toBeUndefined();
  });
});

describe("executor — findOrCreateComponent arg mapping", () => {
  it("maps (name, spec, opts) to {name, spec, ...opts}", async () => {
    const sessions = new SessionRegistry();
    const { runOp, calls } = fakeRunner(() => okRes({ decision: "reuse", id: "1:2" }));
    const res = await executeWrite(
      `return await figma.findOrCreateComponent("Button", { type: "FRAME" }, { dryRun: true });`,
      sessions.get(),
      { runOp },
    );
    expect(res.ok).toBe(true);
    expect(calls[0]!.params).toMatchObject({
      name: "Button",
      spec: { type: "FRAME" },
      dryRun: true,
    });
  });
});

describe("executor — new component op mappings", () => {
  it("maps setComponentDescription(nodeId, string) and arrangeComponentSet(nodeId, opts)", async () => {
    const sessions = new SessionRegistry();
    const { runOp, calls } = fakeRunner(() => okRes({ id: "5:0" }));
    const res = await executeWrite(
      `await figma.setComponentDescription("1:2", "Primary action");
       await figma.arrangeComponentSet("5:0", { gap: 32 });
       return true;`,
      sessions.get(),
      { runOp },
    );
    expect(res.ok).toBe(true);
    expect(calls[0]!.op).toBe("set_component_description");
    expect(calls[0]!.params).toMatchObject({ nodeId: "1:2", description: "Primary action" });
    expect(calls[1]!.op).toBe("arrange_component_set");
    expect(calls[1]!.params).toMatchObject({ nodeId: "5:0", gap: 32 });
  });
});

describe("executor — library + instance lifecycle mappings", () => {
  it("maps getLibraryComponent(key) and detachInstance(ids)", async () => {
    const sessions = new SessionRegistry();
    const { runOp, calls } = fakeRunner(() => okRes({ ok: true }));
    const res = await executeWrite(
      `await figma.getLibraryComponent("abc123");
       await figma.detachInstance(["10:1", "10:2"]);
       await figma.resetInstanceOverrides("10:3");
       return true;`,
      sessions.get(),
      { runOp },
    );
    expect(res.ok).toBe(true);
    expect(calls[0]!.op).toBe("get_library_component");
    expect(calls[0]!.params).toMatchObject({ key: "abc123" });
    expect(calls[1]!.op).toBe("detach_instance");
    expect(calls[1]!.params).toMatchObject({ nodeIds: ["10:1", "10:2"] });
    expect(calls[2]!.op).toBe("reset_instance_overrides");
    expect(calls[2]!.params).toMatchObject({ nodeId: "10:3" });
  });
});

describe("executor — variable CRUD mappings", () => {
  it("maps createVariable/renameVariable/deleteVariable ergonomics", async () => {
    const sessions = new SessionRegistry();
    const { runOp, calls } = fakeRunner(() => okRes({ id: "VariableID:1" }));
    const res = await executeWrite(
      `await figma.createVariable("primary", { value: "#36e", type: "COLOR" });
       await figma.createVariable("radius", 8);
       await figma.renameVariable("primary", "color/primary");
       await figma.deleteVariable("old", { replaceWith: "color/primary" });
       return true;`,
      sessions.get(),
      { runOp },
    );
    expect(res.ok).toBe(true);
    expect(calls[0]!.params).toMatchObject({ name: "primary", value: "#36e", type: "COLOR" });
    expect(calls[1]!.params).toMatchObject({ name: "radius", value: 8 });
    expect(calls[2]!.op).toBe("rename_variable");
    expect(calls[2]!.params).toMatchObject({ variable: "primary", newName: "color/primary" });
    expect(calls[3]!.params).toMatchObject({ variable: "old", replaceWith: "color/primary" });
  });
});

describe("executor — token export/import mappings", () => {
  it("maps exportTokens(format) and importTokens(tree, opts)", async () => {
    const sessions = new SessionRegistry();
    const { runOp, calls } = fakeRunner(() => okRes({ ok: true }));
    const res = await executeWrite(
      `await figma.exportTokens("css");
       await figma.importTokens({ color: { primary: { $value: "#36e" } } }, { mode: "light" });
       return true;`,
      sessions.get(),
      { runOp },
    );
    expect(res.ok).toBe(true);
    expect(calls[0]!.op).toBe("export_tokens");
    expect(calls[0]!.params).toMatchObject({ format: "css" });
    expect(calls[1]!.op).toBe("import_tokens");
    expect(calls[1]!.params).toMatchObject({
      tokens: { color: { primary: { $value: "#36e" } } },
      mode: "light",
    });
  });
});
