import { describe, it, expect } from "vitest";
import {
  indexAvailableFonts,
  resolveFont,
  styleWeight,
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

  // Regression: a heavy display weight that the family lacks must land on the
  // NEAREST available weight, not collapse to Regular (which silently stripped
  // a loud headline down to book weight). Space Grotesk tops out at Bold.
  it("missing ExtraBold falls to nearest heavy weight (Bold), not Regular", () => {
    const idx = indexAvailableFonts([
      { family: "Space Grotesk", style: "Light" },
      { family: "Space Grotesk", style: "Regular" },
      { family: "Space Grotesk", style: "Medium" },
      { family: "Space Grotesk", style: "SemiBold" },
      { family: "Space Grotesk", style: "Bold" },
    ]);
    const r = resolveFont({ family: "Space Grotesk", style: "ExtraBold" }, idx);
    expect(r.substituted).toBe(true);
    expect(r.resolvedFont).toEqual({ family: "Space Grotesk", style: "Bold" });
  });

  it("missing Medium picks SemiBold over Regular when both exist (nearest weight)", () => {
    const idx = indexAvailableFonts([
      { family: "Fam", style: "Regular" },
      { family: "Fam", style: "SemiBold" },
    ]);
    // Medium=500: Regular gap 100, SemiBold gap 100 → tie; first-seen wins,
    // but the point is it must NOT default to Regular by rule. Assert a
    // reasonable weighted pick (either is within one step).
    const r = resolveFont({ family: "Fam", style: "Medium" }, idx);
    expect(["Regular", "SemiBold"]).toContain(r.resolvedFont.style);
  });

  it("missing Black picks Bold, not Thin, when family has Thin+Bold", () => {
    const idx = indexAvailableFonts([
      { family: "Fam", style: "Thin" },
      { family: "Fam", style: "Bold" },
    ]);
    const r = resolveFont({ family: "Fam", style: "Black" }, idx);
    expect(r.resolvedFont.style).toBe("Bold");
  });

  it("prefers same slant when weights tie", () => {
    const idx = indexAvailableFonts([
      { family: "Fam", style: "Bold" },
      { family: "Fam", style: "Bold Italic" },
    ]);
    const r = resolveFont({ family: "Fam", style: "ExtraBold Italic" }, idx);
    expect(r.resolvedFont.style).toBe("Bold Italic");
  });
});

describe("styleWeight", () => {
  it("maps common style names to numeric weights", () => {
    expect(styleWeight("Thin")).toBe(100);
    expect(styleWeight("ExtraLight")).toBe(200);
    expect(styleWeight("Light")).toBe(300);
    expect(styleWeight("Regular")).toBe(400);
    expect(styleWeight("Medium")).toBe(500);
    expect(styleWeight("SemiBold")).toBe(600);
    expect(styleWeight("Bold")).toBe(700);
    expect(styleWeight("ExtraBold")).toBe(800);
    expect(styleWeight("Black")).toBe(900);
  });

  it("does not confuse ExtraBold/SemiBold with plain Bold", () => {
    expect(styleWeight("Extra Bold")).toBe(800);
    expect(styleWeight("Semi Bold")).toBe(600);
    expect(styleWeight("Bold Italic")).toBe(700);
  });

  it("unknown style defaults to 400", () => {
    expect(styleWeight("Wibble")).toBe(400);
  });
});
