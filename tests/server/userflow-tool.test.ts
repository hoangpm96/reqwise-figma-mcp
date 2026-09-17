import { describe, expect, it, vi } from "vitest";
import { runUserflow } from "../../src/server/userflow.js";
import { OpError } from "../../src/server/errors.js";

const graph = {
  title: "Checkout",
  nodes: [
    { id: "cart", label: "Cart", screenId: "1.1" },
    { id: "pay", label: "Paid?", kind: "decision" as const },
    { id: "ok", label: "Done", kind: "terminal" as const },
    { id: "no", label: "Declined", cls: "error" as const, kind: "terminal" as const },
  ],
  edges: [
    { from: "cart", to: "pay" },
    { from: "pay", to: "ok", label: "yes" },
    { from: "pay", to: "no", label: "no" },
  ],
};

describe("runUserflow", () => {
  it("sends laid-out draw data to the plugin, not the raw graph", async () => {
    const call = vi.fn(
      async (_op: string, _params: Record<string, unknown>) => ({
        frameId: "5:1",
        nodes: { cart: "5:2" },
      }),
    );
    const res = await runUserflow(graph, call);

    expect(call).toHaveBeenCalledTimes(1);
    const [op, params] = call.mock.calls[0]! as [string, Record<string, unknown>];
    expect(op).toBe("create_userflow");
    expect(params).toMatchObject({ name: "Userflow · Checkout", title: "Checkout" });
    expect((params as any).boxes.length).toBe(3);
    expect((params as any).edges.length).toBe(3);
    expect((params as any).nodes).toBeUndefined();
    expect(res.frameId).toBe("5:1");
    expect(res.stats.nodes).toBe(4);
  });

  it("keeps the plugin's warnings and its result when the dispatch layer wraps them", async () => {
    // The bridge returns { result, warnings } instead of the bare result the
    // moment the plugin warns — spreading that shape buried frameId and threw
    // the warnings away, which hid a failing linkScreens pass in a live run.
    const call = vi.fn(async (_op: string, _params: Record<string, unknown>) => ({
      result: { frameId: "5:1", nodes: { cart: "5:2" }, linkedScreens: {} },
      warnings: ["linkScreens found no artboard for \"1.1\""],
    }));
    const sink: string[] = [];
    const res = await runUserflow(graph, call, sink);
    expect(res.frameId).toBe("5:1");
    expect((res as unknown as Record<string, unknown>).result).toBeUndefined();
    expect(res.warnings).toContain('linkScreens found no artboard for "1.1"');
    expect(sink).toContain('linkScreens found no artboard for "1.1"');
  });

  it("dryRun checks the graph and draws nothing", async () => {
    const call = vi.fn(async (_op: string, _params: Record<string, unknown>) => ({}));
    const res = await runUserflow(
      { ...graph, nodes: [...graph.nodes, { id: "loose", label: "Loose end" }], options: { dryRun: true } },
      call,
    );
    expect(call).not.toHaveBeenCalled();
    expect(res.dryRun).toBe(true);
    expect(res.warnings.join(" ")).toContain("Dead end");
  });

  it("pushes findings into the sandbox warning sink without duplicating them", async () => {
    const call = vi.fn(async (_op: string, _params: Record<string, unknown>) => ({}));
    const sink: string[] = [];
    await runUserflow({ ...graph, nodes: [...graph.nodes, { id: "loose", label: "Loose" }] }, call, sink);
    await runUserflow({ ...graph, nodes: [...graph.nodes, { id: "loose", label: "Loose" }] }, call, sink);
    expect(sink.filter((w) => w.startsWith("Dead end"))).toHaveLength(1);
  });

  it("refuses a spec with no graph, and says whose job the graph is", async () => {
    const call = vi.fn(async (_op: string, _params: Record<string, unknown>) => ({}));
    await expect(runUserflow({ title: "Empty" }, call)).rejects.toBeInstanceOf(OpError);
    await expect(runUserflow({ title: "Empty" }, call)).rejects.toThrow(/YOUR analysis/i);
    expect(call).not.toHaveBeenCalled();
  });

  it("refuses an edge that is not a pair of ids", async () => {
    const call = vi.fn(async (_op: string, _params: Record<string, unknown>) => ({}));
    await expect(
      runUserflow({ title: "T", nodes: graph.nodes, edges: [{ from: "cart" }] }, call),
    ).rejects.toBeInstanceOf(OpError);
  });
});
