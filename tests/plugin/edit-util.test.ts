import { describe, it, expect } from "vitest";
import {
  rgbNearlyEqual,
  shouldRecolor,
  gradientPaintType,
  defaultGradientTransform,
  isValidGradientTransform,
  normalizeGradientStops,
  normalizeEffect,
  normalizeEffects,
  buildOverrideSummary,
  flattenComponentProperties,
} from "../../src/plugin/edit-util.js";

describe("recolor match logic", () => {
  it("shouldRecolor with no `from` matches every solid color", () => {
    expect(shouldRecolor({ r: 0.1, g: 0.2, b: 0.3 })).toBe(true);
    expect(shouldRecolor({ r: 1, g: 1, b: 1 })).toBe(true);
  });

  it("shouldRecolor with `from` only matches near that hex", () => {
    // #ff0000 → r:1,g:0,b:0
    expect(shouldRecolor({ r: 1, g: 0, b: 0 }, "#ff0000")).toBe(true);
    expect(shouldRecolor({ r: 0, g: 0, b: 1 }, "#ff0000")).toBe(false);
  });

  it("matches within tolerance (rounding noise from 8-bit channels)", () => {
    // 254/255 ≈ 0.9961 should still match #ffffff within epsilon
    expect(shouldRecolor({ r: 254 / 255, g: 1, b: 1 }, "#ffffff")).toBe(true);
  });

  it("rgbNearlyEqual respects epsilon boundary", () => {
    expect(rgbNearlyEqual({ r: 0, g: 0, b: 0 }, { r: 0.003, g: 0, b: 0 })).toBe(
      true,
    );
    expect(rgbNearlyEqual({ r: 0, g: 0, b: 0 }, { r: 0.05, g: 0, b: 0 })).toBe(
      false,
    );
  });
});

describe("gradient transform defaults", () => {
  it("maps friendly type → figma paint type", () => {
    expect(gradientPaintType("LINEAR")).toBe("GRADIENT_LINEAR");
    expect(gradientPaintType("radial")).toBe("GRADIENT_RADIAL");
    expect(gradientPaintType("Angular")).toBe("GRADIENT_ANGULAR");
    expect(gradientPaintType("DIAMOND")).toBe("GRADIENT_DIAMOND");
  });

  it("throws on unknown gradient type", () => {
    expect(() => gradientPaintType("SPIRAL")).toThrow(/Unknown gradient type/);
  });

  it("default transform is the 2x3 identity affine matrix", () => {
    expect(defaultGradientTransform("GRADIENT_LINEAR")).toEqual([
      [1, 0, 0],
      [0, 1, 0],
    ]);
  });

  it("validates a 2x3 numeric matrix", () => {
    expect(
      isValidGradientTransform([
        [1, 0, 0],
        [0, 1, 0],
      ]),
    ).toBe(true);
  });

  it("rejects malformed transforms", () => {
    expect(isValidGradientTransform([[1, 0, 0]])).toBe(false); // 1 row
    expect(
      isValidGradientTransform([
        [1, 0],
        [0, 1],
      ]),
    ).toBe(false); // 2 cols
    expect(isValidGradientTransform("nope")).toBe(false);
    expect(
      isValidGradientTransform([
        [1, 0, NaN],
        [0, 1, 0],
      ]),
    ).toBe(false);
  });

  it("normalizeGradientStops fills evenly-spaced positions when omitted", () => {
    const stops = normalizeGradientStops([
      { color: "#000000" },
      { color: "#ffffff" },
      { color: "#ff0000" },
    ]);
    expect(stops.map((s) => s.position)).toEqual([0, 0.5, 1]);
    expect(stops[0]!.color).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(stops[1]!.color.r).toBe(1);
  });

  it("normalizeGradientStops applies per-stop opacity and clamps position", () => {
    const stops = normalizeGradientStops([
      { color: "#000000", position: -1, opacity: 0.5 },
      { color: "#ffffff", position: 2 },
    ]);
    expect(stops[0]!.position).toBe(0);
    expect(stops[0]!.color.a).toBe(0.5);
    expect(stops[1]!.position).toBe(1);
  });

  it("normalizeGradientStops requires ≥1 stop", () => {
    expect(() => normalizeGradientStops([])).toThrow(/non-empty stops/);
    expect(() => normalizeGradientStops("nope")).toThrow(/non-empty stops/);
  });
});

describe("effect normalization", () => {
  it("shadow carries color/offset/spread/blendMode with defaults", () => {
    const e = normalizeEffect({ type: "DROP_SHADOW", radius: 8 });
    expect(e).toMatchObject({
      type: "DROP_SHADOW",
      radius: 8,
      spread: 0,
      visible: true,
      blendMode: "NORMAL",
      offset: { x: 0, y: 2 },
    });
    expect("color" in e).toBe(true);
  });

  it("shadow parses hex color and explicit offset/spread", () => {
    const e = normalizeEffect({
      type: "INNER_SHADOW",
      color: "#ff000080",
      offset: { x: 4, y: 6 },
      spread: 3,
      radius: 10,
      visible: false,
    });
    if (e.type !== "INNER_SHADOW") throw new Error("wrong type");
    expect(e.color.r).toBe(1);
    expect(e.color.a).toBeCloseTo(0.5, 1);
    expect(e.offset).toEqual({ x: 4, y: 6 });
    expect(e.spread).toBe(3);
    expect(e.visible).toBe(false);
  });

  it("blur carries only radius (no color/offset)", () => {
    const e = normalizeEffect({ type: "LAYER_BLUR", radius: 12 });
    expect(e).toEqual({ type: "LAYER_BLUR", radius: 12, visible: true });
    expect("color" in e).toBe(false);
    expect("offset" in e).toBe(false);
  });

  it("requires a non-negative numeric radius", () => {
    expect(() => normalizeEffect({ type: "DROP_SHADOW" })).toThrow(/radius/);
    expect(() =>
      normalizeEffect({ type: "LAYER_BLUR", radius: -5 }),
    ).toThrow(/radius/);
  });

  it("throws on unknown effect type", () => {
    expect(() =>
      normalizeEffect({ type: "GLOW", radius: 4 }),
    ).toThrow(/Unknown effect type/);
  });

  it("normalizeEffects handles a list and treats empty as clear-all", () => {
    const list = normalizeEffects([
      { type: "DROP_SHADOW", radius: 4 },
      { type: "LAYER_BLUR", radius: 2 },
    ]);
    expect(list).toHaveLength(2);
    // An empty array is a deliberate "clear all effects", matching the
    // validator which accepts it — returns [] instead of throwing.
    expect(normalizeEffects([])).toEqual([]);
  });

  it("normalizeEffects accepts a single (non-array) spec", () => {
    const list = normalizeEffects({ type: "DROP_SHADOW", radius: 4 });
    expect(list).toHaveLength(1);
  });
});

describe("override-diff shape", () => {
  it("buildOverrideSummary produces a portable copy (no aliasing)", () => {
    const ids = ["a", "b"];
    const props = { Size: "Large" };
    const exposed = ["x"];
    const summary = buildOverrideSummary({
      sourceInstanceId: "1:2",
      mainComponentId: "10:20",
      overriddenNodeIds: ids,
      componentProperties: props,
      exposedInstanceIds: exposed,
    });
    expect(summary).toEqual({
      sourceInstanceId: "1:2",
      mainComponentId: "10:20",
      overriddenNodeIds: ["a", "b"],
      componentProperties: { Size: "Large" },
      exposedInstanceIds: ["x"],
    });
    // Mutating inputs must not affect the summary.
    ids.push("c");
    props.Size = "Small";
    exposed.push("y");
    expect(summary.overriddenNodeIds).toEqual(["a", "b"]);
    expect(summary.componentProperties).toEqual({ Size: "Large" });
    expect(summary.exposedInstanceIds).toEqual(["x"]);
  });

  it("flattenComponentProperties extracts name→value", () => {
    const flat = flattenComponentProperties({
      Size: { type: "VARIANT", value: "Large" },
      "Label#1:2": { type: "TEXT", value: "Login" },
      Show: { type: "BOOLEAN", value: true },
    });
    expect(flat).toEqual({
      Size: "Large",
      "Label#1:2": "Login",
      Show: true,
    });
  });

  it("flattenComponentProperties tolerates undefined", () => {
    expect(flattenComponentProperties(undefined)).toEqual({});
  });
});
