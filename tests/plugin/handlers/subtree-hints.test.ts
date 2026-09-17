import { describe, it, expect } from "vitest";
import { subtreeStyleHints } from "../../../src/plugin/handlers/audit.js";

/**
 * Subtree-wide consistency hints: the "why does this look busy/flat/ungrouped"
 * signals a per-node pass can't see. Conservative — a normal screen stays quiet.
 */
describe("subtreeStyleHints", () => {
  it("stays quiet for a clean, systematic screen", () => {
    const fontSizes = [16, 16, 24, 14, 16, 32]; // 4 distinct
    const radii = [8, 12, 8, 12]; // 2 distinct
    const gaps = [8, 16, 24, 8]; // varied → grouped
    expect(subtreeStyleHints(fontSizes, radii, gaps)).toEqual([]);
  });

  it("flags too many distinct font sizes (busy typography)", () => {
    const fontSizes = [11, 13, 15, 16, 17, 19, 22, 28]; // 8 distinct
    const hints = subtreeStyleHints(fontSizes, [], []);
    expect(hints.join(" ")).toContain("distinct font sizes");
  });

  it("flags too many distinct radii", () => {
    const radii = [4, 6, 8, 10, 14]; // 5 distinct
    const hints = subtreeStyleHints([], radii, []);
    expect(hints.join(" ")).toContain("distinct radii");
  });

  it("flags uniform spacing (no grouping) when all gaps are identical", () => {
    const gaps = [16, 16, 16, 16, 16]; // all same, ≥4
    const hints = subtreeStyleHints([], [], gaps);
    expect(hints.join(" ")).toContain("uniform spacing");
  });

  it("does NOT flag uniform spacing with too few gaps to judge", () => {
    const gaps = [16, 16]; // only 2 — not enough signal
    expect(subtreeStyleHints([], [], gaps)).toEqual([]);
  });

  it("does NOT flag varied spacing (proper grouping)", () => {
    const gaps = [8, 8, 24, 24, 16]; // in-group vs between-group
    expect(subtreeStyleHints([], [], gaps)).toEqual([]);
  });
});
