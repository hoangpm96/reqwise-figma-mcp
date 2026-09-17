import { beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "../../../src/plugin/handlers/create.js";
import { makeContext } from "../../../src/plugin/context.js";
import { FLOW_MARKER } from "../../../src/plugin/flow-mark.js";
import { serializeNode } from "../../../src/plugin/serialize.js";

/**
 * The drawing primitives a userflow (or any diagram) needs: real vector
 * polylines, a diamond, dashed strokes, arrow caps and rotation — all in ONE
 * create call. Each of these used to be silently dropped, which is why arrows
 * had to be faked with text glyphs and rotation needed a second round-trip.
 */

function ctx(params: Record<string, unknown>) {
  return makeContext(params, () => {});
}

let page: any;
let seq = 0;

function base(id: string, type: string): any {
  return {
    id,
    type,
    name: "",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    visible: true,
    opacity: 1,
    rotation: 0,
    fills: [],
    strokes: [],
    strokeWeight: 1,
    strokeAlign: "CENTER",
    strokeCap: "NONE",
    strokeJoin: "MITER",
    dashPattern: [],
    effects: [],
    cornerRadius: 0,
    children: [],
    vectorPaths: [],
    setVectorNetworkAsync: async function (net: any) {
      // Mirror Figma: the network becomes the node's path data.
      this.vectorNetwork = net;
      this.vectorPaths = [
        {
          windingRule: "NONE",
          data: net.vertices.map((v: any, i: number) => `${i ? "L" : "M"} ${v.x} ${v.y}`).join(" "),
        },
      ];
      this.caps = net.vertices.map((v: any) => v.strokeCap);
    },
    pointCount: 3,
    resize(w: number, h: number) {
      this.width = w;
      this.height = h;
    },
    setBoundVariable: vi.fn(),
    getPluginData: vi.fn(() => ""),
    setPluginData: vi.fn(),
  };
}

function frame(id: string): any {
  const n = base(id, "FRAME");
  n.layoutMode = "NONE";
  n.clipsContent = false;
  n.appendChild = function (c: any) {
    this.children.push(c);
    c.parent = this;
  };
  n.insertChild = function (i: number, c: any) {
    this.children.splice(i, 0, c);
    c.parent = this;
  };
  return n;
}

beforeEach(() => {
  seq = 0;
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
  (globalThis as any).figma = {
    currentPage: page,
    mixed: Symbol("mixed"),
    getNodeByIdAsync: vi.fn(async (id: string) =>
      id === "0:1" ? page : page.children.find((c: any) => c.id === id) ?? null,
    ),
    createFrame: vi.fn(() => frame(`10:${++seq}`)),
    createVector: vi.fn(() => base(`30:${++seq}`, "VECTOR")),
    createPolygon: vi.fn(() => base(`40:${++seq}`, "POLYGON")),
    createLine: vi.fn(() => {
      const n = base(`50:${++seq}`, "LINE");
      n.height = 0;
      return n;
    }),
    createRectangle: vi.fn(() => base(`60:${++seq}`, "RECTANGLE")),
  };
});

const made = () => page.children[page.children.length - 1];

describe("VECTOR", () => {
  it("turns parent-space points into a local path plus an x/y offset", async () => {
    await create(ctx({ type: "VECTOR", points: [[100, 50], [100, 90], [180, 90]] }));
    const v = made();
    expect(v.vectorPaths).toEqual([{ windingRule: "NONE", data: "M 0 0 L 0 40 L 80 40" }]);
    expect(v.x).toBe(100);
    expect(v.y).toBe(50);
  });

  it("closes and fills a path when closed:true (an arrow head)", async () => {
    await create(
      ctx({ type: "VECTOR", points: [[10, 0], [0, 10], [20, 10]], closed: true, fill: "#ff0000" }),
    );
    expect(made().vectorPaths[0].data.endsWith("Z")).toBe(true);
    expect(made().vectorPaths[0].windingRule).toBe("NONZERO");
    expect(made().fills[0].color.r).toBeCloseTo(1);
  });

  it("accepts {x,y} points as well as pairs", async () => {
    await create(ctx({ type: "VECTOR", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] }));
    expect(made().vectorPaths[0].data).toBe("M 0 0 L 10 0");
  });

  it("warns instead of drawing a one-point path", async () => {
    const c = ctx({ type: "VECTOR", points: [[1, 1]] });
    await create(c);
    expect(c.warnings.join(" ")).toContain("two");
    expect(made().vectorPaths).toEqual([]);
  });

  it("warns when points are passed to a node type that cannot use them", async () => {
    const c = ctx({ type: "RECTANGLE", points: [[0, 0], [1, 1]] });
    await create(c);
    expect(c.warnings.join(" ")).toContain('type:"VECTOR"');
  });
});

describe("POLYGON, strokes and rotation", () => {
  it("makes a diamond with pointCount 4", async () => {
    await create(ctx({ type: "POLYGON", pointCount: 4, width: 120, height: 60 }));
    expect(made().pointCount).toBe(4);
    expect(made().width).toBe(120);
    expect(made().height).toBe(60);
  });

  it("applies dashPattern, strokeCap, strokeJoin and strokeAlign on create", async () => {
    await create(
      ctx({
        type: "VECTOR",
        points: [[0, 0], [10, 0]],
        dashPattern: [6, 4],
        strokeCap: "ARROW_LINES",
        strokeJoin: "ROUND",
        strokeAlign: "CENTER",
        strokes: "#000000",
      }),
    );
    expect(made().dashPattern).toEqual([6, 4]);
    expect(made().strokeCap).toBe("ARROW_LINES");
    expect(made().strokeJoin).toBe("ROUND");
  });

  it("applies rotation in the same call that creates the node", async () => {
    await create(ctx({ type: "RECTANGLE", width: 40, height: 40, rotation: 45 }));
    expect(made().rotation).toBe(45);
  });

  it("gives a LINE the width it was asked for instead of Figma's 100px", async () => {
    await create(ctx({ type: "LINE", width: 240 }));
    expect(made().width).toBe(240);
    expect(made().height).toBe(0);
  });
});

describe("userflow awareness", () => {
  const screen = { type: "FRAME", width: 390, height: 844, x: 0, y: 0, fill: "#ffffff" };

  it("asks for the flow first when the page has none", async () => {
    const c = ctx({ ...screen, name: "Home" });
    await create(c);
    expect(c.warnings.join(" ")).toContain("ASK THE USER");
    // Name the tool that exists: the hint said `figma_userflow` for nine
    // commits after that tool became figma_diagram type:"userflow".
    expect(c.warnings.join(" ")).toContain('figma_diagram type:"userflow"');
  });

  it("asks to update the existing flow when the new screen is not in it", async () => {
    const flow = frame("9:9");
    flow.name = "Userflow · Checkout";
    flow.getPluginData = vi.fn((key: string) =>
      key === FLOW_MARKER ? JSON.stringify({ title: "Checkout", nodes: ["cart"], screens: { cart: "1.1" } }) : "",
    );
    page.children.push(flow);

    const c = ctx({ ...screen, name: "2.7 · Order history" });
    await create(c);
    // And point at the in-place redraw, not at "call it again and delete the
    // old frame" — `update` + `patch` keeps the frame's id.
    expect(c.warnings.join(" ")).toContain("figma_diagram with update");
    expect(c.warnings.join(" ")).toContain("patch");
  });

  it("stays quiet when the screen is already in the flow", async () => {
    const flow = frame("9:9");
    flow.name = "Userflow · Checkout";
    flow.getPluginData = vi.fn((key: string) =>
      key === FLOW_MARKER ? JSON.stringify({ title: "Checkout", nodes: ["cart"], screens: { cart: "1.1" } }) : "",
    );
    page.children.push(flow);

    const c = ctx({ ...screen, name: "1.1 · Cart" });
    await create(c);
    expect(c.warnings.some((w) => w.includes("userflow"))).toBe(false);
  });

  it("says nothing for small nodes and nested children", async () => {
    const c = ctx({ type: "FRAME", width: 200, height: 80, name: "Button", x: 0, y: 0 });
    await create(c);
    expect(c.warnings.some((w) => w.includes("userflow"))).toBe(false);
  });
});

describe("a drawn line reads back", () => {
  it("reports its points in parent coordinates", async () => {
    // Without this an agent asked to move an arrow's connection point has no
    // way to see where the arrow currently is.
    const c = ctx({
      type: "VECTOR",
      name: "edge a->b",
      points: [
        [40, 100],
        [40, 160],
        [200, 160],
      ],
      strokes: "#000f22",
      endArrow: true,
    });
    const res = (await create(c)) as any;
    const node = await figma.getNodeByIdAsync(res.id);

    expect(serializeNode(node!, "full").points).toEqual([
      [40, 100],
      [40, 160],
      [200, 160],
    ]);
  });

  it("puts the arrow head on the line's last point, as a cap", async () => {
    const c = ctx({
      type: "VECTOR",
      name: "edge a->b",
      points: [
        [0, 0],
        [60, 0],
      ],
      endArrow: true,
    });
    const res = (await create(c)) as any;
    const node = (await figma.getNodeByIdAsync(res.id)) as any;
    expect(node.vectorNetwork.vertices.map((v: any) => v.strokeCap)).toEqual([
      "NONE",
      "ARROW_EQUILATERAL",
    ]);
  });
});
