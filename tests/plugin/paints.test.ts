import { describe, it, expect } from "vitest";
import { toPaintCore, toPaintsCore, toEffectCore } from "../../src/plugin/paints-core.js";
import type { SolidPaintOut, GradientPaintOut, ShadowEffectOut } from "../../src/plugin/paints-core.js";
import { parseColor, isRgbObject } from "../../src/plugin/color-util.js";

/**
 * The color-format traps that painted an entire screen black: colors given as
 * {r,g,b} objects (the OFFICIAL Figma Plugin API shape every LLM knows) were
 * silently replaced with {0,0,0}. These tests pin the accept-or-throw contract.
 */

describe("parseColor", () => {
  it("parses hex strings", () => {
    expect(parseColor("#ff0000")).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(parseColor("#00ff0080").a).toBeCloseTo(0x80 / 255, 5);
  });
  it("accepts {r,g,b} 0..1 (official Figma shape)", () => {
    expect(parseColor({ r: 0.5, g: 0.25, b: 1 })).toEqual({ r: 0.5, g: 0.25, b: 1, a: 1 });
  });
  it("accepts {r,g,b,a} with alpha", () => {
    expect(parseColor({ r: 1, g: 1, b: 1, a: 0.5 })).toEqual({ r: 1, g: 1, b: 1, a: 0.5 });
  });
  it("auto-detects 0..255 channels", () => {
    const c = parseColor({ r: 255, g: 128, b: 0 });
    expect(c.r).toBe(1);
    expect(c.g).toBeCloseTo(128 / 255, 5);
    expect(c.b).toBe(0);
  });
  it("throws on garbage instead of defaulting to black", () => {
    expect(() => parseColor("not-a-color")).toThrow(/Invalid color/);
    expect(() => parseColor({ red: 1 })).toThrow(/Invalid color/);
    expect(() => parseColor(42)).toThrow(/Invalid color/);
  });
  it("isRgbObject guards shapes", () => {
    expect(isRgbObject({ r: 1, g: 0, b: 0 })).toBe(true);
    expect(isRgbObject({ r: 1, g: 0 })).toBe(false);
    expect(isRgbObject("#fff")).toBe(false);
  });
});

describe("toPaintCore", () => {
  it("hex string → SOLID", () => {
    const p = toPaintCore("#2563eb") as SolidPaintOut;
    expect(p.type).toBe("SOLID");
    expect(p.color.b).toBeCloseTo(0xeb / 255, 5);
  });

  it("bare {r,g,b} object → SOLID (was: silent black)", () => {
    const p = toPaintCore({ r: 1, g: 1, b: 1 }) as SolidPaintOut;
    expect(p.type).toBe("SOLID");
    expect(p.color).toEqual({ r: 1, g: 1, b: 1 });
  });

  it("SOLID spec with {r,g,b} color object (was: silent black)", () => {
    const p = toPaintCore({ type: "SOLID", color: { r: 0.29, g: 0.33, b: 0.94 } }) as SolidPaintOut;
    expect(p.color.r).toBeCloseTo(0.29, 5);
    expect(p.color.g).toBeCloseTo(0.33, 5);
    expect(p.color.b).toBeCloseTo(0.94, 5);
  });

  it("SOLID spec with hex color still works", () => {
    const p = toPaintCore({ type: "SOLID", color: "#ffffff", opacity: 0.9 }) as SolidPaintOut;
    expect(p.color).toEqual({ r: 1, g: 1, b: 1 });
    expect(p.opacity).toBe(0.9);
  });

  it("SOLID spec with a malformed color THROWS with a format hint", () => {
    expect(() => toPaintCore({ type: "SOLID", color: "blue" })).toThrow(/#rrggbb|\{r,g,b/);
    expect(() => toPaintCore({ type: "SOLID" })).toThrow(); // color missing entirely
  });

  it("gradient stops accept {r,g,b,a} color objects (was: all-black stops)", () => {
    const p = toPaintCore({
      type: "GRADIENT_LINEAR",
      stops: [
        { position: 0, color: { r: 0.29, g: 0.33, b: 0.94, a: 1 } },
        { position: 1, color: "#7c3aed" },
      ],
    }) as GradientPaintOut;
    expect(p.gradientStops[0]!.color.g).toBeCloseTo(0.33, 5);
    expect(p.gradientStops[1]!.color.r).toBeCloseTo(0x7c / 255, 5);
  });

  it("accepts gradientStops as an alias for stops (Figma-API spelling)", () => {
    const p = toPaintCore({
      type: "GRADIENT_LINEAR",
      gradientStops: [
        { position: 0, color: "#000000" },
        { position: 1, color: "#ffffff" },
      ],
    }) as GradientPaintOut;
    expect(p.gradientStops).toHaveLength(2);
  });

  it("gradient stop with malformed color throws naming the stop", () => {
    expect(() =>
      toPaintCore({ type: "GRADIENT_LINEAR", stops: [{ position: 0, color: "red" }] }),
    ).toThrow(/gradient stop 0/);
  });

  it("toPaintsCore maps arrays", () => {
    const ps = toPaintsCore([{ r: 1, g: 0, b: 0 }, "#00ff00"]);
    expect(ps).toHaveLength(2);
  });
});

describe("toEffectCore", () => {
  it("shadow color accepts {r,g,b,a} objects", () => {
    const e = toEffectCore({
      type: "DROP_SHADOW",
      color: { r: 0, g: 0, b: 0, a: 0.2 },
      offset: { x: 0, y: 4 },
      radius: 12,
    }) as ShadowEffectOut;
    expect(e.color.a).toBeCloseTo(0.2, 5);
  });
  it("omitted shadow color keeps the sensible default", () => {
    const e = toEffectCore({ type: "DROP_SHADOW", radius: 4 }) as ShadowEffectOut;
    expect(e.color.a).toBeCloseTo(0.25, 5);
  });
  it("present-but-malformed shadow color throws", () => {
    expect(() => toEffectCore({ type: "DROP_SHADOW", color: "shadowy", radius: 4 })).toThrow(/DROP_SHADOW color/);
  });
});
