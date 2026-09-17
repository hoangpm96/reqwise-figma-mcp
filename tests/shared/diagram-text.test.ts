import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildActivity } from "../../src/shared/activity/index.js";
import { buildErd } from "../../src/shared/erd/index.js";
import { buildSequence } from "../../src/shared/sequence/index.js";
import { buildState } from "../../src/shared/state/index.js";
import { parseErdText } from "../../src/shared/erd/text.js";
import { parseActivityText } from "../../src/shared/activity/text.js";
import { parseSequenceText } from "../../src/shared/sequence/text.js";
import { parseStateText } from "../../src/shared/state/text.js";

/**
 * The .dsl files live next to the tests, not in /tmp: these fixtures ARE the
 * expectation, so they have to travel with the repo.
 */
const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${name}.dsl`, import.meta.url)), "utf8");

/**
 * One diagram, written twice: as the JSON arrays and as the compact line form.
 * The two must produce byte-identical draw data — the cheap door has to be the
 * same door, or an agent that used it drew something subtly different from
 * what the JSON would have drawn.
 */

describe("the compact erd form", () => {
  const text = `
users happy
  id uuid pk!
  email varchar(255)!
  full_name text
bookings happy / the order
  id uuid pk!
  user_id uuid fk!
  status text!
booking_seats happy
  booking_id uuid pfk!
  seat_id uuid pfk!
psp ext / payment gateway
  reference varchar(64)!
users.id 1-* bookings.user_id "books"
bookings.id 1=+ booking_seats.booking_id "holds"
`;
  const json = {
    title: "Booking",
    entities: [
      { id: "users", name: "users", cls: "happy" as const, attributes: [
        { name: "id", type: "uuid", key: "pk" as const, required: true },
        { name: "email", type: "varchar(255)", required: true },
        { name: "full_name", type: "text" },
      ]},
      { id: "bookings", name: "bookings", cls: "happy" as const, detail: "the order", attributes: [
        { name: "id", type: "uuid", key: "pk" as const, required: true },
        { name: "user_id", type: "uuid", key: "fk" as const, required: true },
        { name: "status", type: "text", required: true },
      ]},
      { id: "booking_seats", name: "booking_seats", cls: "happy" as const, attributes: [
        { name: "booking_id", type: "uuid", key: "pfk" as const, required: true },
        { name: "seat_id", type: "uuid", key: "pfk" as const, required: true },
      ]},
      { id: "psp", name: "psp", external: true, detail: "payment gateway", attributes: [
        { name: "reference", type: "varchar(64)", required: true },
      ]},
    ],
    relations: [
      { from: "users", to: "bookings", fromField: "id", toField: "user_id", label: "books", toCard: "zero-many" as const },
      { from: "bookings", to: "booking_seats", fromField: "id", toField: "booking_id", label: "holds", toCard: "one-many" as const, identifying: true },
    ],
  };

  it("parses to the same tables and keys", () => {
    const p = parseErdText(text);
    expect(p.warnings).toEqual([]);
    expect(p.entities).toEqual(json.entities);
    expect(p.relations).toEqual(json.relations);
  });

  it("draws the same thing", () => {
    const a = buildErd({ title: "Booking", text } as any);
    const b = buildErd(json as any);
    expect(a.warnings).toEqual(b.warnings);
    expect(a.draw).toEqual(b.draw);
  });

  it("reports a relationship that names no columns — the hard rule of an ERD — exactly once", () => {
    // The parser and the checker both used to say it, so the text form came
    // back with the same finding twice. The checker owns it: it sees JSON too.
    const built = buildErd({ title: "t", text: `a\n  id uuid pk!\nb\n  id uuid pk!\na 1-* b "has"` } as any);
    expect(built.warnings.filter((w) => /no column/i.test(w))).toHaveLength(1);
    expect(built.warnings.join(" ")).toContain("No column named on a → b");
  });

  it("accepts mermaid's crow's foot, since a model reaches for it by habit", () => {
    const p = parseErdText(`a\n  id uuid pk!\nb\n  a_id uuid fk!\na.id ||--o{ b.a_id : has`);
    expect(p.relations[0]).toMatchObject({ from: "a", to: "b", fromField: "id", toField: "a_id", toCard: "zero-many", label: "has" });
  });
});

describe("the compact activity form", () => {
  const text = fixture("activity");

  it("keeps the lane on every step and the label on every handoff", () => {
    const p = parseActivityText(text);
    expect(p.warnings).toEqual([]);
    expect(p.rankdir).toBe("LR");
    expect(p.lanes.map((l) => l.id)).toEqual(["user", "sys", "pay", "mail"]);
    // Every step has an owner: that is the field this diagram exists for.
    expect(p.nodes.every((n) => n.lane)).toBe(true);
    expect(p.nodes.find((n) => n.id === "isLogged")).toMatchObject({ kind: "decision" });
    expect(p.nodes.find((n) => n.id === "seatChart")!.label).toContain("\n");
    expect(p.edges.filter((e) => e.kind === "return")).toHaveLength(3);
  });

  it("draws a diagram the checker is as happy with as the JSON one", () => {
    const built = buildActivity({ title: "Online movie ticket booking", text } as any);
    expect(built.warnings).toEqual([]);
    expect(built.stats).toMatchObject({ lanes: 4, nodes: 27, edges: 31, handoffs: 16, returnEdges: 3 });
  });
});

describe("the compact state form", () => {
  const text = fixture("state");

  it("keeps event, guard and action as three fields, not one string", () => {
    const p = parseStateText(text);
    expect(p.warnings).toEqual([]);
    expect(p.transitions[1]).toEqual({
      from: "held",
      to: "paying",
      event: "Confirm the order",
      guard: "payment method chosen",
      action: "insert payments(attempt_no, pending)",
    });
    expect(p.transitions[3]).toMatchObject({ kind: "return", cls: "error", guard: "failed attempts < 3" });
    expect(p.states.find((s) => s.id === "paying")).toMatchObject({ do: "wait for the payment gateway" });
    expect(p.states.find((s) => s.id === "held")).toMatchObject({
      entry: "hold_expires_at = now() + 10 min",
      detail: "booking_seats rows written",
    });
  });

  it("draws the machine with no findings, like the JSON twin", () => {
    const built = buildState({ title: "Booking lifecycle", text } as any);
    expect(built.warnings).toEqual([]);
    expect(built.stats).toMatchObject({ states: 5, transitions: 5, finals: 2 });
  });
});

describe("a label with quotes in it", () => {
  it("survives, instead of truncating and inventing a step", () => {
    // `Show "Seats unavailable"` cut the label at the inner quote and left the
    // tail to be read as ANOTHER step with the same id — a silently wrong
    // diagram, which is the failure mode this whole kit exists to avoid.
    const p = parseActivityText(`sys: seatErr err "Show \\"Seats unavailable\\""`);
    expect(p.warnings).toEqual([]);
    expect(p.nodes).toHaveLength(1);
    expect(p.nodes[0]).toEqual({ id: "seatErr", label: 'Show "Seats unavailable"', lane: "sys", cls: "error" });
  });
});

describe("a leading header line", () => {
  it("is reported, not drawn as content", () => {
    for (const [kind, src] of [
      ["activity", 'activity "Title"\nsys: a "Step"'],
      ["erd", 'erd "Title"\nusers\n  id uuid pk!'],
      ["state", 'state "Title"\na "A"'],
    ] as const) {
      const parse = { activity: parseActivityText, erd: parseErdText, state: parseStateText }[kind];
      const p = parse(src);
      expect(p.warnings.join(" "), kind).toContain("header line is not part of the model");
    }
  });
});

describe("the two doors are the same door", () => {
  /**
   * Parse the text, then draw the SAME model both ways: through `text` and
   * through the arrays. Any field the builder reads off the raw spec instead
   * of the merged model shows up here as a different drawing — which is how
   * `system` (the use case boundary) was silently dropped from the text path:
   * the checker saw it, so there was no warning, and the frame just came out
   * 65px shorter with no box around the scope.
   */
  it("draws identically whichever door the model came through", () => {
    const cases = [
      {
        kind: "activity",
        text: fixture("activity"),
        parse: parseActivityText,
        build: buildActivity,
      },
      {
        kind: "state",
        text: fixture("state"),
        parse: parseStateText,
        build: buildState,
      },
      {
        kind: "erd",
        text: fixture("erd"),
        parse: parseErdText,
        build: buildErd,
      },
      {
        kind: "sequence",
        text: fixture("sequence"),
        parse: parseSequenceText,
        build: buildSequence,
      },
    ] as const;

    for (const c of cases) {
      const parsed: Record<string, unknown> = { ...(c.parse as (s: string) => object)(c.text) };
      delete parsed.warnings;
      const fromText = (c.build as (s: unknown) => any)({ title: "T", subtitle: "S", text: c.text });
      const fromArrays = (c.build as (s: unknown) => any)({ title: "T", subtitle: "S", ...parsed });
      expect(fromText.draw, `${c.kind}: the text door drew something else`).toEqual(fromArrays.draw);
      expect(fromText.warnings, c.kind).toEqual(fromArrays.warnings);
    }
  });
});
