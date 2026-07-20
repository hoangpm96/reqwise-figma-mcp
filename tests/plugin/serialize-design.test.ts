import { beforeAll, describe, expect, it } from "vitest";
import { serializeNode } from "../../src/plugin/serialize.js";

beforeAll(() => {
  // serializeNode/plainValue consult figma.mixed; provide a minimal global.
  (globalThis as any).figma = { mixed: Symbol("mixed") };
});

// Raw Paint objects as the Figma plugin API returns them: full-precision float
// channels plus always-present default fields (visible:true, opacity:1,
// blendMode:"NORMAL"). The design serializer must compact these to hex +
// non-default fields only.
const RAW_SOLID = {
  type: "SOLID",
  visible: true,
  opacity: 1,
  blendMode: "NORMAL",
  color: { r: 0.06274509803921569, g: 0.09411764705882353, b: 0.15294117647058825 },
  boundVariables: {},
};

function rect(overrides: Record<string, unknown> = {}): any {
  return {
    id: "1:2",
    name: "Card",
    type: "RECTANGLE",
    x: 0,
    y: 0,
    width: 100,
    height: 40,
    visible: true,
    opacity: 1,
    fills: [RAW_SOLID],
    strokes: [],
    effects: [],
    ...overrides,
  };
}

describe("design-detail paint compaction", () => {
  it("compacts a solid fill to type+hex, dropping default visible/opacity/blendMode", () => {
    const out = serializeNode(rect(), "design");
    expect(out.fills).toEqual([{ type: "SOLID", hex: "#101827" }]);
  });

  it("omits empty strokes/effects arrays entirely", () => {
    const out = serializeNode(rect(), "design");
    expect(out).not.toHaveProperty("strokes");
    expect(out).not.toHaveProperty("effects");
  });

  it("keeps non-default paint fields: visible:false, opacity, blendMode, boundVariables", () => {
    const out = serializeNode(
      rect({
        fills: [
          {
            ...RAW_SOLID,
            visible: false,
            opacity: 0.5,
            blendMode: "MULTIPLY",
            boundVariables: { color: { type: "VARIABLE_ALIAS", id: "VariableID:1:23" } },
          },
        ],
      }),
      "design",
    );
    expect(out.fills).toEqual([
      {
        type: "SOLID",
        hex: "#101827",
        visible: false,
        opacity: 0.5,
        blendMode: "MULTIPLY",
        boundVariables: { color: { type: "VARIABLE_ALIAS", id: "VariableID:1:23" } },
      },
    ]);
  });

  it("compacts gradient stops to hex+pos and rounds the transform", () => {
    const out = serializeNode(
      rect({
        fills: [
          {
            type: "GRADIENT_LINEAR",
            visible: true,
            opacity: 1,
            blendMode: "NORMAL",
            gradientStops: [
              { position: 0, color: { r: 1, g: 1, b: 1, a: 1 } },
              { position: 0.6666666865348816, color: { r: 0, g: 0, b: 0, a: 0.5 } },
            ],
            gradientTransform: [
              [0.7071067811865476, -0.7071067811865476, 0],
              [0.7071067811865476, 0.7071067811865476, 0],
            ],
          },
        ],
      }),
      "design",
    );
    expect(out.fills).toEqual([
      {
        type: "GRADIENT_LINEAR",
        stops: [
          { hex: "#ffffffff", pos: 0 },
          { hex: "#00000080", pos: 0.67 },
        ],
        gradientTransform: [
          [0.71, -0.71, 0],
          [0.71, 0.71, 0],
        ],
      },
    ]);
  });

  it("keeps IMAGE paints as scaleMode+imageHash", () => {
    const out = serializeNode(
      rect({
        fills: [
          { type: "IMAGE", visible: true, opacity: 1, blendMode: "NORMAL", scaleMode: "FILL", imageHash: "abc123" },
        ],
      }),
      "design",
    );
    expect(out.fills).toEqual([{ type: "IMAGE", scaleMode: "FILL", imageHash: "abc123" }]);
  });

  it("passes figma.mixed fills through as 'mixed'", () => {
    const out = serializeNode(rect({ fills: (globalThis as any).figma.mixed }), "design");
    expect(out.fills).toBe("mixed");
  });

  it("compacts a drop shadow: hex color, rounded offset/radius, defaults dropped", () => {
    const out = serializeNode(
      rect({
        effects: [
          {
            type: "DROP_SHADOW",
            visible: true,
            blendMode: "NORMAL",
            color: { r: 0, g: 0, b: 0, a: 0.25 },
            offset: { x: 0, y: 4 },
            radius: 8,
            spread: 0,
          },
        ],
      }),
      "design",
    );
    expect(out.effects).toEqual([
      { type: "DROP_SHADOW", radius: 8, hex: "#00000040", offset: { x: 0, y: 4 } },
    ]);
  });
});

describe("design-detail typography compaction", () => {
  function text(overrides: Record<string, unknown> = {}): any {
    return {
      id: "1:3",
      name: "Label",
      type: "TEXT",
      x: 0,
      y: 0,
      width: 80,
      height: 20,
      visible: true,
      opacity: 1,
      characters: "Hello",
      textAutoResize: "WIDTH_AND_HEIGHT",
      fontSize: 16,
      fontName: { family: "Inter", style: "Medium" },
      lineHeight: { unit: "AUTO" },
      letterSpacing: { unit: "PERCENT", value: 0 },
      textCase: "ORIGINAL",
      textDecoration: "NONE",
      textAlignHorizontal: "LEFT",
      textAlignVertical: "TOP",
      fills: [RAW_SOLID],
      strokes: [],
      effects: [],
      ...overrides,
    };
  }

  it("emits only fontName+fontSize when everything else is at defaults", () => {
    const out = serializeNode(text(), "design");
    expect(out.typography).toEqual({
      fontName: { family: "Inter", style: "Medium" },
      fontSize: 16,
    });
  });

  it("keeps non-default line-height, spacing, case, decoration and alignment", () => {
    const out = serializeNode(
      text({
        lineHeight: { unit: "PIXELS", value: 24 },
        letterSpacing: { unit: "PERCENT", value: 2 },
        textCase: "UPPER",
        textDecoration: "UNDERLINE",
        textAlignHorizontal: "CENTER",
        textAlignVertical: "CENTER",
      }),
      "design",
    );
    expect(out.typography).toEqual({
      fontName: { family: "Inter", style: "Medium" },
      fontSize: 16,
      lineHeight: { unit: "PIXELS", value: 24 },
      letterSpacing: { unit: "PERCENT", value: 2 },
      textCase: "UPPER",
      textDecoration: "UNDERLINE",
      textAlignHorizontal: "CENTER",
      textAlignVertical: "CENTER",
    });
  });

  it("keeps mixed values as 'mixed' instead of dropping them as defaults", () => {
    const mixed = (globalThis as any).figma.mixed;
    const out = serializeNode(
      text({ fontSize: mixed, lineHeight: mixed, letterSpacing: mixed, textCase: mixed }),
      "design",
    );
    expect(out.typography).toMatchObject({
      lineHeight: "mixed",
      letterSpacing: "mixed",
      textCase: "mixed",
    });
  });
});
