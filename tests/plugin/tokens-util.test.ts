import { describe, it, expect } from "vitest";
import { collectModes, normalizeColorValue } from "../../src/plugin/tokens-util.js";

describe("collectModes", () => {
  it("asks for NO mode when there are no per-mode values", () => {
    // It used to answer ["Mode 1"], and that sentinel read as a demand: the
    // caller sent plain hexes and was taken to be asking for a mode literally
    // named "Mode 1". Once the first mode had been renamed, the next plain-hex
    // call tried to ADD that name back — impossible on a single-mode plan.
    // Empty means "write whatever modes the collection already has".
    expect(collectModes({ primary: "#fff" })).toEqual([]);
  });
  it("collects modes from per-mode maps", () => {
    const m = collectModes({
      primary: { light: "#fff", dark: "#000" },
      accent: { light: "#f00" },
    });
    expect(m).toContain("light");
    expect(m).toContain("dark");
  });
});

describe("normalizeColorValue (multi-mode bug fix)", () => {
  it("single hex applies to every mode", () => {
    const v = normalizeColorValue("#ffffff", ["light", "dark"]);
    expect(v.light).toBe("#ffffff");
    expect(v.dark).toBe("#ffffff");
  });

  it("per-mode map sets each mode explicitly", () => {
    const v = normalizeColorValue({ light: "#fff", dark: "#000" }, ["light", "dark"]);
    expect(v.light).toBe("#fff");
    expect(v.dark).toBe("#000");
  });

  it("missing mode falls back to first value — NEVER left at default", () => {
    // dark not provided → must inherit light, not stay 0/undefined
    const v = normalizeColorValue({ light: "#abcdef" }, ["light", "dark"]);
    expect(v.light).toBe("#abcdef");
    expect(v.dark).toBe("#abcdef");
    expect(v.__default__).toBe("#abcdef");
  });

  it("extra collection mode still gets a value", () => {
    const v = normalizeColorValue({ light: "#111" }, ["light", "dark", "hc"]);
    expect(v.hc).toBe("#111");
  });
});
