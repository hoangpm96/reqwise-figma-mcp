import { beforeEach, describe, expect, it, vi } from "vitest";
import { createUserflow } from "../../../src/plugin/handlers/userflow.js";
import { makeContext } from "../../../src/plugin/context.js";
import { FLOW_MARKER, flowCoversScreen, nameMatchesScreenId, readFlowMarks } from "../../../src/plugin/flow-mark.js";

/**
 * The drawing half of the userflow. Two bugs here only showed up in a live
 * Figma run — a reactions object the API rejected, and a screenId matched by
 * plain substring — so both are pinned down here.
 */

let page: any;
let seq = 0;
/** Set to a message to reproduce the live failure: the Plugin API rejecting a reaction. */
let reactionsThrow: string | false = false;

function base(id: string, type: string): any {
  const n: any = {
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
    clipsContent: false,
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
    characters: "",
    fontName: { family: "Inter", style: "Regular" },
    fontSize: 12,
    textAutoResize: "NONE",
    reactions: [],
    pluginData: {} as Record<string, string>,
    resize(w: number, h: number) {
      this.width = w;
      this.height = h;
    },
    appendChild(c: any) {
      this.children.push(c);
      c.parent = this;
    },
    insertChild(i: number, c: any) {
      this.children.splice(i, 0, c);
      c.parent = this;
    },
    setBoundVariable: vi.fn(),
    getPluginData(key: string) {
      return this.pluginData[key] ?? "";
    },
    setPluginData(key: string, value: string) {
      this.pluginData[key] = value;
    },
    setReactionsAsync: vi.fn(async function (this: any, r: unknown) {
      if (reactionsThrow) throw new Error(reactionsThrow);
      this.reactions = r;
    }),
  };
  if (type === "FRAME") n.layoutMode = "NONE";
  return n;
}

/** A minimal draw-data payload: one screen box, one terminal box, one edge. */
function drawData(overrides: Record<string, unknown> = {}) {
  return {
    name: "Userflow · Test",
    title: "Test",
    subtitle: "",
    x: 0,
    y: 0,
    w: 400,
    h: 400,
    font: "Inter",
    linkScreens: false,
    boxes: [
      { id: "signin", name: "flow:signin", x: 10, y: 100, w: 140, h: 60, fill: "#ffffff", stroke: "#000f22", title: "Sign in", ref: "1.2 · sign-in", screenId: "1.2" },
      { id: "home", name: "flow:home", x: 10, y: 250, w: 140, h: 60, fill: "#ffffff", stroke: "#000f22", title: "Home", ref: "1.1 · home", screenId: "1.1" },
    ],
    diamonds: [],
    edges: [
      {
        id: "signin->home",
        points: [[80, 160], [80, 240]],
        head: [[80, 250], [76, 240], [84, 240]],
        color: "#000f22",
        dashed: false,
        label: { x: 60, y: 190, w: 40, h: 20, text: "ok", muted: false },
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  seq = 0;
  reactionsThrow = false;
  page = {
    id: "0:1",
    type: "PAGE",
    children: [] as any[],
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
  };
});

const ctx = (params: Record<string, unknown>) => makeContext(params, () => {});

describe("createUserflow", () => {
  it("maps every graph id to the node it drew, and tags the frame", async () => {
    const c = ctx(drawData());
    const res = (await createUserflow(c)) as any;

    expect(Object.keys(res.nodes).sort()).toEqual(["home", "signin"]);
    const frame = page.children[0];
    expect(res.frameId).toBe(frame.id);
    const mark = JSON.parse(frame.getPluginData(FLOW_MARKER));
    expect(mark.title).toBe("Test");
    expect(mark.screens).toEqual({ signin: "1.2", home: "1.1" });
  });

  it("loads each face once instead of per text node", async () => {
    await createUserflow(ctx(drawData()));
    const families = (figma.loadFontAsync as any).mock.calls.map((a: any[]) => a[0].family);
    expect(new Set(families)).toEqual(new Set(["Inter"]));
    expect(families.length).toBeLessThanOrEqual(4);
  });

  it("draws with the font the caller asked for", async () => {
    await createUserflow(ctx(drawData({ font: "Noto Sans KR" })));
    const families = (figma.loadFontAsync as any).mock.calls.map((a: any[]) => a[0].family);
    expect(families).toContain("Noto Sans KR");
  });

  it("links a screen box to the artboard whose name carries its screenId", async () => {
    const artboard = base("9:1", "FRAME");
    artboard.name = "1.2 · sign-in";
    page.children.push(artboard);

    const c = ctx(drawData({ linkScreens: true }));
    const res = (await createUserflow(c)) as any;

    expect(res.linkedScreens).toEqual({ "1.2": "9:1" });
    const box = await figma.getNodeByIdAsync(res.nodes.signin);
    expect((box as any).reactions[0].actions[0]).toMatchObject({
      type: "NODE",
      destinationId: "9:1",
      navigation: "NAVIGATE",
    });
    expect(c.warnings.join(" ")).toContain('"1.1"'); // the unmatched one is named
  });

  it("does not link 1.1 to an artboard called 11.10", async () => {
    const decoy = base("9:2", "FRAME");
    decoy.name = "11.10 · order-history";
    page.children.push(decoy);

    const c = ctx(drawData({ linkScreens: true }));
    const res = (await createUserflow(c)) as any;

    expect(res.linkedScreens).toEqual({});
    expect(c.warnings.join(" ")).toContain("found no artboard");
  });

  it("keeps the drawn userflow when the Figma API rejects a reaction", async () => {
    // Exactly the live failure: the drawing succeeded, linking threw, and the
    // whole op reported an error while a finished userflow sat on the canvas.
    const artboard = base("9:1", "FRAME");
    artboard.name = "1.2 · sign-in";
    page.children.push(artboard);
    reactionsThrow = "Cannot set reactions on this node";

    const c = ctx(drawData({ linkScreens: true }));
    const res = (await createUserflow(c)) as any;

    expect(res.frameId).toBeTruthy();
    expect(Object.keys(res.nodes)).toHaveLength(2);
    expect(c.warnings.join(" ")).toContain("linkScreens failed");
    expect(c.warnings.join(" ")).toContain("Cannot set reactions");
  });

  it("names Figma as the culprit when its prototype API is the thing that failed", async () => {
    const artboard = base("9:1", "FRAME");
    artboard.name = "1.2 · sign-in";
    page.children.push(artboard);
    reactionsThrow = "Unable to establish connection to Figma after 10 seconds.";

    const c = ctx(drawData({ linkScreens: true }));
    const res = (await createUserflow(c)) as any;

    expect(res.frameId).toBeTruthy();
    expect(c.warnings.join(" ")).toContain("Figma-side failure");
  });

  it("refuses a payload that is not laid-out draw data", async () => {
    await expect(createUserflow(ctx({ title: "raw graph", nodes: [] }))).rejects.toThrow(
      /laid-out draw data/,
    );
  });
});

describe("screenId matching", () => {
  it("matches a whole token only", () => {
    expect(nameMatchesScreenId("1.2 · sign-in", "1.2")).toBe(true);
    expect(nameMatchesScreenId("Screen 1.2", "1.2")).toBe(true);
    expect(nameMatchesScreenId("1.2 · sign-in", "sign-in")).toBe(true);
    expect(nameMatchesScreenId("11.10 · order-history", "1.1")).toBe(false);
    expect(nameMatchesScreenId("Screen 1.2.3", "1.2")).toBe(false);
    expect(nameMatchesScreenId("checkout", "check")).toBe(false);
    expect(nameMatchesScreenId("anything", "")).toBe(false);
  });
});

describe("flow marks", () => {
  it("reads the marker off a page and answers whether a screen is covered", () => {
    const flow = base("8:1", "FRAME");
    flow.name = "Userflow · Checkout";
    flow.setPluginData(
      FLOW_MARKER,
      JSON.stringify({ title: "Checkout", nodes: ["cart"], screens: { cart: "1.1" } }),
    );
    page.children.push(flow);

    const marks = readFlowMarks(page as any);
    expect(marks).toHaveLength(1);
    expect(marks[0]!.title).toBe("Checkout");
    expect(flowCoversScreen(marks, "1.1 · cart")).toBe(true);
    expect(flowCoversScreen(marks, "11.10 · other")).toBe(false);
  });

  it("treats an unreadable marker as 'a flow exists' rather than crashing", () => {
    const flow = base("8:2", "FRAME");
    flow.name = "Userflow · Broken";
    flow.setPluginData(FLOW_MARKER, "{not json");
    page.children.push(flow);
    expect(readFlowMarks(page as any)).toHaveLength(1);
  });
});
