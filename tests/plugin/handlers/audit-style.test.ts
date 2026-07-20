import { describe, expect, it } from "vitest";
import { styleWarningsFor } from "../../../src/plugin/handlers/audit.js";

function solid(hex = { r: 1, g: 1, b: 1 }): SolidPaint {
  return { type: "SOLID", color: hex };
}

function fakeFrame(
  overrides: Record<string, unknown> = {},
): SceneNode {
  return {
    id: String(overrides.id ?? "1:1"),
    name: String(overrides.name ?? "Card"),
    type: "FRAME",
    x: 0,
    y: 0,
    width: 320,
    height: 160,
    visible: true,
    fills: [solid()],
    strokes: [],
    cornerRadius: 16,
    layoutMode: "VERTICAL",
    paddingLeft: 16,
    paddingRight: 16,
    paddingTop: 16,
    paddingBottom: 16,
    children: [{ id: "1:2", name: "Content", type: "TEXT", x: 16, y: 16, width: 100, height: 24, visible: true }],
    parent: { id: "0:1", type: "FRAME" },
    ...overrides,
  } as unknown as SceneNode;
}

describe("layout audit style warnings", () => {
  it("does not treat a transparent structural frame as an error", () => {
    const node = fakeFrame({ name: "Header wrapper", fills: [], strokes: [] });
    expect(styleWarningsFor(node, [node])).toEqual([]);
  });

  it("flags a visible semantic surface with no radius", () => {
    const node = fakeFrame({ name: "Card / Account", cornerRadius: 0 });
    expect(styleWarningsFor(node, [node]).join(" ")).toContain("cornerRadius 0");
  });

  it("flags a radius that differs from similar siblings", () => {
    const a = fakeFrame({ id: "1:1", name: "Card 1", cornerRadius: 0 });
    const b = fakeFrame({ id: "1:2", name: "Card 2", cornerRadius: 16 });
    const c = fakeFrame({ id: "1:3", name: "Card 3", cornerRadius: 16 });
    expect(styleWarningsFor(a, [a, b, c]).join(" ")).toContain("similar siblings");
  });

  it("flags large visible content containers with tight padding", () => {
    const node = fakeFrame({
      name: "Card / Tight",
      paddingLeft: 4,
      paddingRight: 4,
      paddingTop: 4,
      paddingBottom: 4,
    });
    expect(styleWarningsFor(node, [node]).join(" ")).toContain("only 4px");
  });

  it("accepts comfortable card padding", () => {
    const node = fakeFrame();
    expect(styleWarningsFor(node, [node]).join(" ")).not.toContain("container edge");
  });

  it("does not require padding on the root screen", () => {
    const node = fakeFrame({
      name: "Screen / Login",
      paddingLeft: 0,
      paddingRight: 0,
      paddingTop: 0,
      paddingBottom: 0,
      parent: { id: "0:0", type: "PAGE" },
    });
    expect(styleWarningsFor(node, [node]).join(" ")).not.toContain("container edge");
  });

  it("does not ask intentional hug-width text to stretch", () => {
    const parent = { id: "0:1", type: "FRAME", layoutMode: "VERTICAL" };
    const text = {
      id: "1:1",
      name: "Eyebrow",
      type: "TEXT",
      width: 72,
      height: 16,
      layoutAlign: "MIN",
      fills: [solid({ r: 0, g: 0, b: 0 })],
      parent,
    } as unknown as SceneNode;
    const wide = fakeFrame({
      id: "1:2",
      name: "Content",
      width: 320,
      layoutAlign: "STRETCH",
      parent,
      fills: [],
    });
    expect(styleWarningsFor(text, [text, wide]).join(" ")).not.toContain("STRETCH");
  });

  it("still flags a narrow layout container among stretched siblings", () => {
    const parent = { id: "0:1", type: "FRAME", layoutMode: "VERTICAL" };
    const narrow = fakeFrame({
      id: "1:1",
      name: "Form group",
      width: 100,
      layoutAlign: "MIN",
      parent,
      fills: [],
    });
    const wide = fakeFrame({
      id: "1:2",
      name: "Content group",
      width: 320,
      layoutAlign: "STRETCH",
      parent,
      fills: [],
    });
    expect(styleWarningsFor(narrow, [narrow, wide]).join(" ")).toContain("STRETCH");
  });
});
