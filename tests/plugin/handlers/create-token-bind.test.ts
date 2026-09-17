import { beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "../../../src/plugin/handlers/create.js";
import { makeContext } from "../../../src/plugin/context.js";

/**
 * Create-time design-token binding: `fill: "$token"`, `tokens: {field: name}`
 * and `textStyle: "Name"` bind variables/styles in the SAME create call.
 * Unknown names throw INVALID_PARAMS *before* any node is created — a typo
 * must not leave an orphan unstyled node on the canvas.
 */

function ctx(params: Record<string, unknown>) {
  return makeContext(params, () => {});
}

let page: any;
let variables: Record<string, any>;

function fakeFrame(): any {
  return {
    id: "10:1",
    type: "FRAME",
    name: "",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    visible: true,
    opacity: 1,
    layoutMode: "NONE",
    clipsContent: false,
    fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }],
    strokes: [],
    resize(w: number, h: number) {
      this.width = w;
      this.height = h;
    },
    setBoundVariable: vi.fn(),
  };
}

function fakeText(): any {
  return {
    id: "10:2",
    type: "TEXT",
    name: "",
    x: 0,
    y: 0,
    width: 40,
    height: 20,
    visible: true,
    opacity: 1,
    characters: "",
    fontName: { family: "Inter", style: "Regular" },
    fontSize: 16,
    textAlignHorizontal: "LEFT",
    textAlignVertical: "TOP",
    textAutoResize: "WIDTH_AND_HEIGHT",
    lineHeight: { unit: "AUTO" },
    textStyleId: "",
    fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }],
    strokes: [],
    resize(w: number, h: number) {
      this.width = w;
      this.height = h;
    },
    setBoundVariable: vi.fn(),
  };
}

beforeEach(() => {
  page = {
    id: "0:1",
    type: "PAGE",
    children: [],
    appendChild(n: any) {
      this.children.push(n);
      n.parent = this;
    },
    insertChild(i: number, n: any) {
      this.children.splice(i, 0, n);
      n.parent = this;
    },
  };
  variables = {
    v1: { id: "v1", name: "color/primary/500", resolvedType: "COLOR" },
    v2: { id: "v2", name: "radius/md", resolvedType: "FLOAT" },
  };
  (globalThis as any).figma = {
    currentPage: page,
    mixed: Symbol("mixed"),
    getNodeByIdAsync: vi.fn(async (id: string) => (id === "0:1" ? page : null)),
    createFrame: vi.fn(fakeFrame),
    createText: vi.fn(fakeText),
    listAvailableFontsAsync: vi.fn(async () => [
      { fontName: { family: "Inter", style: "Regular" } },
      { fontName: { family: "Inter", style: "Bold" } },
    ]),
    loadFontAsync: vi.fn(async () => {}),
    getLocalTextStylesAsync: vi.fn(async () => [
      {
        id: "S:11",
        name: "Title 02",
        fontName: { family: "Inter", style: "Bold" },
        fontSize: 30,
      },
    ]),
    variables: {
      getLocalVariableCollectionsAsync: vi.fn(async () => [
        { variableIds: Object.keys(variables) },
      ]),
      getVariableByIdAsync: vi.fn(async (id: string) => variables[id] ?? null),
      setBoundVariableForPaint: vi.fn((base: any, field: string, variable: any) => ({
        ...base,
        boundVariables: { [field]: { type: "VARIABLE_ALIAS", id: variable.id } },
      })),
    },
  };
});

describe("create with $token fill", () => {
  it('binds fill: "$color/primary/500" as a variable paint', async () => {
    const res: any = await create(
      ctx({ type: "FRAME", fill: "$color/primary/500", width: 100, height: 50 }),
    );
    const node = page.children[0];
    expect(node.fills).toHaveLength(1);
    expect(node.fills[0].boundVariables.color.id).toBe("v1");
    expect(res.id).toBe(node.id);
  });

  it("forces the bound paint visible+opaque (regression: COMPONENT default fill is visible:false)", async () => {
    // A freshly-created COMPONENT carries a default fill with visible:false.
    // Binding a token must NOT inherit that — the token was set yet nothing
    // showed. The base handed to setBoundVariableForPaint must be visible.
    (globalThis as any).figma.createComponent = vi.fn(() => {
      const n = fakeFrame();
      n.type = "COMPONENT";
      n.fills = [{ type: "SOLID", visible: false, color: { r: 1, g: 1, b: 1 } }];
      return n;
    });
    await create(ctx({ type: "COMPONENT", fill: "$color/primary/500" }));
    const node = page.children[0];
    expect(node.fills[0].visible).toBe(true);
    expect(node.fills[0].opacity).toBe(1);
    expect(node.fills[0].boundVariables.color.id).toBe("v1");
  });

  it("binds stroke tokens too", async () => {
    await create(ctx({ type: "FRAME", stroke: "$color/primary/500" }));
    const node = page.children[0];
    expect(node.strokes[0].boundVariables.color.id).toBe("v1");
  });

  it("expands tokens:{cornerRadius} to all four corner fields", async () => {
    await create(
      ctx({ type: "FRAME", fill: "#ffffff", tokens: { cornerRadius: "radius/md" } }),
    );
    const node = page.children[0];
    const fields = node.setBoundVariable.mock.calls.map((c: any[]) => c[0]);
    expect(fields).toEqual([
      "topLeftRadius",
      "topRightRadius",
      "bottomLeftRadius",
      "bottomRightRadius",
    ]);
    expect(node.setBoundVariable.mock.calls[0][1].id).toBe("v2");
  });

  it("accepts a leading $ inside the tokens map as well", async () => {
    await create(ctx({ type: "FRAME", tokens: { fill: "$color/primary/500" } }));
    const node = page.children[0];
    expect(node.fills[0].boundVariables.color.id).toBe("v1");
  });

  it("throws INVALID_PARAMS on an unknown token BEFORE creating the node", async () => {
    await expect(
      create(ctx({ type: "FRAME", fill: "$color/nope" })),
    ).rejects.toMatchObject({
      code: "INVALID_PARAMS",
      message: expect.stringContaining("color/nope"),
    });
    expect((globalThis as any).figma.createFrame).not.toHaveBeenCalled();
    expect(page.children).toHaveLength(0);
  });
});

describe("create TEXT with textStyle", () => {
  it("applies the style by name (textStyleId lands on the node)", async () => {
    await create(ctx({ type: "TEXT", text: "Dashboard", textStyle: "Title 02" }));
    const node = page.children[0];
    expect(node.textStyleId).toBe("S:11");
    expect(node.characters).toBe("Dashboard");
  });

  it("warns when textStyle and fontSize are both passed (style wins)", async () => {
    const c = ctx({
      type: "TEXT",
      text: "x",
      textStyle: "Title 02",
      fontSize: 99,
    });
    await create(c);
    expect(c.warnings.some((w) => w.includes("Title 02"))).toBe(true);
  });

  it("throws with candidates on an unknown style name, creating nothing", async () => {
    await expect(
      create(ctx({ type: "TEXT", text: "x", textStyle: "Caption" })),
    ).rejects.toMatchObject({
      code: "INVALID_PARAMS",
      hint: expect.stringContaining("Title 02"),
    });
    expect((globalThis as any).figma.createText).not.toHaveBeenCalled();
  });
});
