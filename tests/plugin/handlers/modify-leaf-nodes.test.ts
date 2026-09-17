import { beforeEach, describe, expect, it, vi } from "vitest";
import { modify } from "../../../src/plugin/handlers/write.js";
import { scanNodesByTypes, searchNodes } from "../../../src/plugin/handlers/read.js";
import { makeContext } from "../../../src/plugin/context.js";

/**
 * Leaf nodes (RECTANGLE, TEXT) through handlers written with frames in mind:
 * each of these returned ok-and-did-nothing, or threw INTERNAL, on a leaf.
 */

const ctx = (params: Record<string, unknown>) => makeContext(params, () => {});

let nodes: Record<string, any>;
let loadFontAsync: ReturnType<typeof vi.fn>;

function base(id: string, type: string): any {
  return { id, type, name: type.toLowerCase(), x: 0, y: 0, width: 10, height: 10, visible: true, parent: null };
}

beforeEach(() => {
  loadFontAsync = vi.fn(async () => {
    throw new Error("The font \"Brand Sans Regular\" could not be loaded");
  });
  const rect = { ...base("1:2", "RECTANGLE"), layoutAlign: "INHERIT", layoutGrow: 0, fills: [] };
  const text = {
    ...base("1:3", "TEXT"),
    layoutAlign: "INHERIT",
    characters: "Hello",
    fontName: { family: "Brand Sans", style: "Regular" },
    getRangeAllFontNames: () => [{ family: "Brand Sans", style: "Regular" }],
    fills: [],
  };
  nodes = { "1:2": rect, "1:3": text };
  (globalThis as any).figma = {
    mixed: Symbol("mixed"),
    getNodeByIdAsync: vi.fn(async (id: string) => nodes[id] ?? null),
    loadFontAsync,
    listAvailableFontsAsync: vi.fn(async () => []),
    currentPage: { id: "0:1", type: "PAGE", children: [], findAll: () => Object.values(nodes), findAllWithCriteria: () => Object.values(nodes) },
  };
});

describe("modify on a child of an auto-layout frame", () => {
  it("layoutAlign/layoutGrow reach a rectangle (it has no layoutMode)", async () => {
    await modify(ctx({ nodeId: "1:2", props: { layoutAlign: "STRETCH", layoutGrow: 1 } }));
    expect(nodes["1:2"].layoutAlign).toBe("STRETCH");
    expect(nodes["1:2"].layoutGrow).toBe(1);
  });
});

describe("modify on a text node whose font is not installed", () => {
  it("moving it does not need the font, and does not fail on it", async () => {
    await modify(ctx({ nodeId: "1:3", props: { x: 100 } }));
    expect(nodes["1:3"].x).toBe(100);
    expect(loadFontAsync).not.toHaveBeenCalled();
  });

  it("changing the characters still loads the font (and reports it)", async () => {
    await expect(modify(ctx({ nodeId: "1:3", props: { characters: "Bye" } }))).rejects.toThrow(/could not be loaded/);
  });
});

describe("reads scoped to a leaf", () => {
  it("scan_nodes_by_types returns nothing instead of throwing INTERNAL", async () => {
    await expect(scanNodesByTypes(ctx({ nodeId: "1:2", types: ["TEXT"] }))).resolves.toEqual({ count: 0, nodes: [] });
  });

  it("search_nodes returns nothing instead of searching the whole page", async () => {
    const res = (await searchNodes(ctx({ nodeId: "1:2", name: "text" }))) as any;
    expect(res.count).toBe(0);
  });
});
