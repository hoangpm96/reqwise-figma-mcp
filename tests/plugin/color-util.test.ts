import { describe, it, expect } from "vitest";
import {
  hexToRgba,
  hexToRgb,
  rgbToHex,
  rgbaToHex,
  isHexColor,
  relativeLuminance,
  contrastRatio,
  compositeOver,
} from "../../src/plugin/color-util.js";

describe("hexToRgba", () => {
  it("parses #rrggbb with default alpha 1", () => {
    expect(hexToRgba("#ff0000")).toEqual({ r: 1, g: 0, b: 0, a: 1 });
  });
  it("parses without hash", () => {
    expect(hexToRgb("00ff00")).toEqual({ r: 0, g: 1, b: 0 });
  });
  it("parses shorthand #rgb", () => {
    const c = hexToRgb("#0f0");
    expect(c.g).toBe(1);
    expect(c.r).toBe(0);
  });
  it("parses #rrggbbaa", () => {
    const c = hexToRgba("#00000080");
    expect(c.a).toBeCloseTo(0.5, 1);
  });
  it("throws on invalid", () => {
    expect(() => hexToRgba("nope")).toThrow();
  });
});

describe("rgb ↔ hex round trip", () => {
  it("rgbToHex", () => {
    expect(rgbToHex({ r: 1, g: 0, b: 0 })).toBe("#ff0000");
  });
  it("rgbaToHex", () => {
    expect(rgbaToHex({ r: 0, g: 0, b: 0, a: 1 })).toBe("#000000ff");
  });
  it("round trips", () => {
    const hex = "#3a7bd5";
    expect(rgbToHex(hexToRgb(hex))).toBe(hex);
  });
});

describe("isHexColor", () => {
  it("accepts valid forms", () => {
    expect(isHexColor("#fff")).toBe(true);
    expect(isHexColor("aabbcc")).toBe(true);
    expect(isHexColor("#aabbccdd")).toBe(true);
  });
  it("rejects junk", () => {
    expect(isHexColor("primary")).toBe(false);
    expect(isHexColor("#gg0000")).toBe(false);
  });
});

describe("WCAG contrast (relativeLuminance / contrastRatio)", () => {
  const white = { r: 1, g: 1, b: 1 };
  const black = { r: 0, g: 0, b: 0 };

  it("luminance of white is 1 and black is 0", () => {
    expect(relativeLuminance(white)).toBeCloseTo(1, 5);
    expect(relativeLuminance(black)).toBeCloseTo(0, 5);
  });

  it("black-on-white is the max ratio 21:1", () => {
    expect(contrastRatio(black, white)).toBeCloseTo(21, 1);
  });

  it("is order-independent", () => {
    expect(contrastRatio(black, white)).toBeCloseTo(contrastRatio(white, black), 5);
  });

  it("same color is 1:1", () => {
    expect(contrastRatio(white, white)).toBeCloseTo(1, 5);
  });

  it("readable muted grey (#60646C on white) passes body 4.5:1", () => {
    const fg = hexToRgb("#60646C");
    expect(contrastRatio(fg, white)).toBeGreaterThan(4.5);
  });

  it("washed-out grey (#8B8D98 on white) FAILS body 4.5 but PASSES large 3", () => {
    const fg = hexToRgb("#8B8D98");
    const r = contrastRatio(fg, white);
    expect(r).toBeLessThan(4.5); // the case the old RGB-distance check missed
    expect(r).toBeGreaterThan(3);
  });

  it("compositeOver flattens a translucent fg toward the bg", () => {
    const half = { r: 0, g: 0, b: 0, a: 0.5 };
    const out = compositeOver(half, white);
    expect(out.r).toBeCloseTo(0.5, 5);
    // 50% black over white has less contrast than solid black over white
    expect(contrastRatio(out, white)).toBeLessThan(contrastRatio(black, white));
  });
});
