import { describe, expect, it, vi } from "vitest";
import { applyPatch } from "../../src/server/patch.js";
import { handleDiagram } from "../../src/server/tools.js";
import type { ToolContext } from "../../src/server/tools.js";
import { buildSequence } from "../../src/shared/sequence/index.js";

/**
 * Phase 6 of the round-trip diet: change a drawing without re-authoring it.
 *
 * The frame stores the model it was drawn from, so a finding becomes a patch
 * against that model. 73% of the JSON an agent emitted for the ticket-booking
 * set was spec it had already emitted — this is the half of that number the
 * compact `text` form could not reach, because re-sending a spec in a cheaper
 * notation is still re-sending it.
 */

const MODEL = {
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

describe("applyPatch", () => {
  it("sets a field on the member with that id, and leaves the rest alone", () => {
    const { spec, applied } = applyPatch(MODEL, [
      { collection: "messages", id: "m2", set: { label: "200 { ticketId }" } },
    ]);
    expect((spec.messages as any)[1]).toEqual({
      id: "m2",
      from: "b",
      to: "a",
      label: "200 { ticketId }",
      kind: "return",
    });
    expect((spec.messages as any)[0]).toEqual(MODEL.messages[0]);
    expect(applied).toEqual(["set label on messages m2"]);
  });

  it("never writes through to the stored model", () => {
    const before = JSON.stringify(MODEL);
    applyPatch(MODEL, [{ collection: "messages", id: "m1", set: { label: "changed" } }]);
    expect(JSON.stringify(MODEL)).toBe(before);
  });

  it("selects by field for the collections that have no ids", () => {
    // Activity edges, ERD relations, state transitions and usecase links are
    // all identified by their ends, not by an id — `where` is the only handle
    // they have, so it has to work as well as `id` does.
    const flow = {
      title: "T",
      nodes: [{ id: "draft" }, { id: "review" }],
      edges: [
        { from: "draft", to: "review" },
        { from: "review", to: "draft", kind: "return" },
      ],
    };
    const { spec } = applyPatch(flow, [
      { collection: "edges", where: { from: "draft", to: "review" }, set: { label: "the draft" } },
    ]);
    expect((spec.edges as any)[0]).toEqual({ from: "draft", to: "review", label: "the draft" });
    expect((spec.edges as any)[1]).toEqual(flow.edges[1]);
  });

  it("selects by position when that is all there is", () => {
    const { spec } = applyPatch(MODEL, [
      { collection: "messages", at: 0, set: { label: "POST /payments" } },
    ]);
    expect((spec.messages as any)[0].label).toBe("POST /payments");
  });

  it("adds at the end, or after the member you name", () => {
    const { spec } = applyPatch(MODEL, [
      { collection: "messages", add: { id: "m3", from: "a", to: "b", label: "GET /receipt" } },
      { collection: "messages", add: { id: "m0", from: "a", to: "b", label: "GET /seats" }, after: "m1" },
    ]);
    expect((spec.messages as any).map((m: any) => m.id)).toEqual(["m1", "m0", "m2", "m3"]);
  });

  it("removes by id", () => {
    const { spec, applied } = applyPatch(MODEL, [{ collection: "messages", remove: "m1" }]);
    expect((spec.messages as any).map((m: any) => m.id)).toEqual(["m2"]);
    expect(applied).toEqual(["removed m1 from messages"]);
  });

  it("removes an id-less member with a selector", () => {
    const flow = { title: "T", edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }] };
    const { spec } = applyPatch(flow, [
      { collection: "edges", remove: true, where: { from: "a", to: "b" } },
    ]);
    expect(spec.edges).toEqual([{ from: "b", to: "c" }]);
  });

  it("sets a field on the diagram itself when no collection is named", () => {
    const { spec, applied } = applyPatch(MODEL, [{ set: { title: "Hold and pay" } }]);
    expect(spec.title).toBe("Hold and pay");
    expect(spec.messages).toEqual(MODEL.messages);
    expect(applied).toEqual(["set title on the diagram"]);
  });

  it("applies the ops in order, so you can add a thing and then change it", () => {
    const { spec } = applyPatch(MODEL, [
      { collection: "messages", add: { id: "m3", from: "a", to: "b", label: "" } },
      { collection: "messages", id: "m3", set: { label: "GET /receipt" } },
    ]);
    expect((spec.messages as any)[2].label).toBe("GET /receipt");
  });
});

describe("applyPatch: what it refuses, and what it says", () => {
  const fails = (ops: unknown[], ...expected: string[]) => {
    try {
      applyPatch(MODEL, ops);
    } catch (e) {
      const text = `${(e as any).message} ${(e as any).hint ?? ""}`;
      for (const want of expected) expect(text).toContain(want);
      return;
    }
    throw new Error("expected the patch to be refused");
  };

  it("names the collections this diagram actually has", () => {
    // Guessing `nodes` on a sequence diagram is THE mistake here, and an agent
    // cannot fix it without being told what the alternatives are.
    fails([{ collection: "nodes", id: "m1", set: { label: "x" } }],
      "no `nodes` collection", "participants, messages");
  });

  it("lists the ids when the one given is not among them", () => {
    fails([{ collection: "messages", id: "m9", set: { label: "x" } }], "m9", "m1, m2");
  });

  it("says so when the collection has no ids at all", () => {
    const flow = { title: "T", edges: [{ from: "a", to: "b" }] };
    try {
      applyPatch(flow, [{ collection: "edges", id: "e1", set: { label: "x" } }]);
      throw new Error("expected the patch to be refused");
    } catch (e) {
      expect(`${(e as any).hint}`).toContain("have no ids");
      expect(`${(e as any).hint}`).toContain("where");
    }
  });

  it("refuses an ambiguous match instead of picking one", () => {
    const flow = { title: "T", edges: [{ from: "a", to: "b" }, { from: "a", to: "b" }] };
    try {
      applyPatch(flow, [{ collection: "edges", where: { from: "a" }, set: { label: "x" } }]);
      throw new Error("expected the patch to be refused");
    } catch (e) {
      expect((e as any).message).toContain("2 members");
      expect((e as any).hint).toContain("0, 1");
    }
  });

  it("refuses an op that says nothing to do, or two things at once", () => {
    fails([{ collection: "messages", id: "m1" }], "says nothing to do");
    fails([{ collection: "messages", id: "m1", set: { label: "x" }, remove: "m1" }], "at once");
  });

  it("refuses an op that does not say which member", () => {
    fails([{ collection: "messages", set: { label: "x" } }], "does not say WHICH");
    fails([{ collection: "messages", id: "m1", at: 0, set: { label: "x" } }], "2 ways");
  });

  it("refuses an index outside the collection", () => {
    fails([{ collection: "messages", at: 7, set: { label: "x" } }], "outside", "2 member");
  });

  it("refuses a patch against a frame that stored no model", () => {
    try {
      applyPatch(undefined, [{ collection: "messages", id: "m1", set: { label: "x" } }]);
      throw new Error("expected the patch to be refused");
    } catch (e) {
      expect((e as any).message).toContain("did not give back a model");
    }
  });
});

describe("the patched model still has to be a legal diagram", () => {
  it("is checked and laid out like any other spec", () => {
    // A patch is a cheaper way to SEND a spec, not a way to skip the checker:
    // blanking a label has to produce the same finding as sending it blank.
    const { spec } = applyPatch(MODEL, [{ collection: "messages", id: "m1", set: { label: "" } }]);
    const built = buildSequence(spec as any);
    expect(built.warnings.join(" ")).toContain("m1");
  });

  it("round-trips: the model a build stores is the model a patch changes", () => {
    const first = buildSequence(MODEL as any);
    const { spec } = applyPatch(first.model, [
      { collection: "messages", id: "m2", set: { label: "201 created" } },
    ]);
    const again = buildSequence(spec as any);
    expect(again.warnings).toEqual(first.warnings);
    expect(JSON.stringify(again.draw)).toContain("201 created");
    expect(JSON.stringify(again.draw)).not.toContain("200 paid");
  });
});

// ---- the tool surface ----

function ctxWith(stored: unknown): { ctx: ToolContext; calls: Array<[string, any]> } {
  const calls: Array<[string, any]> = [];
  const ctx = {
    runValidated: vi.fn(async (op: string, params: any) => {
      calls.push([op, params]);
      if (op === "get_diagram_spec") return stored;
      if (op === "layout_audit") return { nodeCount: 9, summary: { issues: [], styleHints: [] } };
      return { frameId: "140:5914", name: "Sequence · Pay" };
    }),
  } as unknown as ToolContext;
  return { ctx, calls };
}

describe("figma_diagram: update and patch", () => {
  it("reads the frame's model, patches it, and redraws into the same frame", async () => {
    const { ctx, calls } = ctxWith({ nodeId: "140:5914", kind: "sequence", spec: MODEL });
    const res = (await handleDiagram(ctx, undefined, {
      update: "140:5914",
      patch: [{ collection: "messages", id: "m2", set: { label: "201 created" } }],
    })) as Record<string, any>;

    expect(calls.map((c) => c[0])).toEqual(["get_diagram_spec", "create_sequence", "layout_audit"]);
    // The kind came off the frame: a patch does not have to repeat it.
    const draw = calls[1]![1];
    expect(draw.intoFrameId).toBe("140:5914");
    expect(JSON.stringify(draw.messages)).toContain("201 created");
    // And the drawing carries the patched model onward, so the NEXT change can
    // be a patch too rather than starting over.
    expect((draw.source as any).messages[1].label).toBe("201 created");
    expect(res.patched).toEqual(["set label on messages m2"]);
  });

  it("redraws a full spec into an existing frame, keeping its id", async () => {
    const { ctx, calls } = ctxWith(undefined);
    await handleDiagram(ctx, "sequence", { ...MODEL, update: "140:5914" });
    // No read: the spec came with the call, so there is nothing to look up.
    expect(calls.map((c) => c[0])).toEqual(["create_sequence", "layout_audit"]);
    expect(calls[0]![1].intoFrameId).toBe("140:5914");
  });

  it("refuses a patch that also carries model fields", async () => {
    const { ctx } = ctxWith({ kind: "sequence", spec: MODEL });
    await expect(
      handleDiagram(ctx, undefined, {
        update: "140:5914",
        patch: [{ collection: "messages", id: "m1", set: { label: "x" } }],
        messages: MODEL.messages,
      }),
    ).rejects.toThrow(/cannot also carry messages/);
  });

  it("refuses a patch with no frame to patch", async () => {
    const { ctx } = ctxWith(undefined);
    await expect(
      handleDiagram(ctx, "sequence", { patch: [{ collection: "messages", id: "m1", set: {} }] }),
    ).rejects.toThrow(/needs an `update`/);
  });

  it("still needs a type to redraw a frame it was not asked to patch", async () => {
    const { ctx } = ctxWith(undefined);
    await expect(handleDiagram(ctx, undefined, { update: "140:5914", title: "T" })).rejects.toThrow(
      /needs a `type`/,
    );
  });
});

describe("a batch can update as well as draw", () => {
  const STATE = { title: "Lifecycle", states: [{ id: "a" }, { id: "b" }], transitions: [{ from: "a", to: "b" }] };

  function batchCtx(stored: unknown): { ctx: ToolContext; calls: Array<[string, any]> } {
    const calls: Array<[string, any]> = [];
    const ctx = {
      runValidated: vi.fn(async (op: string, params: any) => {
        calls.push([op, params]);
        if (op === "get_diagram_spec") return stored;
        if (op === "layout_audit") return { nodeCount: 4, summary: { issues: [], styleHints: [] } };
        return { frameId: op === "create_state" ? "5:5" : "6:6", name: "F" };
      }),
    } as unknown as ToolContext;
    return { ctx, calls };
  }

  it("redraws the named frame in place, and draws the rest as usual", async () => {
    const { ctx, calls } = batchCtx(undefined);
    const res = (await handleDiagram(ctx, undefined, {
      diagrams: [
        { type: "state", update: "140:6031", ...STATE },
        { type: "sequence", ...MODEL },
      ],
      place: "column",
      x: 80,
      y: 80,
    })) as Record<string, any>;

    const draws = calls.filter((c) => c[0].startsWith("create_"));
    expect(draws[0]![1].intoFrameId).toBe("140:6031");
    expect(draws[1]![1].intoFrameId).toBeUndefined();
    // The redrawn frame keeps where the user put it, so it must not consume
    // the first slot — the newly drawn one belongs at the top of the column.
    expect(draws[1]![1].y).toBe(80);
    expect(res.diagrams).toHaveLength(2);
  });

  it("patches an entry against the model its frame holds", async () => {
    const { ctx, calls } = batchCtx({ nodeId: "140:5914", kind: "sequence", spec: MODEL });
    const res = (await handleDiagram(ctx, undefined, {
      diagrams: [{ update: "140:5914", patch: [{ collection: "messages", id: "m2", set: { label: "204" } }] }],
    })) as Record<string, any>;

    expect(calls[0]![0]).toBe("get_diagram_spec");
    const draw = calls.find((c) => c[0] === "create_sequence")![1];
    expect(draw.intoFrameId).toBe("140:5914");
    expect(JSON.stringify(draw.messages)).toContain("204");
    expect(res.diagrams[0].patched).toEqual(["set label on messages m2"]);
  });

  it("refuses a patched entry that has no frame to patch", async () => {
    const { ctx } = batchCtx(undefined);
    await expect(
      handleDiagram(ctx, undefined, {
        diagrams: [{ type: "sequence", patch: [{ collection: "messages", id: "m1", set: {} }] }],
      }),
    ).rejects.toThrow(/needs an `update`/);
  });
});

describe("a dotted key reaches inside", () => {
  const withOpts = {
    ...MODEL,
    options: { font: "Inter", policies: { "hold-minutes": 10, "retry-attempts": 3 } },
  };

  it("changes one rule without resending the rest of options", () => {
    const { spec } = applyPatch(withOpts, [{ set: { "options.policies.hold-minutes": 15 } }]);
    expect((spec.options as any)).toEqual({
      font: "Inter",
      policies: { "hold-minutes": 15, "retry-attempts": 3 },
    });
  });

  it("creates the levels that are missing", () => {
    const { spec } = applyPatch(MODEL, [{ set: { "options.policies.hold-minutes": 15 } }]);
    expect((spec.options as any).policies).toEqual({ "hold-minutes": 15 });
  });

  it("works on a member of a collection too", () => {
    const { spec } = applyPatch(MODEL, [
      { collection: "messages", id: "m1", set: { "note.text": "idempotent" } },
    ]);
    expect((spec.messages as any)[0].note).toEqual({ text: "idempotent" });
  });

  it("refuses to walk through something that is not an object", () => {
    expect(() => applyPatch(withOpts, [{ set: { "title.nope": 1 } }])).toThrow(/is a string, not an object/);
  });
});

describe("reaching into lists, and taking a field away", () => {
  const erd = {
    title: "Booking",
    entities: [
      { id: "bookings", name: "bookings", attributes: [
        { name: "id", type: "uuid", key: "pk" },
        { name: "status", type: "enum(held|paid)", required: true },
      ] },
    ],
  };

  it("changes one column without resending the table", () => {
    const { spec } = applyPatch(erd, [
      { collection: "entities", id: "bookings", set: { "attributes.1.type": "enum(held|paid|refunded)" } },
    ]);
    const attrs = (spec.entities as any)[0].attributes;
    expect(attrs[1]).toEqual({ name: "status", type: "enum(held|paid|refunded)", required: true });
    expect(attrs[0]).toEqual({ name: "id", type: "uuid", key: "pk" });
  });

  it("says so when the index is not there", () => {
    expect(() =>
      applyPatch(erd, [{ collection: "entities", id: "bookings", set: { "attributes.9.type": "x" } }]),
    ).toThrow(/no index 9/);
  });

  it("removes a field with null — the only way, since JSON has no undefined", () => {
    // A state that is `final` but has a way out is a real finding; dropping
    // `kind` is the fix, and it cannot be expressed as a value.
    const st = { title: "T", states: [{ id: "paid", kind: "final", label: "Paid" }] };
    const { spec } = applyPatch(st, [{ collection: "states", id: "paid", set: { kind: null } }]);
    expect((spec.states as any)[0]).toEqual({ id: "paid", label: "Paid" });
    expect("kind" in (spec.states as any)[0]).toBe(false);
  });

  it("removes a nested field too", () => {
    const s = { title: "T", options: { font: "Inter", policies: { a: 1, b: 2 } } };
    const { spec } = applyPatch(s, [{ set: { "options.policies.a": null } }]);
    expect((spec.options as any).policies).toEqual({ b: 2 });
  });
});
