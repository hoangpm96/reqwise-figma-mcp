import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase E of the round-trip diet, plugin side: a diagram is ~250 layers, and
 * every one of them used to be serialized back into a JSON payload that the
 * handler then threw away. In the Figma sandbox each property read crosses
 * into the editor, so that is the part a throttled background tab taxes — the
 * 30s timeout we hit was 252 awaited serializations, not the drawing.
 */
vi.mock("../../../src/plugin/serialize.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../src/plugin/serialize.js")>();
  return { ...real, serializeNode: vi.fn(real.serializeNode) };
});

const { serializeNode } = await import("../../../src/plugin/serialize.js");
const { createActivity } = await import("../../../src/plugin/handlers/activity.js");
const { createTree } = await import("../../../src/plugin/handlers/create.js");
const { makeContext } = await import("../../../src/plugin/context.js");
const { buildActivity } = await import("../../../src/shared/activity/index.js");

let page: any;
let seq = 0;

function base(id: string, type: string): any {
  const n: any = {
    id, type, name: "", x: 0, y: 0, width: 100, height: 100,
    visible: true, opacity: 1, rotation: 0, fills: [], strokes: [], strokeWeight: 1,
    strokeAlign: "CENTER", strokeCap: "NONE", strokeJoin: "MITER", dashPattern: [],
    effects: [], cornerRadius: 0, clipsContent: false, children: [], vectorPaths: [],
    characters: "", fontName: { family: "Inter", style: "Regular" }, fontSize: 12,
    textAutoResize: "NONE", reactions: [], pluginData: {} as Record<string, string>,
    async setVectorNetworkAsync(net: any) { this.vectorNetwork = net; },
    resize(w: number, h: number) { this.width = w; this.height = h; },
    appendChild(c: any) { this.children.push(c); c.parent = this; },
    insertChild(i: number, c: any) { this.children.splice(i, 0, c); c.parent = this; },
    setBoundVariable: vi.fn(),
    getPluginData(k: string) { return this.pluginData[k] ?? ""; },
    setPluginData(k: string, v: string) { this.pluginData[k] = v; },
    setReactionsAsync: vi.fn(async function (this: any, r: unknown) { this.reactions = r; }),
  };
  if (type === "FRAME") n.layoutMode = "NONE";
  return n;
}

beforeEach(() => {
  seq = 0;
  (serializeNode as any).mockClear();
  page = {
    id: "0:1", type: "PAGE", children: [] as any[],
    appendChild(n: any) { this.children.push(n); n.parent = this; },
    insertChild(i: number, n: any) { this.children.splice(i, 0, n); n.parent = this; },
  };
  (globalThis as any).figma = {
    currentPage: page,
    mixed: Symbol("mixed"),
    loadFontAsync: vi.fn(async () => {}),
    listAvailableFontsAsync: vi.fn(async () => [{ fontName: { family: "Inter", style: "Regular" } }]),
    getNodeByIdAsync: vi.fn(async (id: string) => {
      const walk = (nodes: any[]): any => {
        for (const n of nodes) {
          if (n.id === id) return n;
          const hit = n.children ? walk(n.children) : null;
          if (hit) return hit;
        }
        return null;
      };
      return id === "0:1" ? page : walk(page.children);
    }),
    createFrame: vi.fn(() => base(`10:${++seq}`, "FRAME")),
    createText: vi.fn(() => base(`20:${++seq}`, "TEXT")),
    createVector: vi.fn(() => base(`30:${++seq}`, "VECTOR")),
    createPolygon: vi.fn(() => base(`40:${++seq}`, "POLYGON")),
    createRectangle: vi.fn(() => base(`50:${++seq}`, "RECTANGLE")),
    createEllipse: vi.fn(() => base(`60:${++seq}`, "ELLIPSE")),
    createLine: vi.fn(() => base(`70:${++seq}`, "LINE")),
  };
});

const draw = () =>
  buildActivity({
    title: "Approval",
    lanes: [
      { id: "a", label: "Requester" },
      { id: "b", label: "Manager" },
    ],
    nodes: [
      { id: "s", label: "Need", kind: "start", lane: "a" },
      { id: "draft", label: "Draft it", lane: "a" },
      { id: "review", label: "Review it", lane: "b" },
      { id: "done", label: "Done", kind: "end", lane: "b" },
    ],
    edges: [
      { from: "s", to: "draft" },
      { from: "draft", to: "review", label: "the draft" },
      { from: "review", to: "done", label: "approved" },
    ],
  } as any).draw;

describe("drawing a diagram", () => {
  it("serializes nothing — not the layers, and not the frame either", async () => {
    const res = (await createActivity(makeContext(draw() as any, () => {}))) as any;
    const frame = page.children[0];

    expect(frame.children.length).toBeGreaterThan(10);
    // Zero. Every property `serializeNode` reads crosses into the editor, and
    // the handler reads none of them: it collects the ids off `frame.children`
    // afterwards. The frame used to cost one serialize plus a
    // `getNodeByIdAsync` to fetch the node we had just created; `createTree`
    // hands the live node straight back, so both are gone.
    expect((serializeNode as any).mock.calls.length).toBe(0);
    expect(res.frameId).toBe(frame.id);
    // The ids still come back for every step and lane.
    expect(Object.keys(res.nodes).sort()).toEqual(["done", "draft", "review", "s"]);
    expect(Object.keys(res.lanes).sort()).toEqual(["a", "b"]);
  });

  it("loads the four faces once for the whole diagram", async () => {
    await createActivity(makeContext(draw() as any, () => {}));
    expect((figma.loadFontAsync as any).mock.calls.length).toBeLessThanOrEqual(4);
  });
});

describe("createTree", () => {
  it("builds a nested subtree and hands back the live node, unserialized", async () => {
    const ctx = makeContext(
      {
        type: "FRAME",
        name: "card",
        width: 200,
        height: 100,
        fill: "#ffffff",
        children: [
          { type: "TEXT", name: "title", characters: "Hello" },
          { type: "FRAME", name: "row", children: [{ type: "TEXT", name: "deep", characters: "x" }] },
        ],
      },
      () => {},
    );
    const node = (await createTree(ctx)) as any;

    expect(node.type).toBe("FRAME");
    expect(node.children.map((c: any) => c.name)).toEqual(["title", "row"]);
    expect(node.children[1].children[0].name).toBe("deep");
    // Nothing on this path is serialized — three nodes, zero payloads.
    expect((serializeNode as any).mock.calls.length).toBe(0);
  });
});

describe("parent resolution", () => {
  it("looks the parent up once for the whole diagram, not once per layer", async () => {
    // `figma.getNodeByIdAsync` is a round trip INTO the editor. One per layer
    // is ~250 of them per diagram, and a throttled background tab turns that
    // into the 30s timeout we actually hit.
    await createActivity(makeContext(draw() as any, () => {}));
    const lookups = (figma.getNodeByIdAsync as any).mock.calls.length;
    const layers = page.children[0].children.length;
    expect(layers).toBeGreaterThan(10);
    expect(lookups, `${lookups} lookups for ${layers} layers`).toBeLessThanOrEqual(2);
  });

  it("uses the node it just made as the parent of its children", async () => {
    (figma.getNodeByIdAsync as any).mockClear();
    const ctx = makeContext(
      {
        type: "FRAME",
        name: "outer",
        width: 100,
        height: 100,
        children: [{ type: "FRAME", name: "inner", children: [{ type: "TEXT", characters: "x" }] }],
      },
      () => {},
    );
    await createTree(ctx);
    // Only the top-level parent (the page) is resolved.
    expect((figma.getNodeByIdAsync as any).mock.calls.length).toBeLessThanOrEqual(1);
  });
});
