import { describe, expect, it, vi } from "vitest";
import { runActivity } from "../../src/server/activity.js";
import { OpError } from "../../src/server/errors.js";

const process_ = {
  title: "Onboarding",
  lanes: [
    { id: "cand", label: "Candidate" },
    { id: "hr", label: "HR" },
    { id: "it", label: "IT" },
  ],
  nodes: [
    { id: "s", label: "Offer accepted", kind: "start" as const, lane: "cand" },
    { id: "docs", label: "Send documents", lane: "cand" },
    { id: "verify", label: "Verify documents", lane: "hr" },
    { id: "ok", label: "All present?", kind: "decision" as const, lane: "hr" },
    { id: "chase", label: "Chase missing docs", lane: "hr", cls: "error" as const },
    { id: "kit", label: "Issue laptop", lane: "it", cls: "happy" as const },
    { id: "done", label: "Day one ready", kind: "end" as const, lane: "it", cls: "happy" as const },
  ],
  edges: [
    { from: "s", to: "docs" },
    { from: "docs", to: "verify", label: "signed contract" },
    { from: "verify", to: "ok" },
    { from: "ok", to: "kit", label: "yes" },
    { from: "ok", to: "chase", label: "no" },
    { from: "kit", to: "done" },
    { from: "chase", to: "docs", label: "missing item", kind: "return" as const },
  ],
};

describe("runActivity", () => {
  it("sends laid-out draw data to the plugin, not the raw process", async () => {
    const call = vi.fn(async (_op: string, _params: Record<string, unknown>) => ({
      frameId: "7:1",
      nodes: { s: "7:2" },
      lanes: { hr: "7:3" },
    }));
    const res = await runActivity(process_, call);

    expect(call).toHaveBeenCalledTimes(1);
    const [op, params] = call.mock.calls[0]! as [string, Record<string, unknown>];
    expect(op).toBe("create_activity");
    expect(params).toMatchObject({ name: "Activity · Onboarding", title: "Onboarding" });
    expect((params as any).lanes).toHaveLength(3);
    expect((params as any).steps).toHaveLength(7);
    expect((params as any).nodes).toBeUndefined();
    expect(res.frameId).toBe("7:1");
    expect(res.stats).toMatchObject({ lanes: 3, nodes: 7, edges: 7, returnEdges: 1 });
    // Three arrows cross a lane boundary: docs→verify, ok→kit, chase→docs.
    expect(res.stats.handoffs).toBe(3);
  });

  it("keeps the plugin's warnings and its result when the dispatch layer wraps them", async () => {
    const call = vi.fn(async () => ({
      result: { frameId: "7:9" },
      warnings: ["the plugin said something"],
    }));
    const res = await runActivity(process_, call);
    expect(res.frameId).toBe("7:9");
    expect(res.warnings).toContain("the plugin said something");
  });

  it("checks the process without drawing on dryRun", async () => {
    const call = vi.fn(async () => ({}));
    const res = await runActivity({ ...process_, options: { dryRun: true } }, call);
    expect(call).not.toHaveBeenCalled();
    expect(res.dryRun).toBe(true);
    expect(res.stats.nodes).toBe(7);
  });

  it("reports the process findings alongside the drawing", async () => {
    const call = vi.fn(async () => ({ frameId: "7:1" }));
    const res = await runActivity(
      {
        title: "Sloppy",
        lanes: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
        nodes: [
          { id: "one", label: "One", lane: "a" },
          { id: "two", label: "Two", lane: "b" },
        ],
        edges: [{ from: "one", to: "two" }],
      },
      call,
    );
    const all = res.warnings.join(" ");
    expect(all).toContain("Unlabelled handoff");
    expect(all).toContain('No kind:"start"');
    expect(call).toHaveBeenCalledTimes(1); // findings do not stop the drawing
  });

  it("draws a step with no lane in a visible (no lane) band and says so", async () => {
    // Reported, not refused: a diagram with lanes and an unowned step is a
    // real finding, and seeing it on the page is how it gets fixed.
    const call = vi.fn(async (_op: string, _params: Record<string, unknown>) => ({ frameId: "7:1" }));
    const res = await runActivity(
      { title: "No owner", lanes: [{ id: "a", label: "A" }], nodes: [{ id: "one", label: "One" }] },
      call,
    );
    expect(res.warnings.join(" ")).toContain("No owning lane");
    expect(res.stats.lanes).toBe(2); // "a", plus the "(no lane)" band
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("derives the bands when the lane ids are only on the steps", async () => {
    const call = vi.fn(async (_op: string, _params: Record<string, unknown>) => ({ frameId: "7:1" }));
    const res = await runActivity(
      {
        title: "Implied lanes",
        nodes: [
          { id: "a", label: "A", kind: "start" as const, lane: "cust" },
          { id: "b", label: "B", kind: "end" as const, lane: "ops" },
        ],
        edges: [{ from: "a", to: "b", label: "order" }],
      },
      call,
    );
    expect(res.stats.lanes).toBe(2);
    expect(res.warnings.join(" ")).toContain("No lanes[] was given");
    const params = call.mock.calls[0]![1] as any;
    expect(params.lanes.map((l: any) => l.id)).toEqual(["cust", "ops"]);
  });

  it("draws a plain activity diagram when nothing mentions a lane", async () => {
    const call = vi.fn(async (_op: string, _params: Record<string, unknown>) => ({ frameId: "7:1" }));
    const res = await runActivity(
      {
        title: "No swimlanes",
        nodes: [
          { id: "a", label: "Request received", kind: "start" as const },
          { id: "b", label: "Check stock" },
          { id: "c", label: "Done", kind: "end" as const },
        ],
        edges: [
          { from: "a", to: "b" },
          { from: "b", to: "c" },
        ],
      },
      call,
    );
    expect(res.stats.lanes).toBe(0);
    expect(res.warnings).toEqual([]);
    const params = call.mock.calls[0]![1] as any;
    expect(params.lanes).toEqual([]);
    expect(params.steps).toHaveLength(3);
  });

  it("still refuses a process with no steps", async () => {
    await expect(
      runActivity({ title: "Nothing", lanes: [{ id: "a", label: "A" }], nodes: [] }, vi.fn()),
    ).rejects.toThrow(/Invalid activity spec/);
  });
});
