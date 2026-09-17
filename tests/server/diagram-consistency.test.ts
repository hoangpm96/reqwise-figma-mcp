import { describe, expect, it, vi } from "vitest";
import { handleDiagram } from "../../src/server/tools.js";
import type { ToolContext } from "../../src/server/tools.js";

/**
 * #8: the drawing is compared against the diagrams already on its page.
 *
 * The cost discipline matters as much as the finding. The plugin hands the
 * page's models back WITH the draw result, so this asks its question without
 * adding a round trip — a separate read would have cost one per diagram, and
 * five per batch, undoing the work that got a draw down to one call.
 */

const SEQ = {
  title: "Pay",
  participants: [{ id: "user", name: "User" }, { id: "api", name: "API" }],
  messages: [{ id: "m1", from: "user", to: "api", label: "POST /pay" }],
};

/** A neighbour already on the page, as the plugin reports it. */
const NEIGHBOUR = {
  nodeId: "7:7",
  kind: "activity",
  title: "Activity · Booking",
  spec: { title: "T", lanes: [{ id: "user", label: "Khách hàng" }] },
};

function ctxWith(pageModel: unknown[]): { ctx: ToolContext; ops: string[] } {
  const ops: string[] = [];
  const ctx = {
    runValidated: vi.fn(async (op: string) => {
      ops.push(op);
      if (op === "layout_audit") return { nodeCount: 9, summary: { issues: [], styleHints: [] } };
      return { frameId: "9:1", name: "Sequence · Pay", pageModel };
    }),
  } as unknown as ToolContext;
  return { ctx, ops };
}

describe("consistency with the rest of the page", () => {
  it("reports a role that two diagrams name differently", async () => {
    const self = {
      nodeId: "9:1", kind: "sequence", title: "Sequence · Pay",
      spec: SEQ,
    };
    const { ctx, ops } = ctxWith([self, NEIGHBOUR]);
    const res = (await handleDiagram(ctx, "sequence", SEQ)) as Record<string, any>;

    expect(res.consistency).toHaveLength(1);
    expect(res.consistency[0].rule).toBe("name-drift");
    expect(res.consistency[0].message).toContain("Khách hàng");
    expect(res.consistency[0].frames).toEqual(["9:1", "7:7"]);
    // The point: no third op. Same two calls a plain draw makes.
    expect(ops).toEqual(["create_sequence", "layout_audit"]);
  });

  it("says nothing when the page agrees with itself", async () => {
    const agreeing = { ...NEIGHBOUR, spec: { title: "T", actors: [{ id: "user", name: "User" }] } };
    const self = { nodeId: "9:1", kind: "sequence", title: "S", spec: SEQ };
    const { ctx } = ctxWith([self, agreeing]);
    const res = (await handleDiagram(ctx, "sequence", SEQ)) as Record<string, any>;
    expect(res.consistency).toBeUndefined();
  });

  it("says nothing about the first diagram on a page", async () => {
    // Nothing to disagree WITH — an empty field on every first draw would be
    // noise the caller has to read past.
    const { ctx } = ctxWith([{ nodeId: "9:1", kind: "sequence", title: "S", spec: SEQ }]);
    const res = (await handleDiagram(ctx, "sequence", SEQ)) as Record<string, any>;
    expect(res.consistency).toBeUndefined();
  });

  it("can be turned off", async () => {
    const self = { nodeId: "9:1", kind: "sequence", title: "S", spec: SEQ };
    const { ctx } = ctxWith([self, NEIGHBOUR]);
    const res = (await handleDiagram(ctx, "sequence", {
      ...SEQ,
      options: { crossCheck: false },
    })) as Record<string, any>;
    expect(res.consistency).toBeUndefined();
  });

  it("never leaks the page models it was handed", async () => {
    // They are internal plumbing — several KB of other diagrams' specs that
    // the caller did not ask for and must not be charged for.
    const self = { nodeId: "9:1", kind: "sequence", title: "S", spec: SEQ };
    const { ctx } = ctxWith([self, NEIGHBOUR]);
    const res = (await handleDiagram(ctx, "sequence", SEQ)) as Record<string, any>;
    expect(res.pageModel).toBeUndefined();
    expect(JSON.stringify(res)).not.toContain("Activity · Booking");
  });

  it("survives a page whose neighbours predate the stored model", async () => {
    const stale = { nodeId: "7:7", kind: "erd", title: "Old", stale: true };
    const self = { nodeId: "9:1", kind: "sequence", title: "S", spec: SEQ };
    const { ctx } = ctxWith([self, stale]);
    const res = (await handleDiagram(ctx, "sequence", SEQ)) as Record<string, any>;
    expect(res.frameId).toBe("9:1");
    expect(res.consistency).toBeUndefined();
  });
});

describe("a batch reports the page as it ends up", () => {
  /**
   * The set's findings are the LAST entry's, empty included. Keeping the last
   * non-empty result meant a batch that fixed the final disagreement still
   * reported it — the clean answer was thrown away for a stale one, which is
   * precisely when a user is most likely to stop believing the feature.
   */
  const seqSpec = {
    title: "S",
    participants: [{ id: "user", name: "Khách hàng" }],
    messages: [{ id: "m1", from: "user", to: "user", label: "x" }],
  };

  function batchCtx(pageModels: unknown[][]): ToolContext {
    let draw = 0;
    return {
      runValidated: vi.fn(async (op: string) => {
        if (op === "layout_audit") return { nodeCount: 3, summary: { issues: [], styleHints: [] } };
        if (op.startsWith("create_")) {
          return { frameId: `9:${draw + 1}`, name: "F", pageModel: pageModels[draw++] };
        }
        return {};
      }),
    } as unknown as ToolContext;
  }

  it("says nothing when the last diagram drawn leaves the page agreeing", async () => {
    const drifting = [
      { nodeId: "9:1", kind: "sequence", title: "S", spec: seqSpec },
      { nodeId: "7:7", kind: "activity", title: "U", spec: { title: "U", lanes: [{ id: "user", label: "User" }] } },
    ];
    const agreeing = [
      { nodeId: "9:1", kind: "sequence", title: "S", spec: seqSpec },
      { nodeId: "7:7", kind: "activity", title: "U", spec: { title: "U", lanes: [{ id: "user", label: "Khách hàng" }] } },
    ];
    // First entry still sees the drift; the second is the one that fixes it.
    const ctx = batchCtx([drifting, agreeing]);
    const res = (await handleDiagram(ctx, undefined, {
      diagrams: [
        { type: "sequence", ...seqSpec },
        { type: "sequence", ...seqSpec },
      ],
    })) as Record<string, any>;
    expect(res.consistency).toBeUndefined();
  });

  it("still reports a disagreement the set leaves behind", async () => {
    const drifting = [
      { nodeId: "9:1", kind: "sequence", title: "S", spec: seqSpec },
      { nodeId: "7:7", kind: "activity", title: "U", spec: { title: "U", lanes: [{ id: "user", label: "User" }] } },
    ];
    const ctx = batchCtx([drifting, drifting]);
    const res = (await handleDiagram(ctx, undefined, {
      diagrams: [
        { type: "sequence", ...seqSpec },
        { type: "sequence", ...seqSpec },
      ],
    })) as Record<string, any>;
    expect(res.consistency.map((c: any) => c.rule)).toEqual(["name-drift"]);
  });
});
