import { beforeEach, describe, expect, it, vi } from "vitest";
import { createUserflow } from "../../src/plugin/handlers/userflow.js";
import { reflowDiagram } from "../../src/plugin/handlers/diagram.js";
import { reflowFrame } from "../../src/plugin/userflow-reflow.js";
import { makeContext } from "../../src/plugin/context.js";
import { buildUserflow } from "../../src/shared/userflow/index.js";

/**
 * What happens when a person edits an arrow, in two tiers.
 *
 *  - They drag its END somewhere: that is a CONNECTION POINT. It is written
 *    into the diagram's graph and the line is re-routed through it, so the
 *    arrow reconnects properly and still follows the boxes afterwards. This is
 *    the draw.io behaviour.
 *  - They change something else — a middle bend, the whole line parked
 *    elsewhere: nothing here can read that as an instruction, so it is left
 *    exactly as they left it and reported as pinned.
 */

let page: any;
let seq = 0;

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

function drawData() {
  const built = buildUserflow({
    title: "Auth",
    nodes: [
      { id: "signin", label: "Sign in" },
      { id: "ok", label: "Home", cls: "happy" },
      { id: "bad", label: "Wrong password", cls: "error" },
    ],
    edges: [
      { from: "signin", to: "ok", label: "valid" },
      { from: "signin", to: "bad", label: "invalid" },
    ],
  });
  return built.draw as unknown as Record<string, unknown>;
}

const ctx = (params: Record<string, unknown>) => makeContext(params, () => {});
const layer = (frame: any, name: string) => frame.children.find((c: any) => c.name === name);
const boxOf = (frame: any, id: string) =>
  frame.children.find((c: any) => c.name.indexOf(`flow:${id}`) === 0);
const pathOf = (frame: any, name: string) => {
  const l = layer(frame, name);
  return `${l.x},${l.y} ${l.vectorPaths[0]?.data ?? ""}`;
};

/** Points of a drawn line, in frame coordinates. */
function pointsOf(line: any): Array<[number, number]> {
  return [...String(line.vectorPaths[0]?.data ?? "").matchAll(/[ML]\s*(-?[\d.]+)\s+(-?[\d.]+)/g)].map(
    (m) => [Number(m[1]) + line.x, Number(m[2]) + line.y] as [number, number],
  );
}

/** Write a polyline back onto a line the way a Figma vector edit would. */
function setPointsByHand(frame: any, name: string, pts: Array<[number, number]>) {
  const l = layer(frame, name);
  const minX = Math.min(...pts.map((p) => p[0]));
  const minY = Math.min(...pts.map((p) => p[1]));
  l.x = minX;
  l.y = minY;
  l.vectorPaths = [
    {
      windingRule: "NONE",
      data: pts.map((p, i) => `${i ? "L" : "M"} ${p[0] - minX} ${p[1] - minY}`).join(" "),
    },
  ];
}

/** Drag the arrow's END onto a named face of its target box. */
function dragEndTo(frame: any, name: string, target: any, side: "top" | "left" | "bottom" | "right") {
  const pts = pointsOf(layer(frame, name));
  const at: Record<string, [number, number]> = {
    top: [target.x + target.width / 2, target.y],
    bottom: [target.x + target.width / 2, target.y + target.height],
    left: [target.x, target.y + target.height / 2],
    right: [target.x + target.width, target.y + target.height / 2],
  };
  pts[pts.length - 1] = at[side]!;
  setPointsByHand(frame, name, pts);
  return at[side]!;
}

/** Nudge a middle bend — an edit that says nothing about attachment. */
function nudgeMiddle(frame: any, name: string) {
  const pts = pointsOf(layer(frame, name));
  const mid = Math.max(1, Math.floor(pts.length / 2) - (pts.length > 2 ? 0 : 1));
  if (pts.length === 2) pts.splice(1, 0, [pts[0]![0] + 12, pts[0]![1] + 12]);
  else pts[mid] = [pts[mid]![0] + 24, pts[mid]![1]!];
  setPointsByHand(frame, name, pts);
  return pointsOf(layer(frame, name));
}

beforeEach(() => {
  seq = 0;
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
    on() {},
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

describe("dragging an arrow's end", () => {
  it("reconnects the line through the face it was dropped on", async () => {
    await createUserflow(ctx(drawData()));
    const frame = page.children[0];
    const box = boxOf(frame, "ok");
    const dropped = dragEndTo(frame, "edge signin->ok", box, "left");

    const report = (await reflowFrame(frame))!;

    expect(report.pinned).toEqual([]);
    const pts = pointsOf(layer(frame, "edge signin->ok"));
    const tip = pts[pts.length - 1]!;
    // It arrives on the face that was chosen…
    expect(tip[0]).toBeCloseTo(dropped[0], 0);
    // …and it arrives HEADING at it, so the head points into the box.
    expect(pts[pts.length - 2]![1]).toBeCloseTo(tip[1], 0);
    expect(pts[pts.length - 2]![0]).toBeLessThan(tip[0]);
  });

  it("remembers the connection point, so it survives the plugin closing", async () => {
    const drawn = (await createUserflow(ctx(drawData()))) as any;
    const frame = page.children[0];
    dragEndTo(frame, "edge signin->ok", boxOf(frame, "ok"), "left");
    await reflowFrame(frame);

    const graph = JSON.parse(frame.getPluginData("reqwise.userflow")).graph;
    const edge = graph.edges.find((e: any) => e.from === "signin" && e.to === "ok");
    expect(edge.toPort).toMatchObject({ side: "left" });
    expect(edge.portsByHand).toBe(true);
    expect(drawn.frameId).toBe(frame.id);
  });

  it("keeps following the boxes from the point that was chosen", async () => {
    await createUserflow(ctx(drawData()));
    const frame = page.children[0];
    const box = boxOf(frame, "ok");
    dragEndTo(frame, "edge signin->ok", box, "left");
    await reflowFrame(frame);

    box.x += 220;
    box.y += 90;
    await reflowFrame(frame);

    const pts = pointsOf(layer(frame, "edge signin->ok"));
    const tip = pts[pts.length - 1]!;
    // Still on the LEFT face, at the box's new position.
    expect(tip[0]).toBeCloseTo(box.x, 0);
    expect(tip[1]).toBeCloseTo(box.y + box.height / 2, 0);
  });

  it("puts it back under automatic routing on force", async () => {
    await createUserflow(ctx(drawData()));
    const frame = page.children[0];
    dragEndTo(frame, "edge signin->ok", boxOf(frame, "ok"), "left");
    await reflowFrame(frame);

    await reflowFrame(frame, { force: true });

    const graph = JSON.parse(frame.getPluginData("reqwise.userflow")).graph;
    const edge = graph.edges.find((e: any) => e.from === "signin" && e.to === "ok");
    expect(edge.toPort).toBeUndefined();
    expect(edge.portsByHand).toBeUndefined();
  });
});

describe("an edit that is not a connection point", () => {
  it("is left exactly as it was, and reported", async () => {
    await createUserflow(ctx(drawData()));
    const frame = page.children[0];
    const edited = nudgeMiddle(frame, "edge signin->ok");
    const other = pathOf(frame, "edge signin->bad");

    boxOf(frame, "bad").y += 60;
    const report = (await reflowFrame(frame))!;

    expect(report.pinned).toEqual(["signin->ok"]);
    expect(pointsOf(layer(frame, "edge signin->ok"))).toEqual(edited);
    expect(pathOf(frame, "edge signin->bad")).not.toBe(other);
  });

  it("is recognised even before the first re-route", async () => {
    // The draw pass stamps every arrow, so the very first drag cannot quietly
    // overwrite the tidy-up somebody did straight after the agent drew.
    await createUserflow(ctx(drawData()));
    const frame = page.children[0];
    const edited = nudgeMiddle(frame, "edge signin->ok");

    boxOf(frame, "ok").y += 100;
    await reflowFrame(frame);

    expect(pointsOf(layer(frame, "edge signin->ok"))).toEqual(edited);
  });

  it("follows its boxes again once the edit is undone", async () => {
    await createUserflow(ctx(drawData()));
    const frame = page.children[0];
    const line = layer(frame, "edge signin->ok");
    const original = JSON.parse(JSON.stringify(line.vectorPaths));
    const wasAt = { x: line.x, y: line.y };
    nudgeMiddle(frame, "edge signin->ok");
    line.vectorPaths = original; // Ctrl+Z
    line.x = wasAt.x;
    line.y = wasAt.y;

    boxOf(frame, "ok").y += 100;
    const report = (await reflowFrame(frame))!;

    expect(report.pinned).toEqual([]);
    expect(report.routed).toBe(2);
  });

  it("is re-routed anyway when force is asked for", async () => {
    await createUserflow(ctx(drawData()));
    const frame = page.children[0];
    const edited = nudgeMiddle(frame, "edge signin->ok");

    boxOf(frame, "ok").y += 100;
    const report = (await reflowFrame(frame, { force: true }))!;

    expect(report.pinned).toEqual([]);
    expect(pointsOf(layer(frame, "edge signin->ok"))).not.toEqual(edited);
  });

  it("keeps a label moved by hand, but still re-routes its arrow", async () => {
    await createUserflow(ctx(drawData()));
    const frame = page.children[0];
    const label = layer(frame, "label signin->ok");
    label.x += 40;
    label.y -= 25;
    const parked = { x: label.x, y: label.y };
    const line = pathOf(frame, "edge signin->ok");

    boxOf(frame, "ok").y += 120;
    const report = (await reflowFrame(frame))!;

    expect({ x: label.x, y: label.y }).toEqual(parked);
    expect(report.pinned).toEqual([]);
    expect(pathOf(frame, "edge signin->ok")).not.toBe(line);
  });

  it("does not treat an untracked diagram as hand-edited", async () => {
    // A frame drawn by a build with no tracking: every arrow still follows.
    await createUserflow(ctx(drawData()));
    const frame = page.children[0];
    for (const child of frame.children) child.pluginData = {};

    boxOf(frame, "ok").y += 80;
    const report = (await reflowFrame(frame))!;

    expect(report.pinned).toEqual([]);
    expect(report.routed).toBe(2);
  });
});

describe("the reflow op", () => {
  it("says which arrows it left alone and how to override", async () => {
    await createUserflow(ctx(drawData()));
    const frame = page.children[0];
    nudgeMiddle(frame, "edge signin->ok");
    boxOf(frame, "ok").x += 150;

    const c = ctx({});
    const res = (await reflowDiagram(c)) as any;

    expect(res.frames[0].pinned).toEqual(["signin->ok"]);
    const said = c.warnings.join(" ");
    expect(said).toContain("moved by hand");
    expect(said).toContain("force:true");
  });

  it("re-routes them on force", async () => {
    await createUserflow(ctx(drawData()));
    const frame = page.children[0];
    nudgeMiddle(frame, "edge signin->ok");
    boxOf(frame, "ok").x += 150;

    const res = (await reflowDiagram(ctx({ force: true }))) as any;
    expect(res.frames[0].pinned).toEqual([]);
    expect(res.frames[0].routed).toBe(2);
  });
});
