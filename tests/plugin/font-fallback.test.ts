import { describe, it, expect } from "vitest";
import {
  indexAvailableFonts,
  resolveFont,
  FontName,
} from "../../src/plugin/font-fallback.js";

const AVAILABLE: FontName[] = [
  { family: "Inter", style: "Regular" },
  { family: "Inter", style: "Bold" },
  { family: "Roboto", style: "Regular" },
  { family: "Helvetica Neue", style: "Regular" },
];

describe("resolveFont", () => {
  const index = indexAvailableFonts(AVAILABLE);

  it("returns requested when available, no substitution", () => {
    const r = resolveFont({ family: "Inter", style: "Bold" }, index);
    expect(r.substituted).toBe(false);
    expect(r.resolvedFont).toEqual({ family: "Inter", style: "Bold" });
    expect(r.reason).toBeUndefined();
  });

  it("substitutes style within same family when style missing", () => {
    const r = resolveFont({ family: "Inter", style: "Italic" }, index);
    expect(r.substituted).toBe(true);
    expect(r.resolvedFont.family).toBe("Inter");
    expect(r.resolvedFont.style).toBe("Regular");
    expect(r.reason).toMatch(/Italic/);
  });

  it("falls back requested → Inter when family missing", () => {
    const r = resolveFont({ family: "Comic Sans", style: "Regular" }, index);
    expect(r.substituted).toBe(true);
    expect(r.resolvedFont.family).toBe("Inter");
    expect(r.reason).toMatch(/unavailable/);
  });

  it("falls back to Roboto when Inter also missing", () => {
    const idx = indexAvailableFonts([
      { family: "Roboto", style: "Regular" },
      { family: "Arial", style: "Regular" },
    ]);
    const r = resolveFont({ family: "Comic Sans", style: "Regular" }, idx);
    expect(r.resolvedFont.family).toBe("Roboto");
  });

  it("uses first available when no preferred fonts exist", () => {
    const idx = indexAvailableFonts([{ family: "Arial", style: "Bold" }]);
    const r = resolveFont({ family: "Comic Sans", style: "Regular" }, idx);
    expect(r.substituted).toBe(true);
    expect(r.resolvedFont.family).toBe("arial");
  });

  it("empty font list → echoes request", () => {
    const idx = indexAvailableFonts([]);
    const r = resolveFont({ family: "X", style: "Regular" }, idx);
    expect(r.resolvedFont).toEqual({ family: "X", style: "Regular" });
    expect(r.substituted).toBe(false);
  });
});
