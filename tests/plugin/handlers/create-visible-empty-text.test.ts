import { beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "../../../src/plugin/handlers/create.js";
import { loadNodeFonts } from "../../../src/plugin/fonts.js";
import { makeContext } from "../../../src/plugin/context.js";

/**
 * Two things a session building a real demo hit: `visible:false` on create was
 * ignored (top level and inside children[]), and filling an EMPTY text layer
 * threw from getRangeAllFontNames, aborting the write halfway.
 */

let seq = 0;
let page: any;
function node(type: string): any {
  const n: any = {
    id: `9:${++seq}`, type, name: "", x: 0, y: 0, width: 100, height: 100, visible: true,
    fills: [], strokes: [], effects: [], children: [], characters: "",
    fontName: { family: "Inter", style: "Regular" }, fontSize: 12, layoutMode: "NONE",
    resize(w: number, h: number) { this.width = w; this.height = h; },
    appendChild(c: any) { this.children.push(c); c.parent = this; },
    insertChild(i: number, c: any) { this.children.splice(i, 0, c); c.parent = this; },
    getPluginData: () => "", setPluginData: () => {}, setBoundVariable: vi.fn(),
    getRangeAllFontNames(start: number, end: number) {
      if (end > this.characters.length || start >= end) throw new Error("in getRangeAllFontNames: Range outside of available characters");
      return [this.fontName];
    },
  };
  return n;
}

beforeEach(() => {
  seq = 0;
  page = { id: "0:1", type: "PAGE", children: [] as any[], appendChild(n: any) { this.children.push(n); n.parent = this; }, insertChild(i: number, n: any) { this.children.splice(i, 0, n); n.parent = this; } };
  (globalThis as any).figma = {
    currentPage: page, mixed: Symbol("mixed"),
    loadFontAsync: vi.fn(async () => {}),
    listAvailableFontsAsync: vi.fn(async () => [{ fontName: { family: "Inter", style: "Regular" } }]),
    getNodeByIdAsync: vi.fn(async (id: string) => (id === "0:1" ? page : page.children.find((c: any) => c.id === id) ?? null)),
    createFrame: vi.fn(() => node("FRAME")), createRectangle: vi.fn(() => node("RECTANGLE")), createText: vi.fn(() => node("TEXT")),
  };
});

describe("create honours visible:false", () => {
  it("on the node itself and on a child in children[]", async () => {
    const res = (await create(makeContext({ type: "FRAME", name: "card", visible: false, children: [{ type: "RECTANGLE", name: "icon", visible: false }] } as any, () => {}))) as any;
    const frame = page.children.find((c: any) => c.id === res.id);
    expect(frame.visible).toBe(false);
    expect(frame.children[0].visible).toBe(false);
  });
});

describe("loadNodeFonts on an empty text layer", () => {
  it("loads its font instead of throwing on an empty range", async () => {
    const t = node("TEXT");
    await expect(loadNodeFonts(t)).resolves.toBeUndefined();
    expect((globalThis as any).figma.loadFontAsync).toHaveBeenCalled();
  });
});
