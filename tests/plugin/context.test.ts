import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * getNodeByIdSafe: the dynamic-page lazy fallback. A lookup that is still
 * pending after LOOKUP_SETTLE_MS is assumed to reach into an unloaded page —
 * loadAllPagesAsync runs once (shared by concurrent stalls), then the lookup
 * retries.
 *
 * Each test resets the module so the module-level allPagesLoaded promise does
 * not leak state between tests.
 */

const SETTLE_MS = 2500;

async function freshModule() {
  vi.resetModules();
  return await import("../../src/plugin/context.js");
}

/** A lookup whose promise only settles when `release` is called. */
function stalledLookup() {
  let release!: (v: unknown) => void;
  const p = new Promise((r) => {
    release = r;
  });
  return { p, release };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("getNodeByIdSafe", () => {
  it("returns immediately for a fast lookup — loadAllPagesAsync never runs", async () => {
    const node = { id: "1:2", type: "FRAME" };
    const loadAll = vi.fn(async () => {});
    (globalThis as any).figma = {
      getNodeByIdAsync: vi.fn(async () => node),
      loadAllPagesAsync: loadAll,
    };
    const { getNodeByIdSafe } = await freshModule();
    const res = await getNodeByIdSafe("1:2");
    expect(res).toBe(node);
    expect(loadAll).not.toHaveBeenCalled();
  });

  it("stalled lookup triggers loadAllPagesAsync once, then retries", async () => {
    const node = { id: "9:9", type: "RECTANGLE" };
    const stall = stalledLookup();
    let calls = 0;
    const loadAll = vi.fn(async () => {});
    (globalThis as any).figma = {
      getNodeByIdAsync: vi.fn(() => {
        calls++;
        return calls === 1 ? stall.p : Promise.resolve(node);
      }),
      loadAllPagesAsync: loadAll,
    };
    vi.useFakeTimers();
    const { getNodeByIdSafe } = await freshModule();

    const pending = getNodeByIdSafe("9:9");
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 10);
    const res = await pending;
    expect(res).toBe(node);
    expect(loadAll).toHaveBeenCalledTimes(1);
    expect((globalThis as any).figma.getNodeByIdAsync).toHaveBeenCalledTimes(2);
  });

  it("concurrent stalled lookups share a single loadAllPagesAsync", async () => {
    const loadAll = vi.fn(async () => {});
    (globalThis as any).figma = {
      getNodeByIdAsync: vi.fn(() => stalledLookup().p),
      loadAllPagesAsync: loadAll,
    };
    vi.useFakeTimers();
    const { getNodeByIdSafe } = await freshModule();

    const a = getNodeByIdSafe("a:1").catch(() => "a-failed");
    const b = getNodeByIdSafe("b:2").catch(() => "b-failed");
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 10);
    // Let the retries fire; the retried lookups stall too (still pending), so
    // these promises never settle — that is fine, we only assert the load count.
    await vi.advanceTimersByTimeAsync(0);
    expect(loadAll).toHaveBeenCalledTimes(1);
    void a;
    void b;
  });

  it("a failed page load is forgotten — the next stall retries the load", async () => {
    let failOnce = true;
    const loadAll = vi.fn(async () => {
      if (failOnce) {
        failOnce = false;
        throw new Error("load failed");
      }
    });
    (globalThis as any).figma = {
      getNodeByIdAsync: vi.fn(() => stalledLookup().p),
      loadAllPagesAsync: loadAll,
    };
    vi.useFakeTimers();
    const { getNodeByIdSafe } = await freshModule();

    const first = getNodeByIdSafe("a:1");
    const firstAssert = expect(first).rejects.toThrow("load failed");
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 10);
    await firstAssert;

    const second = getNodeByIdSafe("b:2").catch((e) => e);
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 10);
    await vi.advanceTimersByTimeAsync(0);
    expect(loadAll).toHaveBeenCalledTimes(2);
    void second;
  });

  it("a lookup that rejects after losing the race does not produce an unhandled rejection", async () => {
    const stall = stalledLookup();
    let calls = 0;
    (globalThis as any).figma = {
      getNodeByIdAsync: vi.fn(() => {
        calls++;
        return calls === 1 ? stall.p : Promise.resolve({ id: "x", type: "FRAME" });
      }),
      loadAllPagesAsync: vi.fn(async () => {}),
    };
    vi.useFakeTimers();
    const { getNodeByIdSafe } = await freshModule();

    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const pending = getNodeByIdSafe("x:1");
      await vi.advanceTimersByTimeAsync(SETTLE_MS + 10);
      stall.release(Promise.reject(new Error("late rejection")));
      await vi.advanceTimersByTimeAsync(10);
      await pending;
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("works when loadAllPagesAsync does not exist (older Figma / minimal mocks)", async () => {
    const stall = stalledLookup();
    let calls = 0;
    const node = { id: "7:7", type: "FRAME" };
    (globalThis as any).figma = {
      getNodeByIdAsync: vi.fn(() => {
        calls++;
        return calls === 1 ? stall.p : Promise.resolve(node);
      }),
      // no loadAllPagesAsync
    };
    vi.useFakeTimers();
    const { getNodeByIdSafe } = await freshModule();

    const pending = getNodeByIdSafe("7:7");
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 10);
    expect(await pending).toBe(node);
  });
});
