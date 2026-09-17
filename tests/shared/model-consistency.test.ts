import { describe, expect, it } from "vitest";
import { checkConsistency } from "../../src/shared/model/check.js";
import { collectFacts, enumValues, indexPage } from "../../src/shared/model/facts.js";
import type { StoredDiagram } from "../../src/shared/model/facts.js";

/**
 * The check no single-diagram checker can do: are the diagrams on this page
 * telling the same story? Every fact here comes out of what the frames already
 * store, so none of it has to be written down twice by hand.
 */

const erd = (attrType: string): StoredDiagram => ({
  nodeId: "1:1",
  kind: "erd",
  title: "ERD · Booking",
  spec: {
    title: "ERD · Booking",
    entities: [
      {
        id: "bookings",
        name: "bookings",
        attributes: [
          { name: "id", type: "uuid", key: "pk" },
          { name: "status", type: attrType, required: true },
        ],
      },
    ],
  },
});

const state = (ids: string[], title = "Booking lifecycle"): StoredDiagram => ({
  nodeId: "2:2",
  kind: "state",
  title,
  spec: {
    title,
    states: [
      { id: "start", kind: "initial" },
      ...ids.map((id) => ({ id })),
    ],
  },
});

describe("lifecycle drift", () => {
  it("says nothing when the column and the machine agree", () => {
    const f = checkConsistency([erd("enum(held|paid|cancelled)"), state(["held", "paid", "cancelled"])]);
    expect(f).toEqual([]);
  });

  it("catches a state the database cannot store", () => {
    const f = checkConsistency([erd("enum(held|paid)"), state(["held", "paid", "refunded"])]);
    expect(f).toHaveLength(1);
    expect(f[0]!.rule).toBe("lifecycle-drift");
    expect(f[0]!.message).toContain("`refunded`");
    expect(f[0]!.message).toContain("cannot store");
    expect(f[0]!.frames).toEqual(["2:2", "1:1"]);
  });

  it("catches a status the lifecycle can never reach", () => {
    const f = checkConsistency([erd("enum(held|paid|cancelled)"), state(["held", "paid"])]);
    expect(f[0]!.message).toContain("`cancelled`");
    expect(f[0]!.message).toContain("nothing in the lifecycle reaches");
  });

  it("matches a singular machine to a plural table", () => {
    // "Booking lifecycle" IS the machine for `bookings`; requiring an exact
    // name would make the rule fire on nobody.
    const f = checkConsistency([erd("enum(held)"), state(["paid"], "Booking lifecycle")]);
    expect(f).toHaveLength(1);
  });

  it("does not drag unrelated diagrams together", () => {
    const f = checkConsistency([erd("enum(held)"), state(["draft"], "Invoice approval")]);
    expect(f).toEqual([]);
  });

  it("ignores pseudo-states — they are notation, not stored values", () => {
    const withPseudo: StoredDiagram = {
      nodeId: "2:2",
      kind: "state",
      title: "Booking lifecycle",
      spec: {
        title: "Booking lifecycle",
        states: [
          { id: "start", kind: "initial" },
          { id: "pick", kind: "choice" },
          { id: "held" },
          { id: "paid", kind: "final" },
        ],
      },
    };
    // `final` IS a value the row ends up holding, so it must be compared;
    // `initial` and `choice` must not.
    expect(checkConsistency([erd("enum(held|paid)"), withPseudo])).toEqual([]);
  });

  it("stays quiet when the column is not an enum", () => {
    expect(checkConsistency([erd("text"), state(["held", "paid"])])).toEqual([]);
  });

  it("stays quiet when only one of the two exists", () => {
    expect(checkConsistency([erd("enum(held|paid)")])).toEqual([]);
    expect(checkConsistency([state(["held"])])).toEqual([]);
  });
});



describe("the same role under different names", () => {
  const seq: StoredDiagram = {
    nodeId: "3:3", kind: "sequence", title: "Sequence · Pay",
    spec: { title: "T", participants: [{ id: "user", name: "User" }, { id: "api", name: "API" }] },
  };
  const uc = (name: string, id = "user"): StoredDiagram => ({
    nodeId: "4:4", kind: "activity", title: "Activity · Booking",
    spec: { title: "T", lanes: [{ id, label: name }] },
  });

  it("says nothing when the names agree", () => {
    expect(checkConsistency([seq, uc("User")])).toEqual([]);
  });

  it("catches one id wearing two names", () => {
    const f = checkConsistency([seq, uc("Khách hàng")]);
    expect(f).toHaveLength(1);
    expect(f[0]!.rule).toBe("name-drift");
    expect(f[0]!.message).toContain("`user`");
    expect(f[0]!.message).toContain("User");
    expect(f[0]!.message).toContain("Khách hàng");
    expect(f[0]!.message).toContain("sequence participant / activity lane");
  });

  it("catches one name wearing two ids — the quiet one", () => {
    // Both diagrams look right. Nothing downstream can tell these are the same
    // person, so traceability between the views is already broken.
    const f = checkConsistency([seq, uc("User", "customer")]);
    expect(f).toHaveLength(1);
    expect(f[0]!.rule).toBe("id-drift");
    expect(f[0]!.message).toContain("`user`");
    expect(f[0]!.message).toContain("`customer`");
  });

  it("ignores case and spacing, which are not the disagreement", () => {
    expect(checkConsistency([seq, uc("  user  ")])).toEqual([]);
  });

  it("reads lanes as roles too, so an activity joins the comparison", () => {
    const act: StoredDiagram = {
      nodeId: "5:5", kind: "activity", title: "Activity · Booking",
      spec: { title: "T", lanes: [{ id: "user", label: "Customer" }] },
    };
    const f = checkConsistency([seq, act]);
    expect(f[0]!.message).toContain("activity lane");
  });
});

describe("reading the facts out", () => {
  it("takes enum values with either separator", () => {
    expect(enumValues("enum(a|b|c)")).toEqual(["a", "b", "c"]);
    expect(enumValues("enum(a, b)")).toEqual(["a", "b"]);
    expect(enumValues("varchar(255)")).toEqual([]);
    expect(enumValues("uuid")).toEqual([]);
  });

  it("survives a frame whose stored model is missing or malformed", () => {
    const junk: StoredDiagram[] = [
      { nodeId: "9:1", kind: "erd", spec: undefined },
      { nodeId: "9:2", kind: "state", spec: "not an object" },
      { nodeId: "9:3", kind: "sequence", spec: { participants: "nope" } },
      { nodeId: "9:4", kind: "whatever", spec: {} },
    ];
    expect(() => checkConsistency(junk)).not.toThrow();
    expect(collectFacts(junk)).toEqual({ roles: [], enums: [], lifecycles: [], policies: [], screens: [], who: [] });
  });
});

describe("one rule, one number", () => {
  const withPolicy = (nodeId: string, frame: string, value: unknown): StoredDiagram => ({
    nodeId,
    kind: "sequence",
    title: frame,
    spec: {
      title: frame,
      participants: [{ id: "a", name: "A" }],
      messages: [{ id: "m1", from: "a", to: "a", label: "retry up to @retry-attempts times" }],
      options: { policies: { "retry-attempts": value } },
    },
  });

  it("says nothing when both diagrams quote the same value", () => {
    expect(checkConsistency([withPolicy("1:1", "Sequence", 3), withPolicy("2:2", "State", 3)])).toEqual([]);
  });

  it("catches two diagrams declaring one rule differently", () => {
    const f = checkConsistency([withPolicy("1:1", "Sequence", 3), withPolicy("2:2", "State", 5)]);
    expect(f).toHaveLength(1);
    expect(f[0]!.rule).toBe("policy-drift");
    expect(f[0]!.message).toContain("@retry-attempts");
    expect(f[0]!.message).toContain('"Sequence" says 3');
    expect(f[0]!.message).toContain('"State" says 5');
    expect(f[0]!.frames).toEqual(["1:1", "2:2"]);
  });

  it("treats the name case-insensitively, and 3 as 3 however it was typed", () => {
    const a = withPolicy("1:1", "A", 3);
    const b = withPolicy("2:2", "B", "3");
    (b.spec as any).options.policies = { "Retry-Attempts": "3" };
    expect(checkConsistency([a, b])).toEqual([]);
  });
});

describe("what the page knows, and which frames know it", () => {
  const seq: StoredDiagram = {
    nodeId: "1:1", kind: "sequence", title: "Sequence · Pay",
    spec: {
      title: "T",
      participants: [{ id: "user", name: "User" }],
      messages: [{ id: "m1", from: "user", to: "user", label: "retry @retry-attempts times" }],
      options: { policies: { "retry-attempts": 3, "hold-minutes": 10 } },
    },
  };
  const st: StoredDiagram = {
    nodeId: "2:2", kind: "state", title: "Booking lifecycle",
    spec: {
      title: "Booking lifecycle",
      states: [{ id: "held" }, { id: "paid" }],
      transitions: [{ from: "held", to: "paid", guard: "n < @retry-attempts" }],
      options: { policies: { "retry-attempts": 3 } },
    },
  };
  const erdF: StoredDiagram = {
    nodeId: "3:3", kind: "erd", title: "ERD · Booking",
    spec: { title: "T", entities: [{ id: "bookings", name: "bookings", attributes: [{ name: "status", type: "enum(held|paid)" }] }] },
  };

  it("answers which frames a rule change touches", () => {
    const ix = indexPage([seq, st, erdF]);
    const retry = ix.policies.find((p) => p.name === "retry-attempts")!;
    expect(retry.values).toHaveLength(1);
    expect(retry.values[0]!.value).toBe(3);
    // This IS the answer to "we are moving to 5 attempts — what has to change?"
    expect(retry.values[0]!.frames).toEqual(["1:1", "2:2"]);
  });

  it("flags a rule declared on a frame that never references it", () => {
    // Dead weight, or a label that was supposed to use it and does not.
    const ix = indexPage([seq, st]);
    expect(ix.policies.find((p) => p.name === "hold-minutes")!.unused).toEqual(["1:1"]);
    expect(ix.policies.find((p) => p.name === "retry-attempts")!.unused).toEqual([]);
  });

  it("splits the frames by value when the page disagrees", () => {
    const other = { ...st, spec: { ...(st.spec as any), options: { policies: { "retry-attempts": 5 } } } };
    const retry = indexPage([seq, other]).policies.find((p) => p.name === "retry-attempts")!;
    expect(retry.values.map((v) => [v.value, v.frames])).toEqual([[3, ["1:1"]], [5, ["2:2"]]]);
  });

  it("lists where each role and each entity is drawn", () => {
    const ix = indexPage([seq, st, erdF]);
    expect(ix.roles).toEqual([{ id: "user", names: ["User"], frames: ["1:1"] }]);
    expect(ix.entities.find((e) => e.name === "bookings")!.frames).toEqual(["3:3"]);
    expect(ix.entities.find((e) => e.name === "Booking lifecycle")!.frames).toEqual(["2:2"]);
  });
});

describe("diagrams that live on different pages", () => {
  /**
   * The scenario this exists for: one chat draws the ERD, a later chat with no
   * memory of it draws the state machine on another page. Nothing in either
   * session can see the other, so the file has to be what remembers.
   */
  const onPage = (page: string, nodeId: string, spec: unknown, kind: string, title: string): StoredDiagram => ({
    nodeId, kind, title, page, spec,
  });

  const erdP1 = onPage("Data", "1:1", {
    title: "ERD",
    entities: [{ id: "bookings", name: "bookings", attributes: [{ name: "status", type: "enum(held|paid)" }] }],
  }, "erd", "ERD · Booking");

  const stateP2 = onPage("Lifecycles", "2:2", {
    title: "Booking lifecycle",
    states: [{ id: "held" }, { id: "refunded" }],
  }, "state", "Booking lifecycle");

  it("compares across pages, and says which page each frame is on", () => {
    const f = checkConsistency([erdP1, stateP2]);
    expect(f).toHaveLength(1);
    expect(f[0]!.rule).toBe("lifecycle-drift");
    expect(f[0]!.message).toContain("Lifecycles › Booking lifecycle");
    expect(f[0]!.message).toContain("Data › ERD · Booking");
    expect(f[0]!.frames).toEqual(["2:2", "1:1"]);
  });

  it("does not prefix the page when they all share one", () => {
    const same = { ...stateP2, page: "Data" };
    const f = checkConsistency([erdP1, same]);
    expect(f[0]!.message).toContain('"Booking lifecycle"');
    expect(f[0]!.message).not.toContain("›");
  });

  it("does not prefix when the read never reported a page at all", () => {
    const f = checkConsistency([{ ...erdP1, page: undefined }, { ...stateP2, page: undefined }]);
    expect(f[0]!.message).not.toContain("›");
  });

  it("traces a rule to the frames holding it, wherever they live", () => {
    const a = onPage("Flows", "3:3", {
      title: "A", nodes: [{ id: "n", label: "hold @hold-minutes" }], edges: [],
      options: { policies: { "hold-minutes": 10 } },
    }, "activity", "Activity");
    const b = onPage("Lifecycles", "4:4", {
      title: "B", states: [{ id: "s", label: "@hold-minutes" }],
      options: { policies: { "hold-minutes": 15 } },
    }, "state", "State");
    const ix = indexPage([a, b]);
    const p = ix.policies.find((x) => x.name === "hold-minutes")!;
    expect(p.values.map((v) => [v.value, v.frames])).toEqual([[10, ["3:3"]], [15, ["4:4"]]]);
    expect(checkConsistency([a, b])[0]!.message).toContain("Flows › Activity");
  });
});

describe("more than one lifecycle for the same entity", () => {
  /**
   * A page routinely carries the machine that exists and a redraft of it.
   * Comparing only the first one found meant the DRAFT — the one being worked
   * on, and so the one most likely to be wrong — was never checked at all.
   */
  const erdTwo: StoredDiagram = {
    nodeId: "1:1", kind: "erd", title: "ERD",
    spec: { title: "ERD", entities: [{ id: "bookings", name: "bookings", attributes: [{ name: "status", type: "enum(held|paid)" }] }] },
  };
  const good: StoredDiagram = {
    nodeId: "2:2", kind: "state", title: "Booking lifecycle",
    spec: { title: "Booking lifecycle", states: [{ id: "held" }, { id: "paid" }] },
  };
  const draft: StoredDiagram = {
    nodeId: "3:3", kind: "state", title: "Booking lifecycle (bản nháp)",
    spec: { title: "Booking lifecycle (bản nháp)", states: [{ id: "held" }, { id: "expired" }] },
  };

  it("checks the draft as well as the one that already agrees", () => {
    const f = checkConsistency([erdTwo, good, draft]);
    expect(f).toHaveLength(1);
    expect(f[0]!.frames).toEqual(["3:3", "1:1"]);
    expect(f[0]!.message).toContain("`expired`");
  });

  it("reports each machine that disagrees, not just one of them", () => {
    const second = { ...draft, nodeId: "4:4", title: "Booking lifecycle v3" };
    (second.spec as any).title = "Booking lifecycle v3";
    const f = checkConsistency([erdTwo, draft, second]);
    expect(f.map((x) => x.frames[0])).toEqual(["3:3", "4:4"]);
  });
});
