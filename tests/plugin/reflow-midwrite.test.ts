import { beforeEach, describe, expect, it, vi } from "vitest";
import { createUserflow } from "../../src/plugin/handlers/userflow.js";
import { createActivity } from "../../src/plugin/handlers/activity.js";
import { createErd } from "../../src/plugin/handlers/erd.js";
import { createSequence } from "../../src/plugin/handlers/sequence.js";
import { createState } from "../../src/plugin/handlers/state.js";
import { createSitemap } from "../../src/plugin/handlers/sitemap.js";
import { reflowAnyFrame } from "../../src/plugin/diagram-reflow.js";
import { scanBoxes } from "../../src/plugin/diagram-apply.js";
import { makeContext } from "../../src/plugin/context.js";
import { buildUserflow } from "../../src/shared/userflow/index.js";
import { buildActivity } from "../../src/shared/activity/index.js";
import { buildErd } from "../../src/shared/erd/index.js";
import { buildSequence } from "../../src/shared/sequence/index.js";
import { buildState } from "../../src/shared/state/index.js";
import { buildSitemap } from "../../src/shared/sitemap/index.js";

/**
 * One badly-timed re-route must never gut a diagram.
 *
 * A diagram's lines are appended BEFORE its boxes so they sit under them, and
 * `parent` counts as a geometry change — so `nodechange` fires during the
 * append and the live watcher can run a pass in the window where the lines
 * exist and the boxes do not. Every reflow read that emptiness as "all the
 * boxes were deleted" and hid every line on the diagram. Nothing further
 * changed, so no later pass ever brought them back: the drawing stayed gutted
 * until somebody redrew it.
 *
 * Seen on a real canvas, on a sitemap, after a redraw — five of six lines came
 * back `visible: false` with their points intact. All seven kinds draw in that
 * order, so all seven had the window. This file is the gate for all of them.
 */

let page: any;
let seq = 0;

function base(id: string, type: string): any {
  const n: any = {
    id, type, name: "", x: 0, y: 0, width: 100, height: 100,
    visible: true, removed: false, opacity: 1, rotation: 0,
    fills: [], strokes: [], strokeWeight: 1, strokeAlign: "CENTER",
    strokeCap: "NONE", strokeJoin: "MITER", dashPattern: [], effects: [],
    cornerRadius: 0, clipsContent: false, children: [], vectorPaths: [],
    caps: [] as string[], characters: "", fontName: { family: "Inter", style: "Regular" },
    fontSize: 12, textAutoResize: "NONE", reactions: [],
    pluginData: {} as Record<string, string>,
    resize(w: number, h: number) { this.width = w; this.height = h; },
    appendChild(c: any) { this.children.push(c); c.parent = this; },
    insertChild(i: number, c: any) { this.children.splice(i, 0, c); c.parent = this; },
    setBoundVariable: vi.fn(),
    getPluginData(key: string) { return this.pluginData[key] ?? ""; },
    setPluginData(key: string, value: string) { this.pluginData[key] = value; },
    setVectorNetworkAsync: async function (net: any) {
      this.vectorNetwork = net;
      this.vectorPaths = [{ windingRule: "NONE", data: net.vertices.map((v: any, i: number) => `${i ? "L" : "M"} ${v.x} ${v.y}`).join(" ") }];
      this.caps = net.vertices.map((v: any) => v.strokeCap);
    },
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((c: any) => c !== this); },
    setReactionsAsync: vi.fn(async function (this: any, r: unknown) { this.reactions = r; }),
  };
  if (type === "FRAME") n.layoutMode = "NONE";
  return n;
}

const ctx = (params: Record<string, unknown>) => makeContext(params, () => {});
const draw = (built: { draw: unknown }) => built.draw as unknown as Record<string, unknown>;

/**
 * Every kind, with the layer prefix its boxes are named with — the handle the
 * reflow finds them by, and what has to disappear to reproduce the window.
 */
const KINDS = [
  {
    kind: "userflow",
    prefixes: ["flow:"],
    create: createUserflow,
    data: () => draw(buildUserflow({
      title: "T",
      nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }],
      edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }],
    })),
  },
  {
    kind: "activity",
    prefixes: ["step:"],
    create: createActivity,
    data: () => draw(buildActivity({
      title: "T",
      lanes: [{ id: "l", label: "L" }],
      nodes: [
        { id: "s", label: "S", lane: "l", kind: "start" },
        { id: "a", label: "A", lane: "l" },
        { id: "e", label: "E", lane: "l", kind: "end" },
      ],
      edges: [{ from: "s", to: "a" }, { from: "a", to: "e" }],
    })),
  },
  {
    kind: "erd",
    prefixes: ["entity:"],
    create: createErd,
    data: () => draw(buildErd({
      title: "T",
      entities: [
        { id: "u", name: "users", attributes: [{ name: "id", type: "uuid", key: "pk" }] },
        { id: "b", name: "bookings", attributes: [{ name: "user_id", type: "uuid", key: "fk" }] },
      ],
      relations: [{ from: "u", to: "b", fromField: "id", toField: "user_id" }],
    })),
  },
  {
    kind: "sequence",
    prefixes: ["party:"],
    create: createSequence,
    data: () => draw(buildSequence({
      title: "T",
      participants: [{ id: "u", name: "U" }, { id: "s", name: "S" }],
      messages: [
        { id: "m1", from: "u", to: "s", label: "call" },
        { id: "m2", from: "s", to: "u", label: "reply", kind: "return" },
      ],
    })),
  },
  {
    kind: "state",
    prefixes: ["state:"],
    create: createState,
    data: () => draw(buildState({
      title: "T",
      text: `[*] -> draft: create\ndraft -> done: finish\ndone "Done" final`,
    })),
  },
  {
    kind: "sitemap",
    prefixes: ["page:"],
    create: createSitemap,
    data: () => draw(buildSitemap({
      title: "T",
      text: `root "Root"\n  a "A"\n  b "B"`,
    })),
  },
] as const;

beforeEach(() => {
  seq = 0;
  page = {
    id: "0:1", type: "PAGE", children: [] as any[],
    appendChild(n: any) { this.children.push(n); n.parent = this; },
    insertChild(i: number, n: any) { this.children.splice(i, 0, n); n.parent = this; },
    on: vi.fn(), off: vi.fn(),
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
    createEllipse: vi.fn(() => base(`60:${++seq}`, "ELLIPSE")),
    createLine: vi.fn(() => base(`70:${++seq}`, "LINE")),
  };
});

const linesOf = (frame: any): any[] =>
  frame.children.filter((c: any) => /^(edge|curve|arrow) /.test(c.name));

describe.each(KINDS)("$kind, caught mid-write", ({ kind, prefixes, create, data }) => {
  it("hides nothing when not one of its boxes is there yet", async () => {
    await (create as (c: never) => Promise<unknown>)(ctx(data()) as never);
    const frame = page.children[0];
    const before = linesOf(frame);
    expect(before.length, `${kind} drew no lines to protect`).toBeGreaterThan(0);

    // The window: the lines are appended, the boxes are not there yet.
    for (const child of [...frame.children]) {
      if (prefixes.some((p) => child.name.indexOf(p) === 0)) child.remove();
    }

    const report = await reflowAnyFrame(frame);
    expect(report, `${kind} has no reflow`).toBeTruthy();
    expect(report!.changed, `${kind} claimed something changed`).toBe(false);
    expect(report!.goneBoxes, `${kind} blamed deleted boxes`).toEqual([]);
    for (const line of linesOf(frame)) {
      expect(line.visible, `${kind}: ${line.name} was hidden mid-write`).toBe(true);
    }
  });
});

describe("scanBoxes, which all seven now share", () => {
  const frame = () => {
    const f = base("1:1", "FRAME");
    f.children.push({ ...base("1:2", "FRAME"), name: "box:a" });
    f.children.push({ ...base("1:3", "FRAME"), name: "box:b" });
    return f;
  };

  it("finds what is there and reports what is not", () => {
    const scan = scanBoxes(frame(), [{ id: "a" }, { id: "b" }, { id: "c" }], "box:");
    expect([...scan.placed.keys()].sort()).toEqual(["a", "b"]);
    expect(scan.goneBoxes).toEqual(["c"]);
    expect(scan.midWrite).toBe(false);
  });

  it("calls it mid-write only when NOT ONE was found", () => {
    // One missing among several is a deleted node and must still be reported;
    // finding none is evidence of something else entirely.
    expect(scanBoxes(frame(), [{ id: "a" }, { id: "zzz" }], "box:").midWrite).toBe(false);
    const none = scanBoxes(frame(), [{ id: "x" }, { id: "y" }], "box:");
    expect(none.midWrite).toBe(true);
    // And it blames nobody, so a caller that ignores `midWrite` still cannot
    // report a deletion that did not happen.
    expect(none.goneBoxes).toEqual([]);
  });

  it("says nothing about an empty graph", () => {
    expect(scanBoxes(frame(), [], "box:").midWrite).toBe(false);
  });

  it("takes a per-node prefix, for a kind whose boxes are not all alike", () => {
    const f = base("2:1", "FRAME");
    f.children.push({ ...base("2:2", "FRAME"), name: "uc:book" });
    f.children.push({ ...base("2:3", "FRAME"), name: "actor:v" });
    const scan = scanBoxes(
      f,
      [{ id: "book", shape: "uc" }, { id: "v", shape: "actor" }],
      (n) => (n.shape === "uc" ? "uc:" : "actor:"),
    );
    expect([...scan.placed.keys()].sort()).toEqual(["book", "v"]);
    expect(scan.midWrite).toBe(false);
  });
});
