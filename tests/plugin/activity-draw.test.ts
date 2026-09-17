import { beforeEach, describe, expect, it, vi } from "vitest";
import { createActivity } from "../../src/plugin/handlers/activity.js";
import { reflowActivityFrame } from "../../src/plugin/activity-reflow.js";
import { reflowDiagram } from "../../src/plugin/handlers/diagram.js";
import { installDiagramLive } from "../../src/plugin/diagram-live.js";
import { makeContext } from "../../src/plugin/context.js";
import { buildActivity } from "../../src/shared/activity/index.js";
import { ACTIVITY_MARKER } from "../../src/plugin/diagram-mark.js";

/**
 * Drawing a swimlane diagram and keeping it attached. The lane bands are the
 * background, the steps sit in them, and an arrow that is re-routed must move
 * without disturbing the layers it shares the frame with.
 */

let page: any;
let seq = 0;
let pageListeners: Array<(e: any) => void>;

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
    removed: false,
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
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter((c: any) => c !== this);
    },
    setReactionsAsync: vi.fn(),
  };
  if (type === "FRAME") n.layoutMode = "NONE";
  return n;
}

/** The real layout pass, so the drawn frame carries a real stored graph. */
function drawData(over: Record<string, unknown> = {}) {
  const built = buildActivity({
    title: "Purchase order approval",
    lanes: [
      { id: "req", label: "Requester" },
      { id: "mgr", label: "Manager" },
      { id: "fin", label: "Finance" },
    ],
    nodes: [
      { id: "s", label: "PO needed", kind: "start", lane: "req" },
      { id: "draft", label: "Draft PO", lane: "req" },
      { id: "review", label: "Review PO", lane: "mgr" },
      { id: "budget", label: "Within budget?", kind: "decision", lane: "mgr" },
      { id: "pay", label: "Release payment", lane: "fin", cls: "happy" },
      { id: "done", label: "PO closed", kind: "end", lane: "fin", cls: "happy" },
    ],
    edges: [
      { from: "s", to: "draft" },
      { from: "draft", to: "review", label: "submitted PO" },
      { from: "review", to: "budget" },
      { from: "budget", to: "pay", label: "yes" },
      { from: "pay", to: "done" },
    ],
    ...over,
  });
  return built.draw as unknown as Record<string, unknown>;
}

const ctx = (params: Record<string, unknown>) => makeContext(params, () => {});

const layer = (frame: any, name: string) => frame.children.find((c: any) => c.name === name);
const stepOf = (frame: any, id: string) =>
  frame.children.find((c: any) => c.name.indexOf(`step:${id}`) === 0);
const pathOf = (frame: any, name: string) => {
  const l = layer(frame, name);
  return `${l.x},${l.y} ${l.vectorPaths[0]?.data ?? ""}`;
};

/** The live pass writes asynchronously now; let its microtasks run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  seq = 0;
  pageListeners = [];
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
    on(type: string, cb: (e: any) => void) {
      if (type === "nodechange") pageListeners.push(cb);
    },
    off() {},
  };
  (globalThis as any).figma = {
    currentPage: page,
    mixed: Symbol("mixed"),
    on: vi.fn(),
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

describe("createActivity", () => {
  it("draws a band per lane and maps every step to the node it drew", async () => {
    const res = (await createActivity(ctx(drawData()))) as any;
    const frame = page.children[0];

    expect(res.frameId).toBe(frame.id);
    expect(Object.keys(res.lanes).sort()).toEqual(["fin", "mgr", "req"]);
    expect(Object.keys(res.nodes).sort()).toEqual(["budget", "done", "draft", "pay", "review", "s"]);
    const mark = JSON.parse(frame.getPluginData(ACTIVITY_MARKER));
    expect(mark.kind).toBe("activity");
    expect(mark.graph.lanes).toHaveLength(3);
  });

  it("paints the lanes behind the arrows and the steps in front of them", async () => {
    await createActivity(ctx(drawData()));
    const frame = page.children[0];
    const order = frame.children.map((c: any) => c.name);
    const band = order.findIndex((n: string) => n.indexOf("lane:") === 0);
    const arrow = order.findIndex((n: string) => n.indexOf("edge ") === 0);
    const step = order.findIndex((n: string) => n.indexOf("step:") === 0);
    expect(band).toBeLessThan(arrow);
    expect(arrow).toBeLessThan(step);
  });

  it("draws a decision as a polygon with its question as a sibling", async () => {
    await createActivity(ctx(drawData()));
    const frame = page.children[0];
    expect(stepOf(frame, "budget").type).toBe("POLYGON");
    expect(layer(frame, "text:budget").characters).toBe("Within budget?");
  });

  it("loads each font face once instead of per text node", async () => {
    await createActivity(ctx(drawData()));
    const families = (figma.loadFontAsync as any).mock.calls.map((a: any[]) => a[0].family);
    expect(new Set(families)).toEqual(new Set(["Inter"]));
    expect(families.length).toBeLessThanOrEqual(4);
  });

  it("does not mistake its own frame for a screen missing from the userflow", async () => {
    // `create` asks "was the userflow mapped before these screens?" for every
    // page-level frame. A diagram frame is not a screen, and a live run had it
    // warning about itself.
    const c = ctx(drawData());
    await createActivity(c);
    expect(c.warnings.join(" ")).not.toContain("userflow");
  });

  it("refuses draw data that is not laid out", async () => {
    await expect(createActivity(ctx({ title: "raw", nodes: [] }))).rejects.toThrow(
      /expects laid-out draw data/,
    );
  });
});

describe("reflowActivityFrame", () => {
  it("re-routes the arrows of a step that was dragged", async () => {
    await createActivity(ctx(drawData()));
    const frame = page.children[0];
    const before = pathOf(frame, "edge draft->review");

    const draft = stepOf(frame, "draft");
    draft.x += 30;
    draft.y += 10;
    const report = (await reflowActivityFrame(frame))!;

    expect(report.kind).toBe("activity");
    expect(report.changed).toBe(true);
    expect(report.routed).toBeGreaterThan(0);
    expect(pathOf(frame, "edge draft->review")).not.toBe(before);
  });

  it("does nothing at all until something moves", async () => {
    await createActivity(ctx(drawData()));
    const frame = page.children[0];
    const before = frame.children.map((c: any) => `${c.name}|${c.x},${c.y}`);

    const report = (await reflowActivityFrame(frame, { onlyIfMoved: true }))!;

    expect(report.changed).toBe(false);
    expect(report.routed).toBe(0);
    expect(frame.children.map((c: any) => `${c.name}|${c.x},${c.y}`)).toEqual(before);
  });

  it("reports a step dragged into another lane without rewriting the process", async () => {
    await createActivity(ctx(drawData()));
    const frame = page.children[0];
    const band = layer(frame, "lane:fin");
    const draft = stepOf(frame, "draft");
    draft.y = band.y + 20;

    const report = (await reflowActivityFrame(frame))!;

    expect(report.relaned).toEqual([{ id: "draft", from: "req", to: "fin" }]);
    const mark = JSON.parse(frame.getPluginData(ACTIVITY_MARKER));
    expect(mark.graph.nodes.find((n: any) => n.id === "draft").lane).toBe("req");
  });

  it("re-centres a decision's question when the diamond moves", async () => {
    await createActivity(ctx(drawData()));
    const frame = page.children[0];
    const diamond = stepOf(frame, "budget");
    const text = layer(frame, "text:budget");
    text.width = 100;
    text.height = 20;

    diamond.x += 120;
    await reflowActivityFrame(frame);

    expect(text.x).toBe(Math.round(diamond.x + diamond.width / 2 - 50));
  });

  it("hides the arrows of a deleted step", async () => {
    await createActivity(ctx(drawData()));
    const frame = page.children[0];
    const pay = stepOf(frame, "pay");
    frame.children = frame.children.filter((c: any) => c !== pay);

    const report = (await reflowActivityFrame(frame))!;

    expect(report.goneBoxes).toEqual(["pay"]);
    expect(layer(frame, "edge budget->pay").visible).toBe(false);
  });
});

describe("dragging an arrow's end in an activity diagram", () => {
  it("reconnects it through the face it was dropped on, and remembers", async () => {
    await createActivity(ctx(drawData()));
    const frame = page.children[0];
    const target = stepOf(frame, "review");
    const line = layer(frame, "edge draft->review");

    // Drop the arrow's end on the step's BOTTOM face.
    const pts = [...String(line.vectorPaths[0].data).matchAll(/[ML]\s*(-?[\d.]+)\s+(-?[\d.]+)/g)].map(
      (m: any) => [Number(m[1]) + line.x, Number(m[2]) + line.y] as [number, number],
    );
    pts[pts.length - 1] = [target.x + target.width / 2, target.y + target.height];
    const minX = Math.min(...pts.map((p) => p[0]));
    const minY = Math.min(...pts.map((p) => p[1]));
    line.x = minX;
    line.y = minY;
    line.vectorPaths = [
      {
        windingRule: "NONE",
        data: pts.map((p, i) => `${i ? "L" : "M"} ${p[0] - minX} ${p[1] - minY}`).join(" "),
      },
    ];

    const report = (await reflowActivityFrame(frame))!;

    expect(report.pinned).toEqual([]);
    const graph = JSON.parse(frame.getPluginData(ACTIVITY_MARKER)).graph;
    const edge = graph.edges.find((e: any) => e.from === "draft" && e.to === "review");
    expect(edge.toPort).toMatchObject({ side: "bottom" });
    expect(edge.portsByHand).toBe(true);
  });
});

describe("the reflow op and the live watcher cover both diagram kinds", () => {
  it("reflows an activity frame found from one of its steps", async () => {
    const drawn = (await createActivity(ctx(drawData()))) as any;
    const frame = page.children[0];
    stepOf(frame, "review").x += 40;

    const res = (await reflowDiagram(ctx({ frameId: drawn.nodes.review }))) as any;

    expect(res.frames).toHaveLength(1);
    expect(res.frames[0]).toMatchObject({ frameId: frame.id, kind: "activity", changed: true });
  });

  it("warns when a step was dragged out of its lane", async () => {
    await createActivity(ctx(drawData()));
    const frame = page.children[0];
    stepOf(frame, "draft").y = layer(frame, "lane:fin").y + 20;

    const c = ctx({});
    await reflowDiagram(c);

    expect(c.warnings.join(" ")).toContain("req → fin");
  });

  it("re-routes an activity diagram from a nodechange", async () => {
    await createActivity(ctx(drawData()));
    installDiagramLive();
    const frame = page.children[0];
    const before = pathOf(frame, "edge draft->review");
    const draft = stepOf(frame, "draft");

    draft.x += 60;
    pageListeners[0]!({
      nodeChanges: [{ type: "PROPERTY_CHANGE", node: draft, properties: ["x"], origin: "LOCAL" }],
    });
    await settle();

    expect(pathOf(frame, "edge draft->review")).not.toBe(before);
  });

  it("leaves a freshly drawn activity diagram alone", async () => {
    await createActivity(ctx(drawData()));
    installDiagramLive();
    const frame = page.children[0];
    const before = frame.children.map((c: any) => `${c.name}|${c.x},${c.y}|${c.vectorPaths[0]?.data ?? ""}`);

    pageListeners[0]!({
      nodeChanges: frame.children.map((node: any) => ({
        type: "PROPERTY_CHANGE",
        node,
        properties: ["x", "y", "width", "height"],
        origin: "LOCAL",
      })),
    });
    await settle();

    expect(frame.children.map((c: any) => `${c.name}|${c.x},${c.y}|${c.vectorPaths[0]?.data ?? ""}`)).toEqual(before);
  });
});
