import { describe, expect, it } from "vitest";
import { applyPatch } from "../../src/server/patch.js";
import { buildSequence } from "../../src/shared/sequence/index.js";
import { buildActivity } from "../../src/shared/activity/index.js";
import { buildErd } from "../../src/shared/erd/index.js";
import { buildState } from "../../src/shared/state/index.js";
import { buildSitemap } from "../../src/shared/sitemap/index.js";

/**
 * Renaming an id through a patch carries its references with it.
 *
 * Found drawing a real demo: `{ collection: "participants", id: "api", set:
 * { id: "backend" } }` renamed the head, every message still said from/to
 * "api", and the builder dropped them as referring to an unknown participant —
 * the sequence silently lost its messages. Each test builds the patched model,
 * because "the strings changed" is not the claim; "nothing got dropped" is.
 */

const SEQ = {
  title: "Pay",
  participants: [
    { id: "app", name: "App" },
    { id: "api", name: "API" },
  ],
  messages: [
    { id: "m1", from: "app", to: "api", label: "POST /pay" },
    { id: "m2", from: "api", to: "app", label: "200 paid", kind: "return" as const },
    { id: "m3", from: "app", to: "api", label: "GET /receipt" },
    { id: "m4", from: "api", to: "app", label: "402", kind: "return" as const },
  ],
  fragments: [
    { kind: "alt" as const, label: "paid", messages: ["m2", "m3"], else: { label: "declined", messages: ["m4"] } },
  ],
};

describe("renaming a sequence participant", () => {
  it("moves every message's from/to with it, and the messages are still drawn", () => {
    const { spec, applied } = applyPatch(buildSequence(SEQ as any).model, [
      { collection: "participants", id: "api", set: { id: "backend" } },
    ]);
    const msgs = spec.messages as any[];
    expect(msgs.map((m) => [m.from, m.to])).toEqual([
      ["app", "backend"], ["backend", "app"], ["app", "backend"], ["backend", "app"],
    ]);
    expect(applied[0]).toContain("renamed participant api → backend (4 references)");
    const built = buildSequence(spec as any);
    expect(built.draw.messages).toHaveLength(4);
    expect(built.warnings.join(" ")).not.toContain("api");
  });

  it("refuses a rename onto an id another participant already has", () => {
    expect(() =>
      applyPatch(SEQ, [{ collection: "participants", id: "api", set: { id: "app" } }]),
    ).toThrow(/already has a member with that id/);
  });
});

describe("renaming a sequence message", () => {
  it("moves the fragment's references, in both halves of an alt", () => {
    const { spec, applied } = applyPatch(SEQ, [
      { collection: "messages", id: "m2", set: { id: "paid" } },
      { collection: "messages", id: "m4", set: { id: "declined" } },
    ]);
    const frag = (spec.fragments as any[])[0];
    expect(frag.messages).toEqual(["paid", "m3"]);
    expect(frag.else.messages).toEqual(["declined"]);
    expect(applied[0]).toContain("renamed message m2 → paid (1 reference)");
    expect(applied[1]).toContain("renamed message m4 → declined (1 reference)");
    const built = buildSequence(spec as any);
    expect(built.draw.fragments).toHaveLength(1);
    expect(built.warnings.join(" ")).not.toMatch(/\bm2\b|\bm4\b/);
  });
});

describe("renaming in an activity diagram", () => {
  const ACT = {
    title: "Approve",
    lanes: [{ id: "sales", label: "Sales" }, { id: "fin", label: "Finance" }],
    nodes: [
      { id: "start", label: "Start", kind: "start" as const, lane: "sales" },
      { id: "draft", label: "Draft quote", lane: "sales" },
      { id: "check", label: "Check margin", lane: "fin" },
      { id: "end", label: "Done", kind: "end" as const, lane: "fin" },
    ],
    edges: [
      { from: "start", to: "draft" },
      { from: "draft", to: "check", label: "quote" },
      { from: "check", to: "draft", label: "rework", kind: "return" as const },
      { from: "check", to: "end" },
    ],
  };

  it("a node rename moves the edges that start or end on it", () => {
    const before = buildActivity(ACT as any);
    const { spec, applied } = applyPatch(before.model, [
      { collection: "nodes", id: "draft", set: { id: "quote" } },
    ]);
    expect((spec.edges as any[]).map((e) => `${e.from}>${e.to}`)).toEqual([
      "start>quote", "quote>check", "check>quote", "check>end",
    ]);
    expect(applied[0]).toContain("renamed node draft → quote (3 references)");
    expect(buildActivity(spec as any).draw.edges).toHaveLength(before.draw.edges.length);
  });

  it("a lane rename moves the steps that sit in it", () => {
    const { spec, applied } = applyPatch(ACT, [
      { collection: "lanes", id: "fin", set: { id: "finance" } },
    ]);
    expect((spec.nodes as any[]).map((n) => n.lane)).toEqual(["sales", "sales", "finance", "finance"]);
    expect(applied[0]).toContain("renamed lane fin → finance (2 references)");
  });
});

describe("renaming in an ERD", () => {
  const ERD = {
    title: "Orders",
    entities: [
      { id: "customer", name: "customers", attributes: [{ name: "id", key: "pk" as const }] },
      {
        id: "order",
        name: "orders",
        attributes: [
          { name: "id", key: "pk" as const },
          { name: "cust_id", key: "fk" as const },
        ],
      },
    ],
    relations: [{ from: "customer", to: "order", label: "places", fromField: "id", toField: "cust_id" }],
  };

  it("an entity rename moves the relations", () => {
    const { spec, applied } = applyPatch(ERD, [
      { collection: "entities", id: "order", set: { id: "orders" } },
    ]);
    expect((spec.relations as any[])[0]).toMatchObject({ from: "customer", to: "orders" });
    expect(applied[0]).toContain("renamed entity order → orders (1 reference)");
    expect(buildErd(spec as any).draw.edges).toHaveLength(1);
  });

  it("a column rename addressed by index moves the field a relation attaches to", () => {
    const { spec, applied } = applyPatch(ERD, [
      { collection: "entities", id: "order", set: { id: "orders", "attributes.1.name": "customer_id" } },
    ]);
    expect((spec.relations as any[])[0]).toMatchObject({ to: "orders", toField: "customer_id", fromField: "id" });
    expect(applied[0]).toContain("renamed column orders.cust_id → customer_id (1 reference)");
  });
});

describe("renaming a state", () => {
  it("moves the transitions into and out of it", () => {
    const SM = {
      title: "Order",
      states: [
        { id: "init", kind: "initial" as const },
        { id: "pending", label: "Pending" },
        { id: "done", label: "Done", kind: "final" as const },
      ],
      transitions: [
        { from: "init", to: "pending" },
        { from: "pending", to: "pending", event: "remind" },
        { from: "pending", to: "done", event: "Approve" },
      ],
    };
    const before = buildState(SM as any);
    const { spec, applied } = applyPatch(before.model, [
      { collection: "states", id: "pending", set: { id: "waiting" } },
    ]);
    expect((spec.transitions as any[]).map((t) => `${t.from}>${t.to}`)).toEqual([
      "init>waiting", "waiting>waiting", "waiting>done",
    ]);
    expect(applied[0]).toContain("renamed state pending → waiting (4 references)");
    expect(buildState(spec as any).draw.edges).toHaveLength(before.draw.edges.length);
  });
});

describe("renaming a sitemap page", () => {
  it("moves the children's parent", () => {
    const { spec, applied } = applyPatch(
      { title: "IA", pages: [{ id: "home" }, { id: "a", parent: "home" }, { id: "b", parent: "home" }] },
      [{ collection: "pages", id: "home", set: { id: "root" } }],
    );
    expect((spec.pages as any[]).map((p) => p.parent)).toEqual([undefined, "root", "root"]);
    expect(applied[0]).toContain("renamed page home → root (2 references)");
    expect(buildSitemap(spec as any).warnings.join(" ")).not.toContain("home");
  });
});

