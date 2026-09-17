import { describe, expect, it, vi } from "vitest";
import { handleDiagram } from "../../src/server/tools.js";
import type { ToolContext } from "../../src/server/tools.js";

/**
 * Phase A of the round-trip diet: one call checks, draws and verifies. The
 * agent used to spend three turns on that (dryRun → draw → layout_audit), and
 * three turns is three model generations — the actual cost, since the server
 * side of all three is single-digit to low-hundred milliseconds.
 */

const clean = {
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

// An unlabelled message is a semantic finding, reported before anything draws.
const dirty = {
  ...clean,
  messages: [...clean.messages, { id: "m3", from: "a", to: "b", label: "" }],
};

function ctxWith(audit: unknown): { ctx: ToolContext; calls: string[] } {
  const calls: string[] = [];
  const ctx = {
    runValidated: vi.fn(async (op: string) => {
      calls.push(op);
      if (op === "layout_audit") return audit;
      return { frameId: "9:1", name: "Sequence · Pay" };
    }),
  } as unknown as ToolContext;
  return { ctx, calls };
}

describe("handleDiagram: verify folded into the draw", () => {
  it("returns the render audit with the draw, as its own field", async () => {
    const { ctx, calls } = ctxWith({
      nodeCount: 12,
      summary: { issues: ["label (9:4) is clipped by 9:3."], styleHints: [] },
    });
    const res = (await handleDiagram(ctx, "sequence", clean)) as Record<string, any>;

    expect(calls).toEqual(["create_sequence", "layout_audit"]);
    expect(res.frameId).toBe("9:1");
    // Semantic findings and structural findings answer different questions.
    expect(res.warnings).toEqual([]);
    expect(res.audit).toMatchObject({ nodeCount: 12, issues: ["label (9:4) is clipped by 9:3."] });
  });

  it("says clean in one line rather than shipping an empty records array", async () => {
    const { ctx } = ctxWith({ nodeCount: 12, records: [], summary: { issues: [], styleHints: [] } });
    const res = (await handleDiagram(ctx, "sequence", clean)) as Record<string, any>;
    expect(res.audit).toEqual({ nodeCount: 12, clean: true });
  });

  it("keeps a drawn frame even when the verification itself fails", async () => {
    const ctx = {
      runValidated: vi.fn(async (op: string) => {
        if (op === "layout_audit") throw new Error("plugin went away");
        return { frameId: "9:1" };
      }),
    } as unknown as ToolContext;
    const res = (await handleDiagram(ctx, "sequence", clean)) as Record<string, any>;
    expect(res.frameId).toBe("9:1");
    expect(res.audit).toMatchObject({ skipped: "plugin went away" });
  });

  it("skips the audit on verify:false and on a dry run", async () => {
    const { ctx: c1, calls: k1 } = ctxWith({ nodeCount: 1, summary: {} });
    await handleDiagram(c1, "sequence", { ...clean, options: { verify: false } });
    expect(k1).toEqual(["create_sequence"]);

    const { ctx: c2, calls: k2 } = ctxWith({ nodeCount: 1, summary: {} });
    const dry = (await handleDiagram(c2, "sequence", { ...clean, options: { dryRun: true } })) as any;
    expect(k2).toEqual([]);
    expect(dry.dryRun).toBe(true);
  });
});

describe("handleDiagram: checkFirst", () => {
  it("draws nothing when the model has findings, and says why", async () => {
    const { ctx, calls } = ctxWith({ nodeCount: 1, summary: {} });
    const res = (await handleDiagram(ctx, "sequence", {
      ...dirty,
      options: { checkFirst: true },
    })) as Record<string, any>;

    expect(calls).toEqual([]);
    expect(res.checkedOnly).toBe(true);
    expect(res.frameId).toBeUndefined();
    expect(res.warnings.join(" ")).toContain("no label");
    expect(res.hint).toContain("checkFirst");
  });

  it("draws and verifies in the same call when the model is clean", async () => {
    const { ctx, calls } = ctxWith({ nodeCount: 12, summary: { issues: [], styleHints: [] } });
    const res = (await handleDiagram(ctx, "sequence", {
      ...clean,
      options: { checkFirst: true },
    })) as Record<string, any>;

    expect(calls).toEqual(["create_sequence", "layout_audit"]);
    expect(res.checkedOnly).toBeUndefined();
    expect(res.audit).toMatchObject({ clean: true });
  });
});

/**
 * Phase C: a set of diagrams in one call. The agent used to spend one turn per
 * diagram AND compute each frame's y from the previous result's box — which is
 * how two diagrams end up stacked on top of each other at 0,0.
 */
describe("handleDiagram: a batch", () => {
  const st = {
    type: "state",
    title: "Booking lifecycle",
    states: [
      { id: "b", kind: "initial" as const },
      { id: "held", label: "Seats held" },
      { id: "paid", label: "Paid", kind: "final" as const },
    ],
    transitions: [
      { from: "b", to: "held", event: "Reserve seats" },
      { from: "held", to: "paid", event: "Pay" },
    ],
  };
  const uc = {
    type: "sitemap",
    title: "Scope",
    pages: [
      { id: "home", label: "Home" },
      { id: "book", label: "Book seats", parent: "home" },
    ],
  };

  function batchCtx() {
    const drawn: Array<{ op: string; x: unknown; y: unknown }> = [];
    let n = 0;
    const ctx = {
      runValidated: vi.fn(async (op: string, params: Record<string, unknown>) => {
        if (op === "layout_audit") return { nodeCount: 5, summary: { issues: [], styleHints: [] } };
        drawn.push({ op, x: params.x, y: params.y });
        return { frameId: `9:${++n}`, name: String(params.name ?? "") };
      }),
    } as unknown as ToolContext;
    return { ctx, drawn };
  }

  it("stacks the frames itself, from the size it knows before drawing", async () => {
    const { ctx, drawn } = batchCtx();
    const res = (await handleDiagram(ctx, undefined, {
      diagrams: [st, uc],
      x: 80,
      y: 100,
      gap: 250,
    })) as Record<string, any>;

    expect(drawn.map((d) => d.op)).toEqual(["create_state", "create_sitemap"]);
    expect(drawn[0]).toMatchObject({ x: 80, y: 100 });
    // The second frame sits under the first, by its measured height + the gap.
    const firstH = res.diagrams[0].stats.h as number;
    expect(drawn[1]).toMatchObject({ x: 80, y: 100 + firstH + 250 });
    expect(res.diagrams).toHaveLength(2);
    expect(res.stats).toMatchObject({ diagrams: 2, place: "column", gap: 250 });
    // Each frame is verified in the same call.
    expect(res.diagrams[0].audit).toMatchObject({ clean: true });
  });

  it("honours an explicit x/y on an entry instead of placing it", async () => {
    const { ctx, drawn } = batchCtx();
    await handleDiagram(ctx, undefined, {
      diagrams: [{ ...st, x: 4000, y: 4000 }, uc],
      x: 0,
      y: 0,
    });
    expect(drawn[0]).toMatchObject({ x: 4000, y: 4000 });
  });

  it("proof-reads the whole set and draws none of it when checkFirst finds something", async () => {
    const { ctx, drawn } = batchCtx();
    const res = (await handleDiagram(ctx, undefined, {
      // A state machine with no way out of `held` is a finding.
      diagrams: [{ ...st, transitions: [{ from: "b", to: "held", event: "Reserve seats" }] }, uc],
      options: { checkFirst: true },
    })) as Record<string, any>;

    expect(drawn).toEqual([]);
    expect(res.checkedOnly).toBe(true);
    // Findings say WHICH diagram they came from.
    expect(res.warnings.join(" ")).toContain("[Booking lifecycle]");
  });

  it("says what landed when one entry fails mid-set", async () => {
    let n = 0;
    const ctx = {
      runValidated: vi.fn(async (op: string) => {
        if (op === "layout_audit") return { nodeCount: 1, summary: {} };
        if (op === "create_sitemap") throw new Error("plugin said no");
        return { frameId: `9:${++n}` };
      }),
    } as unknown as ToolContext;
    const res = (await handleDiagram(ctx, undefined, { diagrams: [st, uc] })) as Record<string, any>;
    expect(res.diagrams).toHaveLength(1);
    expect(res.failedAt).toMatchObject({ index: 1, title: "Scope" });
    expect(res.hint).toContain("were drawn");
  });

  it("asks for a type, or a batch, rather than guessing", async () => {
    const { ctx } = batchCtx();
    await expect(handleDiagram(ctx, undefined, { title: "x" })).rejects.toThrow(/needs a `type`/);
    await expect(handleDiagram(ctx, undefined, { diagrams: [] })).rejects.toThrow(/nothing to draw/);
    await expect(handleDiagram(ctx, undefined, { diagrams: "erd" })).rejects.toThrow(/must be an array/);
  });
});
