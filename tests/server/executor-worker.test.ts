import { describe, expect, it } from "vitest";
import { executeWrite } from "../../src/server/executor.js";
import { ErrorCode } from "../../src/shared/protocol.js";
import type { Session } from "../../src/server/session.js";

// Worker-isolation tests use a short injected budget so the suite does not
// spend the real 120s VM_TIMEOUT_MS waiting for a loop to be killed.
const FAST = { timeoutMs: 300 };
const slack = 3000;

const freshSession = () => ({ state: {}, writeCount: 0 }) as unknown as Session;
const deps = {
  runOp: async (op: string) => ({ ok: true, result: { id: "1:2", op } }),
};

describe("figma_write worker isolation", () => {
  it("returns results and bridge-call results", async () => {
    const res = await executeWrite(
      `const n = await figma.getNode("1:2"); return n.id + "!";`,
      freshSession(),
      deps as never,
      FAST,
    );
    expect(res.ok).toBe(true);
    expect(res.result).toBe("1:2!");
  });

  it("streams console lines back", async () => {
    const res = await executeWrite(
      `console.log("hello", {a:1}); console.warn("careful"); return 0;`,
      freshSession(),
      deps as never,
      FAST,
    );
    expect(res.ok).toBe(true);
    expect(res.logs.join("\n")).toContain('hello {"a":1}');
    expect(res.logs.join("\n")).toContain("WARN: careful");
  });

  it("persists state across calls in a session", async () => {
    const s = freshSession();
    await executeWrite(`state.x = 41;`, s, deps as never, FAST);
    const res = await executeWrite(`return state.x + 1;`, s, deps as never, FAST);
    expect(res.ok).toBe(true);
    expect(res.result).toBe(42);
    expect((s.state as Record<string, number>).x).toBe(41);
  });

  it("kills a synchronous infinite loop via the in-worker vm timeout", async () => {
    const t0 = Date.now();
    const res = await executeWrite(`while (true) {}`, freshSession(), deps as never, FAST);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe(ErrorCode.PLUGIN_TIMEOUT);
    expect(Date.now() - t0).toBeLessThan(FAST.timeoutMs + slack);
  }, 20_000);

  it("kills a synchronous loop resumed after await — the case the old in-process vm could not stop", async () => {
    const t0 = Date.now();
    const res = await executeWrite(
      `await figma.getNode("1:2"); while (true) {}`,
      freshSession(),
      deps as never,
      FAST,
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe(ErrorCode.PLUGIN_TIMEOUT);
    expect(res.error?.message).toContain("worker was terminated");
    // The worker's own vm timeout cannot fire once code resumes on the event
    // loop, so the parent deadline (timeoutMs + slack) is what lands this.
    expect(Date.now() - t0).toBeLessThan(FAST.timeoutMs + slack + 3000);
  }, 20_000);

  it("kills an awaited promise that never settles", async () => {
    const res = await executeWrite(
      `await new Promise(() => {});`,
      freshSession(),
      deps as never,
      FAST,
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe(ErrorCode.PLUGIN_TIMEOUT);
  }, 20_000);

  it("keeps the host responsive and reusable after terminating a wedged worker", async () => {
    const s = freshSession();
    const wedged = executeWrite(`while (true) {}`, s, deps as never, FAST);
    const healthy = await executeWrite(`return "still alive";`, freshSession(), deps as never, FAST);
    expect(healthy.ok).toBe(true);
    expect(healthy.result).toBe("still alive");
    const res = await wedged;
    expect(res.ok).toBe(false);
  }, 20_000);

  it("surfaces bridge-op errors as the op's error code, not a sandbox failure", async () => {
    const failing = {
      runOp: async () => ({
        ok: false,
        error: { code: ErrorCode.NODE_NOT_FOUND, message: "node missing", hint: "open the page first" },
      }),
    };
    const res = await executeWrite(
      `await figma.getNode("9:9");`,
      freshSession(),
      failing as never,
      FAST,
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe(ErrorCode.NODE_NOT_FOUND);
    expect(res.error?.hint).toBe("open the page first");
  });

  it("reports a syntax error without touching the vm", async () => {
    const res = await executeWrite(`return (((;`, freshSession(), deps as never, FAST);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe(ErrorCode.SANDBOX_ERROR);
    expect(res.error?.message).toContain("Syntax error");
  });
});
