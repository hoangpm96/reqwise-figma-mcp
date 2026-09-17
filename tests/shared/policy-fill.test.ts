import { describe, expect, it } from "vitest";
import { fill, fillDeep, refsIn, unresolved } from "../../src/shared/model/policy.js";
import { buildState } from "../../src/shared/state/index.js";
import { buildActivity } from "../../src/shared/activity/index.js";

describe("filling a rule into a label", () => {
  const P = { "hold-minutes": 10, "retry-attempts": 3 };

  it("replaces a reference wherever one can legitimately start", () => {
    expect(fill("Giữ ghế @hold-minutes phút", P)).toBe("Giữ ghế 10 phút");
    expect(fill("[n < @retry-attempts]", P)).toBe("[n < 3]");
    expect(fill("@hold-minutes phút", P)).toBe("10 phút");
    expect(fill("(@retry-attempts)", P)).toBe("(3)");
  });

  it("leaves an @ that is not a reference alone", () => {
    // An email is the obvious one, and a label full of them would otherwise be
    // rewritten into nonsense.
    expect(fill("Gửi tới user@example.com", P)).toBe("Gửi tới user@example.com");
    expect(fill("Không có @gì cả", P)).toBe("Không có @gì cả");
  });

  it("finds the references a model makes", () => {
    expect(refsIn("hold @hold-minutes then retry @retry-attempts")).toEqual([
      "hold-minutes",
      "retry-attempts",
    ]);
  });

  it("reports a reference nothing defines — but only where rules are in use", () => {
    expect(unresolved({ a: "@hold-minute typo" }, P)).toEqual(["hold-minute"]);
    // No policies declared: every stray @ would be a false accusation.
    expect(unresolved({ a: "@anything" }, {})).toEqual([]);
  });

  it("walks a whole model, not just the top level", () => {
    const out = fillDeep({ xs: [{ label: "@hold-minutes phút", n: 1 }] }, P);
    expect(out).toEqual({ xs: [{ label: "10 phút", n: 1 }] });
  });
});

describe("a rule reaches the drawing but never the stored model", () => {
  /**
   * This is the property the whole design rests on. The DRAWING has to show
   * the number, or a reader learns nothing. The MODEL has to keep the
   * reference, or the page cannot be asked which frames depend on the rule —
   * and "we are moving to 15 minutes, what changes?" goes back to being five
   * diagrams read by hand.
   */
  const spec = {
    title: "Booking lifecycle",
    states: [{ id: "held", label: "Giữ ghế @hold-minutes phút" }, { id: "paid" }],
    transitions: [{ from: "held", to: "paid", event: "Pay", guard: "n < @retry-attempts" }],
    options: { policies: { "hold-minutes": 10, "retry-attempts": 3 } },
  };

  it("draws the value", () => {
    const drawn = JSON.stringify(buildState(spec as any).draw);
    expect(drawn).toContain("Giữ ghế 10 phút");
    expect(drawn).toContain("n < 3");
    expect(drawn).not.toContain("@hold-minutes");
  });

  it("stores the reference", () => {
    const model = JSON.stringify(buildState(spec as any).model);
    expect(model).toContain("@hold-minutes");
    expect(model).toContain("@retry-attempts");
    expect(model).toContain('"hold-minutes":10');
  });

  it("redraws identically from the model it stored", () => {
    // The reference form has to survive a round trip, or the second draw of a
    // patched diagram loses every number on it.
    const first = buildState(spec as any);
    const again = buildState(first.model as any);
    expect(again.draw).toEqual(first.draw);
  });

  it("reports a typo instead of drawing it silently", () => {
    const typo = {
      ...spec,
      states: [{ id: "held", label: "Giữ @hold-minute phút" }, { id: "paid" }],
    };
    const built = buildActivity({
      title: "T",
      nodes: [{ id: "a", label: "Giữ @hold-minute phút" }, { id: "b", label: "B" }],
      edges: [{ from: "a", to: "b" }],
      options: { policies: { "hold-minutes": 10 } },
    } as any);
    expect(built.warnings.join(" ")).toContain("@hold-minute");
    expect(buildState(typo as any).warnings.join(" ")).toContain("@hold-minute");
  });
});
