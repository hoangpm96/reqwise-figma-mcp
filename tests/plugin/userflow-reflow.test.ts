import { beforeEach, describe, expect, it, vi } from "vitest";
import { createUserflow } from "../../src/plugin/handlers/userflow.js";
import { reflowDiagram } from "../../src/plugin/handlers/diagram.js";
import { reflowFrame } from "../../src/plugin/userflow-reflow.js";
import { installDiagramLive } from "../../src/plugin/diagram-live.js";
import { makeContext } from "../../src/plugin/context.js";
import { buildUserflow } from "../../src/shared/userflow/index.js";

/**
 * Arrows that follow their boxes. The drawing is done by createUserflow, then
 * a box is moved the way a designer moves it and the arrows have to catch up —
 * in the reflow op, and live from a nodechange event.
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
    setReactionsAsync: vi.fn(async function (this: any, r: unknown) {
      this.reactions = r;
    }),
  };
  if (type === "FRAME") n.layoutMode = "NONE";
  return n;
}

/** The real layout pass, so the drawn frame carries a real stored graph. */
function drawData(over: Record<string, unknown> = {}) {
  const built = buildUserflow({
    title: "Auth",
    nodes: [
      { id: "signin", label: "Sign in", screenId: "1.2" },
      { id: "ok", label: "Home", cls: "happy", screenId: "1.1" },
      { id: "bad", label: "Wrong password", cls: "error" },
    ],
    edges: [
      { from: "signin", to: "ok", label: "valid" },
      { from: "signin", to: "bad", label: "invalid" },
      { from: "bad", to: "signin", label: "retry", kind: "return" },
    ],
    ...over,
  });
  return built.draw as unknown as Record<string, unknown>;
}

const ctx = (params: Record<string, unknown>) => makeContext(params, () => {});

const layer = (frame: any, name: string): any =>
  frame.children.find((c: any) => c.name === name);

/** The last point of a drawn line, in frame coordinates — where its head is. */
function tipOf(line: any): [number, number] {
  const pts = [...String(line.vectorPaths[0]?.data ?? "").matchAll(/[ML]\s*(-?[\d.]+)\s+(-?[\d.]+)/g)];
  const last = pts[pts.length - 1]!;
  return [Number(last[1]) + line.x, Number(last[2]) + line.y];
}

/** Node-local path data of a drawn layer, plus where it sits in the frame. */
function pathOf(frame: any, name: string): string {
  const l = layer(frame, name);
  return `${l.x},${l.y} ${l.vectorPaths[0]?.data ?? ""}`;
}

function boxOf(frame: any, id: string): any {
  return frame.children.find((c: any) => c.name.indexOf(`flow:${id}`) === 0);
}

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
    off(type: string, cb: (e: any) => void) {
      if (type === "nodechange") pageListeners = pageListeners.filter((f) => f !== cb);
    },
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

describe("reflowFrame", () => {
  it("re-routes every arrow touching a box that moved", async () => {
    await createUserflow(ctx(drawData()));
    const frame = page.children[0];
    const before = pathOf(frame, "edge signin->ok");
    const untouched = pathOf(frame, "edge bad->signin");

    const box = boxOf(frame, "ok");
    box.x += 260;
    box.y += 180;
    const report = (await reflowFrame(frame))!;

    expect(report.routed).toBe(3);
    expect(pathOf(frame, "edge signin->ok")).not.toBe(before);
    // The head is a cap on the line's LAST point, so the line reaching the box
    // is the head following.
    const line = layer(frame, "edge signin->ok");
    expect(tipOf(line)[0]).toBeGreaterThan(box.x - 20);
    expect(line.caps[line.caps.length - 1]).toBe("ARROW_EQUILATERAL");
    // A return edge routed in a gutter moves as well: the gutter is measured
    // from the widest box, which just changed.
    expect(pathOf(frame, "edge bad->signin")).not.toBe(untouched);
  });

  it("takes the label along", async () => {
    await createUserflow(ctx(drawData()));
    const frame = page.children[0];
    const label = frame.children.find((c: any) => c.name === "label signin->ok");
    const was = { x: label.x, y: label.y };

    boxOf(frame, "ok").y += 300;
    await reflowFrame(frame);

    expect(label.y).toBeGreaterThan(was.y);
  });

  it("grows the frame when a box is dragged past its edge, and never shrinks", async () => {
    await createUserflow(ctx(drawData()));
    const frame = page.children[0];
    const was = { w: frame.width, h: frame.height };

    boxOf(frame, "ok").x += 500;
    await reflowFrame(frame);
    expect(frame.width).toBeGreaterThan(was.w);

    const grown = frame.width;
    boxOf(frame, "ok").x -= 500;
    await reflowFrame(frame);
    expect(frame.width).toBe(grown);
  });

  it("hides the arrows of a deleted box, and brings them back when it returns", async () => {
    await createUserflow(ctx(drawData()));
    const frame = page.children[0];
    const box = boxOf(frame, "bad");
    frame.children = frame.children.filter((c: any) => c !== box);

    const gone = (await reflowFrame(frame))!;
    expect(gone.goneBoxes).toEqual(["bad"]);
    const line = frame.children.find((c: any) => c.name === "edge signin->bad");
    expect(line.visible).toBe(false);
    expect(gone.hidden).toBeGreaterThan(0);

    frame.children.push(box);
    const back = (await reflowFrame(frame))!;
    expect(back.goneBoxes).toEqual([]);
    expect(line.visible).toBe(true);
  });

  it("leaves an arrow the user hid by hand hidden", async () => {
    await createUserflow(ctx(drawData()));
    const frame = page.children[0];
    const line = frame.children.find((c: any) => c.name === "edge signin->ok");
    line.visible = false;

    boxOf(frame, "ok").y += 120;
    await reflowFrame(frame);

    expect(line.visible).toBe(false);
  });

  it("re-centres a decision's question, which is a sibling of the diamond", async () => {
    await createUserflow(
      ctx(
        drawData({
          nodes: [
            { id: "signin", label: "Sign in" },
            { id: "q", label: "Password correct?", kind: "decision" },
            { id: "ok", label: "Home", cls: "happy" },
            { id: "bad", label: "Error", cls: "error" },
          ],
          edges: [
            { from: "signin", to: "q" },
            { from: "q", to: "ok", label: "yes" },
            { from: "q", to: "bad", label: "no" },
          ],
        }),
      ),
    );
    const frame = page.children[0];
    const diamond = boxOf(frame, "q");
    const text = frame.children.find((c: any) => c.name === "q q");
    text.width = 90;
    text.height = 20;

    diamond.x += 200;
    await reflowFrame(frame);

    expect(text.x).toBe(Math.round(diamond.x + diamond.width / 2 - 45));
  });

  it("says nothing to do for a frame with no stored graph", async () => {
    await createUserflow(ctx(drawData()));
    const frame = page.children[0];
    frame.setPluginData("reqwise.userflow", JSON.stringify({ title: "Auth", nodes: [], screens: {} }));
    expect(await reflowFrame(frame)).toBeNull();
  });
});

describe("reflow_diagram op", () => {
  it("finds the flow from any layer inside it", async () => {
    const drawn = (await createUserflow(ctx(drawData()))) as any;
    const frame = page.children[0];
    boxOf(frame, "ok").x += 100;

    const res = (await reflowDiagram(ctx({ frameId: drawn.nodes.ok }))) as any;
    expect(res.frames).toHaveLength(1);
    expect(res.frames[0]).toMatchObject({ frameId: frame.id, routed: 3 });
  });

  it("reflows every userflow on the page when no frame is named", async () => {
    await createUserflow(ctx(drawData()));
    await createUserflow(ctx(drawData({ title: "Second" })));
    const res = (await reflowDiagram(ctx({}))) as any;
    expect(res.frames).toHaveLength(2);
  });

  it("refuses a node that is not part of a diagram", async () => {
    await createUserflow(ctx(drawData()));
    const stray = base("9:9", "FRAME");
    page.appendChild(stray);
    await expect(reflowDiagram(ctx({ frameId: "9:9" }))).rejects.toThrow(/not part of a diagram/);
  });

  it("reports a page with no drawn flow at all", async () => {
    await expect(reflowDiagram(ctx({}))).rejects.toThrow(/No diagram on this page/);
  });

  it("warns instead of failing when the named flow predates the stored graph", async () => {
    const drawn = (await createUserflow(ctx(drawData()))) as any;
    const frame = page.children[0];
    // A frame drawn by 0.1.0: marked as a userflow, but with no graph to route.
    frame.setPluginData("reqwise.userflow", JSON.stringify({ title: "Auth", nodes: [], screens: {} }));

    const c = ctx({ frameId: drawn.frameId });
    const res = (await reflowDiagram(c)) as any;

    expect(res.frames).toEqual([]);
    expect(c.warnings.join(" ")).toContain("no stored routing graph");
  });
});

describe("live re-routing", () => {
  it("does nothing when the flow has just been drawn", async () => {
    // The live bug this pins down: the DRAW pass's own changes reach the
    // listener, and re-routing there threw away dagre's waypoints and stacked
    // two edge labels on top of each other on a diagram nobody had touched.
    await createUserflow(ctx(drawData()));
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

  it("re-routes from a nodechange when a box is dragged", async () => {
    await createUserflow(ctx(drawData()));
    installDiagramLive();
    expect(pageListeners).toHaveLength(1);

    const frame = page.children[0];
    const before = pathOf(frame, "edge signin->ok");
    const box = boxOf(frame, "ok");
    box.x += 200;
    pageListeners[0]!({
      nodeChanges: [{ type: "PROPERTY_CHANGE", node: box, properties: ["x"], origin: "LOCAL" }],
    });
    await settle();

    expect(pathOf(frame, "edge signin->ok")).not.toBe(before);
  });

  it("ignores changes that cannot move an arrow", async () => {
    await createUserflow(ctx(drawData()));
    installDiagramLive();
    const frame = page.children[0];
    const before = pathOf(frame, "edge signin->ok");
    const box = boxOf(frame, "ok");

    // A fill change, and a move of the whole diagram: neither changes where a
    // box sits relative to its arrows.
    box.x += 200;
    pageListeners[0]!({
      nodeChanges: [
        { type: "PROPERTY_CHANGE", node: box, properties: ["fills"], origin: "LOCAL" },
        { type: "PROPERTY_CHANGE", node: frame, properties: ["x"], origin: "LOCAL" },
      ],
    });
    await settle();

    expect(pathOf(frame, "edge signin->ok")).toBe(before);
  });

  it("respects a frame that opted out of live routing", async () => {
    await createUserflow(ctx(drawData({ options: { liveRoute: false } })));
    installDiagramLive();
    const frame = page.children[0];
    const before = pathOf(frame, "edge signin->ok");
    const box = boxOf(frame, "ok");

    box.y += 200;
    pageListeners[0]!({
      nodeChanges: [{ type: "PROPERTY_CHANGE", node: box, properties: ["y"], origin: "LOCAL" }],
    });
    await settle();

    expect(pathOf(frame, "edge signin->ok")).toBe(before);
    // …and the op still puts it right on demand.
    expect((await reflowFrame(frame))!.routed).toBe(3);
  });

  it("hides the arrows of a box the user deleted", async () => {
    await createUserflow(ctx(drawData()));
    installDiagramLive();
    const frame = page.children[0];
    const box = boxOf(frame, "bad");
    frame.children = frame.children.filter((c: any) => c !== box);

    pageListeners[0]!({
      nodeChanges: [{ type: "DELETE", node: { removed: true, id: box.id, type: "FRAME" }, origin: "LOCAL" }],
    });
    await settle();

    expect(frame.children.find((c: any) => c.name === "edge signin->bad").visible).toBe(false);
  });
});
