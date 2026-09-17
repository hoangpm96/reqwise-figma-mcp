import { describe, it, expect } from "vitest";
import {
  resolveGeometry,
  needsParent,
  resolveInsertIndex,
  overflowsParent,
  wrapLineHeight,
  defaultLineHeight,
  round,
  normalizePadding,
  resolveUniformCornerRadius,
  usesTransparentContainerDefault,
  boxesOverlap,
} from "../../src/plugin/layout-math.js";

describe("resolveGeometry", () => {
  const parent = { w: 400, h: 300 };

  it("passes through explicit x/y/w/h", () => {
    expect(resolveGeometry({ x: 10, y: 20, w: 100, h: 50 }, parent)).toEqual({
      x: 10,
      y: 20,
      w: 100,
      h: 50,
    });
  });

  it("two-sided horizontal inset stretches width", () => {
    const b = resolveGeometry({ inset: { left: 16, right: 16 }, h: 40 }, parent);
    expect(b.x).toBe(16);
    expect(b.w).toBe(400 - 32);
    expect(b.h).toBe(40);
  });

  it("two-sided vertical inset stretches height", () => {
    const b = resolveGeometry({ inset: { top: 8, bottom: 8 }, w: 40 }, parent);
    expect(b.y).toBe(8);
    expect(b.h).toBe(300 - 16);
  });

  it("single right inset pins the right edge keeping width", () => {
    const b = resolveGeometry({ inset: { right: 20 }, w: 100, h: 30 }, parent);
    expect(b.x).toBe(400 - 20 - 100);
  });

  it("single bottom inset pins the bottom keeping height", () => {
    const b = resolveGeometry({ inset: { bottom: 10 }, w: 50, h: 60 }, parent);
    expect(b.y).toBe(300 - 10 - 60);
  });

  it("center-x centers horizontally", () => {
    const b = resolveGeometry({ w: 100, h: 40, align: "center-x" }, parent);
    expect(b.x).toBe(150);
  });

  it("center-y centers vertically", () => {
    const b = resolveGeometry({ w: 100, h: 40, align: "center-y" }, parent);
    expect(b.y).toBe(130);
  });

  it("center centers both axes", () => {
    const b = resolveGeometry({ w: 100, h: 40, align: "center" }, parent);
    expect(b.x).toBe(150);
    expect(b.y).toBe(130);
  });

  it("two-sided inset wins over align on that axis", () => {
    const b = resolveGeometry(
      { inset: { left: 0, right: 0 }, h: 40, align: "center" },
      parent,
    );
    expect(b.x).toBe(0);
    expect(b.w).toBe(400);
    // vertical still centered
    expect(b.y).toBe(130);
  });
});

describe("needsParent", () => {
  it("true for align", () => {
    expect(needsParent({ align: "center" })).toBe(true);
  });
  it("true for any inset key", () => {
    expect(needsParent({ inset: { left: 4 } })).toBe(true);
  });
  it("false for plain xywh", () => {
    expect(needsParent({ x: 1, y: 2, w: 3, h: 4 })).toBe(false);
  });
});

describe("resolveInsertIndex", () => {
  const ids = ["a", "b", "c"]; // 0=bottom, 2=top

  it("undefined → append (top)", () => {
    expect(resolveInsertIndex(undefined, ids)).toBe(3);
  });
  it("top → end", () => {
    expect(resolveInsertIndex("top", ids)).toBe(3);
  });
  it("bottom → 0", () => {
    expect(resolveInsertIndex("bottom", ids)).toBe(0);
  });
  it("numeric clamps", () => {
    expect(resolveInsertIndex(1, ids)).toBe(1);
    expect(resolveInsertIndex(99, ids)).toBe(3);
    expect(resolveInsertIndex(-5, ids)).toBe(0);
  });
  it("above node → after it", () => {
    expect(resolveInsertIndex({ above: "b" }, ids)).toBe(2);
  });
  it("below node → at its index", () => {
    expect(resolveInsertIndex({ below: "b" }, ids)).toBe(1);
  });
  it("above missing node → append", () => {
    expect(resolveInsertIndex({ above: "zzz" }, ids)).toBe(3);
  });
});

describe("overflowsParent", () => {
  const parent = { w: 100, h: 100 };
  it("inside → false", () => {
    expect(overflowsParent({ x: 0, y: 0, w: 100, h: 100 }, parent)).toBe(false);
  });
  it("overflow right → true", () => {
    expect(overflowsParent({ x: 50, y: 0, w: 60, h: 10 }, parent)).toBe(true);
  });
  it("negative origin → true", () => {
    expect(overflowsParent({ x: -1, y: 0, w: 10, h: 10 }, parent)).toBe(true);
  });
});

describe("defaultLineHeight (size-aware)", () => {
  it("loosens small/body text and tightens as size grows", () => {
    expect(defaultLineHeight(12)).toBe(round(12 * 1.45)); // small
    expect(defaultLineHeight(16)).toBe(24); // body 1.5×
    expect(defaultLineHeight(20)).toBe(27); // subhead 1.35×
    expect(defaultLineHeight(32)).toBe(40); // title 1.25×
    expect(defaultLineHeight(48)).toBe(round(48 * 1.15)); // display 1.15×
    expect(defaultLineHeight(64)).toBe(round(64 * 1.05)); // hero 1.05×
  });
  it("ratio is non-increasing from body size up (the anti-'AI tell' property)", () => {
    // Small text (≤14px) is intentionally a touch tighter than body so it stays
    // readable — matching Tailwind (14px≈1.43 < 16px=1.5). From body (16px) up,
    // the ratio only shrinks, which is what keeps large headings from looking loose.
    const sizes = [16, 18, 20, 24, 32, 48, 64];
    let prev = Infinity;
    for (const s of sizes) {
      const ratio = defaultLineHeight(s) / s;
      expect(ratio).toBeLessThanOrEqual(prev + 1e-9);
      prev = ratio;
    }
    // Display is far tighter than body — the property that actually matters.
    expect(defaultLineHeight(48) / 48).toBeLessThan(defaultLineHeight(16) / 16);
  });
  it("wrapLineHeight is a back-compat alias of defaultLineHeight", () => {
    expect(wrapLineHeight(16)).toBe(defaultLineHeight(16));
    expect(wrapLineHeight(48)).toBe(defaultLineHeight(48));
  });
});

describe("normalizePadding", () => {
  it("expands a uniform padding number", () => {
    expect(normalizePadding({ padding: 16 })).toEqual({
      left: 16,
      right: 16,
      top: 16,
      bottom: 16,
    });
  });

  it("accepts padding objects", () => {
    expect(normalizePadding({ padding: { left: 12, right: 20, top: 8 } })).toEqual({
      left: 12,
      right: 20,
      top: 8,
    });
  });

  it("accepts Figma-native flat fields and lets them override padding", () => {
    expect(
      normalizePadding({
        padding: 10,
        paddingLeft: 24,
        paddingBottom: 18,
      }),
    ).toEqual({ left: 24, right: 10, top: 10, bottom: 18 });
  });
});

describe("container surface defaults", () => {
  it("makes FRAME/COMPONENT transparent only when fill is omitted", () => {
    expect(usesTransparentContainerDefault("FRAME", {})).toBe(true);
    expect(usesTransparentContainerDefault("COMPONENT", {})).toBe(true);
    expect(usesTransparentContainerDefault("FRAME", { fill: "#ffffff" })).toBe(false);
    expect(usesTransparentContainerDefault("FRAME", { fills: [] })).toBe(false);
    expect(usesTransparentContainerDefault("RECTANGLE", {})).toBe(false);
  });

  it("resolves common uniform radius aliases", () => {
    expect(resolveUniformCornerRadius({ cornerRadius: 16, borderRadius: 8 })).toBe(16);
    expect(resolveUniformCornerRadius({ borderRadius: 12 })).toBe(12);
    expect(resolveUniformCornerRadius({ radius: 10 })).toBe(10);
    expect(resolveUniformCornerRadius({})).toBeUndefined();
  });
});

describe("boxesOverlap", () => {
  const home = { x: 0, y: 0, w: 390, h: 844 };

  it("flags a component dropped at (0,0) over an existing screen", () => {
    // The exact trap: a new COMPONENT parented to the page defaults to (0,0)
    // and overlaps the Home screen already sitting there.
    const comp = { x: 0, y: 0, w: 342, h: 68 };
    expect(boxesOverlap(comp, home)).toBe(true);
  });

  it("does not flag a component parked in the negative-y DS strip", () => {
    const comp = { x: 0, y: -900, w: 342, h: 68 };
    expect(boxesOverlap(comp, home)).toBe(false);
  });

  it("does not flag boxes that merely touch edges", () => {
    const a = { x: 0, y: 0, w: 100, h: 100 };
    const b = { x: 100, y: 0, w: 100, h: 100 };
    expect(boxesOverlap(a, b)).toBe(false);
  });

  it("flags partial overlap", () => {
    const a = { x: 0, y: 0, w: 100, h: 100 };
    const b = { x: 50, y: 50, w: 100, h: 100 };
    expect(boxesOverlap(a, b)).toBe(true);
  });
});

describe("padding round-trip", () => {
  it("accepts the {l,r,t,b} shape a read hands back", () => {
    // serializeNode reports padding as {l,r,t,b}; feeding that straight back
    // into create/modify used to drop it silently, which is how an ERD's rows
    // came out with no padding and their text clipped.
    expect(normalizePadding({ padding: { l: 12, r: 12, t: 4, b: 4 } })).toEqual({
      left: 12,
      right: 12,
      top: 4,
      bottom: 4,
    });
  });

  it("still takes Figma's own spelling, and lets the flat fields win", () => {
    expect(normalizePadding({ padding: { left: 8, top: 2 } })).toEqual({ left: 8, top: 2 });
    expect(normalizePadding({ padding: { l: 8 }, paddingLeft: 20 })).toEqual({ left: 20 });
  });
});
