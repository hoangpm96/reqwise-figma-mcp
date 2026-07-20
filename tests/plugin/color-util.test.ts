import { describe, it, expect } from "vitest";
import {
  hexToRgba,
  hexToRgb,
  rgbToHex,
  rgbaToHex,
  isHexColor,
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
