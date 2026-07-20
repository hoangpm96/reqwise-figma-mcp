import { describe, it, expect } from "vitest";
import {
  resolveGeometry,
  needsParent,
  resolveInsertIndex,
  overflowsParent,
  wrapLineHeight,
  normalizePadding,
  resolveUniformCornerRadius,
  usesTransparentContainerDefault,
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

describe("wrapLineHeight", () => {
  it("1.45x", () => {
    expect(wrapLineHeight(16)).toBe(23.2);
    expect(wrapLineHeight(20)).toBe(29);
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
