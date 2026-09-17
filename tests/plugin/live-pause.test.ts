import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installDiagramLive, pauseLive, resumeLive, liveIsPaused } from "../../src/plugin/diagram-live.js";
import { HANDLERS } from "../../src/plugin/handlers/registry.js";
import { createSitemap } from "../../src/plugin/handlers/sitemap.js";
import { makeContext } from "../../src/plugin/context.js";
import { buildSitemap } from "../../src/shared/sitemap/index.js";

/**
 * Closing the window rather than surviving it.
 *
 * The live re-router reacts to our OWN writes — unavoidable, since a re-route
 * is itself a write — and survives them because a second pass finds every box
 * where it was and does nothing. That idempotence is the entire safety
 * argument, and it is false while a frame is half-populated: the lines are
 * appended before the boxes so they sit under them, so a pass landing in that
 * window sees lines and no boxes.
 *
 * `scanBoxes` makes the consequence harmless. This holds the pass until the
 * frame is whole, so it does not happen at all — and because changes are still
 * QUEUED while held, a person dragging a box during a draw is answered a
 * moment later rather than ignored.
 */

let page: any;
let seq = 0;
let pageListeners: Array<(e: any) => void>;

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
    remove() { this.removed = true; if (this.parent) this.parent.children = this.parent.children.filter((c: any) => c !== this); },
    setReactionsAsync: vi.fn(),
  };
  if (type === "FRAME") n.layoutMode = "NONE";
  return n;
}

const ctx = (params: Record<string, unknown>) => makeContext(params, () => {});
const drawData = () =>
  buildSitemap({ title: "T", text: `root "Root"\n  a "A"\n  b "B"` }).draw as unknown as Record<string, unknown>;

const settle = () => new Promise((r) => setTimeout(r, 0));
const boxOf = (frame: any, id: string) =>
  frame.children.find((c: any) => c.name.indexOf(`page:${id}`) === 0);
const pathOf = (frame: any, name: string): string => {
  const l = frame.children.find((c: any) => c.name === name);
  return `${l.x},${l.y} ${l.vectorPaths[0]?.data ?? ""}`;
};

/** What Figma hands the listener when a box has moved. */
const moved = (node: any) => ({
  nodeChanges: [{ type: "PROPERTY_CHANGE", node, properties: ["x", "y"] }],
});

beforeEach(() => {
  seq = 0;
  pageListeners = [];
  page = {
    id: "0:1", type: "PAGE", children: [] as any[],
    appendChild(n: any) { this.children.push(n); n.parent = this; },
    insertChild(i: number, n: any) { this.children.splice(i, 0, n); n.parent = this; },
    on(type: string, cb: (e: any) => void) { if (type === "nodechange") pageListeners.push(cb); },
    off(type: string, cb: (e: any) => void) { pageListeners = pageListeners.filter((f) => f !== cb); },
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

describe("the live pass is held while a diagram is being written", () => {
  it("does not re-route at all while paused", async () => {
    await createSitemap(ctx(drawData()));
    const frame = page.children[0];
    installDiagramLive();
    const before = pathOf(frame, "edge root->a");

    pauseLive();
    boxOf(frame, "a").x -= 200;
    for (const cb of pageListeners) cb(moved(boxOf(frame, "a")));
    await settle();
    expect(pathOf(frame, "edge root->a"), "routed while paused").toBe(before);

    // Nothing was DROPPED, though — the change was queued, and letting go
    // answers it. A person dragging during a draw still gets their re-route.
    resumeLive();
    await settle();
    expect(pathOf(frame, "edge root->a")).not.toBe(before);
  });

  it("counts, so a batch of draws cannot release it early", async () => {
    expect(liveIsPaused()).toBe(false);
    pauseLive();
    pauseLive();
    resumeLive();
    expect(liveIsPaused(), "the inner draw released the outer one").toBe(true);
    resumeLive();
    expect(liveIsPaused()).toBe(false);
  });

  it("never goes negative, so a stray release cannot disable the guard", () => {
    resumeLive();
    resumeLive();
    pauseLive();
    expect(liveIsPaused()).toBe(true);
    resumeLive();
    expect(liveIsPaused()).toBe(false);
  });
});

describe("every op that rewrites a diagram is wrapped", () => {
  const DRAWS = [
    "create_userflow", "create_activity", "create_erd", "create_sequence",
    "create_state", "create_sitemap",
    "reflow_diagram",
  ] as const;

  it("is wrapped in the registry for every one of them", async () => {
    // Asserted against the SOURCE, the way the marker list is: the wrapper is
    // invisible from outside (a wrapped handler is still just a function), and
    // the failure mode is a new kind shipping unwrapped, which nothing else
    // would notice. Wrapped in the registry rather than the dispatcher because
    // a handler is called from three places — the op path, the `batch` loop
    // and the direct message path — and a guard remembered in three places
    // gets missed in one.
    const src = readFileSync(
      join(import.meta.dirname, "../../src/plugin/handlers/registry.ts"),
      "utf8",
    );
    for (const op of DRAWS) {
      expect(src, `${op} is not wrapped in whileDrawing`).toMatch(
        new RegExp(`\\b${op}:\\s*whileDrawing\\(`),
      );
    }
  });

  it("releases even when the handler throws", async () => {
    expect(liveIsPaused()).toBe(false);
    await expect(
      HANDLERS.create_sitemap(ctx({ pages: "not an array" })),
    ).rejects.toThrow();
    expect(liveIsPaused(), "a throwing draw left live routing switched off").toBe(false);
  });

  it("holds it during a real draw, and lets go after", async () => {
    let pausedDuring: boolean | null = null;
    const d = drawData();
    // Sampled from inside the write itself: every node the draw makes comes
    // through here, so the first one tells us whether the guard was already
    // in force when the frame started being populated.
    const realCreateFrame = (globalThis as any).figma.createFrame;
    (globalThis as any).figma.createFrame = vi.fn(() => {
      if (pausedDuring === null) pausedDuring = liveIsPaused();
      return realCreateFrame();
    });

    await HANDLERS.create_sitemap(ctx(d));

    expect(pausedDuring, "the live pass was open during the draw").toBe(true);
    expect(liveIsPaused(), "the live pass stayed shut after the draw").toBe(false);
  });
});

describe("deleting every box of a diagram", () => {
  /**
   * `scanBoxes` reads "not one box found" as mid-write, which is right during
   * a draw and wrong after a person selected every box and pressed delete:
   * each pass bailed out and the arrows stayed on the canvas for good. A
   * DELETE reaching the watcher is the evidence that tells the two apart.
   */
  const lines = (frame: any) => frame.children.filter((c: any) => c.name.indexOf("edge ") === 0);

  it("hides every arrow once the DELETE arrives", async () => {
    await HANDLERS.create_sitemap(ctx(drawData()));
    const frame = page.children[0];
    installDiagramLive();
    expect(lines(frame).length).toBeGreaterThan(0);

    const boxes = frame.children.filter((c: any) => c.name.indexOf("page:") === 0);
    for (const b of boxes) b.remove();
    for (const cb of pageListeners) cb({ nodeChanges: boxes.map((b: any) => ({ type: "DELETE", id: b.id })) });
    await settle();

    for (const l of lines(frame)) expect(l.visible, `${l.name} survived its boxes`).toBe(false);
  });

  it("an explicit reflow_diagram hides them too", async () => {
    const res = (await HANDLERS.create_sitemap(ctx(drawData()))) as any;
    const frame = page.children[0];
    for (const b of frame.children.filter((c: any) => c.name.indexOf("page:") === 0)) b.remove();
    const out = (await HANDLERS.reflow_diagram(ctx({ frameId: res.frameId }))) as any;
    expect(out.frames[0].goneBoxes.length).toBe(3);
    for (const l of lines(frame)) expect(l.visible).toBe(false);
  });
});

describe("reflow_diagram pointed at a deeply nested layer", () => {
  it("finds the diagram five levels up (an ERD column's text is that deep)", async () => {
    await HANDLERS.create_sitemap(ctx(drawData()));
    const frame = page.children[0];
    let cur = frame;
    for (const t of ["FRAME", "FRAME", "FRAME", "TEXT"]) {
      const n = base(`90:${++seq}`, t);
      cur.appendChild(n);
      cur = n;
    }
    const out = (await HANDLERS.reflow_diagram(ctx({ nodeId: cur.id }))) as any;
    expect(out.frames[0].frameId).toBe(frame.id);
  });
});

describe("a DELETE-flagged pass that meets a frame being redrawn", () => {
  /**
   * `paused` cannot stop a second op (after a bridge timeout the next op starts
   * while the plugin is still drawing). A redraw empties the frame while its old
   * graph is stored, so a pass flagged `deleted` reaching it then would hide
   * every line. The frame's own "being drawn" mark wins over the flag.
   */
  it("the frame carries the drawing mark for the length of a redraw, and not after", async () => {
    const res = (await HANDLERS.create_sitemap(ctx(drawData()))) as any;
    const frame = page.children[0];
    let markDuring = "";
    const realText = (globalThis as any).figma.createText;
    (globalThis as any).figma.createText = vi.fn(() => {
      if (!markDuring) markDuring = frame.getPluginData("reqwise.drawing");
      return realText();
    });
    await HANDLERS.create_sitemap(ctx({ ...drawData(), intoFrameId: res.frameId }));
    expect(markDuring, "no mark while the frame was being rewritten").not.toBe("");
    expect(frame.getPluginData("reqwise.drawing")).toBe("");
  });

  it("an explicit reflow reaching a marked, emptied frame hides nothing", async () => {
    const res = (await HANDLERS.create_sitemap(ctx(drawData()))) as any;
    const frame = page.children[0];
    const lines = () => frame.children.filter((c: any) => c.name.indexOf("edge ") === 0);
    // The state a timed-out redraw leaves for the next op: marked, boxes not
    // drawn yet, lines already in.
    frame.setPluginData("reqwise.drawing", String(Date.now()));
    for (const b of frame.children.filter((c: any) => c.name.indexOf("page:") === 0)) b.remove();
    const out = (await HANDLERS.reflow_diagram(ctx({ frameId: res.frameId }))) as any;
    for (const l of lines()) expect(l.visible, `${l.name} hidden mid-redraw`).toBe(true);
    expect(out.frames[0].goneBoxes).toEqual([]);
  });

  it("a mark left by a draw that died long ago does not pin the frame forever", async () => {
    const res = (await HANDLERS.create_sitemap(ctx(drawData()))) as any;
    const frame = page.children[0];
    frame.setPluginData("reqwise.drawing", String(Date.now() - 60 * 60_000));
    for (const b of frame.children.filter((c: any) => c.name.indexOf("page:") === 0)) b.remove();
    await HANDLERS.reflow_diagram(ctx({ frameId: res.frameId }));
    for (const l of frame.children.filter((c: any) => c.name.indexOf("edge ") === 0)) expect(l.visible).toBe(false);
  });
});

describe("a draw that starts while a live batch is running", () => {
  /**
   * `paused` used to be checked only at the head of the drain loop. A batch
   * already taken off the queue kept re-routing frame after frame even though
   * a draw had paused the watcher during one of its awaits. The rest of the
   * batch now goes back on the queue and waits for resumeLive.
   */
  it("hands the rest of the batch back instead of routing it mid-draw", async () => {
    await HANDLERS.create_sitemap(ctx(drawData()));
    await HANDLERS.create_sitemap(ctx({ ...drawData(), x: 2000 }));
    const [a, b] = page.children;
    installDiagramLive();
    const beforeB = pathOf(b, "edge root->a");

    // The moment frame A's line is rewritten, a draw pauses the watcher.
    const lineA = a.children.find((c: any) => c.name === "edge root->a");
    let paths = lineA.vectorPaths;
    let pausedOnce = false;
    Object.defineProperty(lineA, "vectorPaths", {
      configurable: true,
      get: () => paths,
      set: (v) => {
        paths = v;
        if (!pausedOnce) {
          pausedOnce = true;
          pauseLive();
        }
      },
    });

    boxOf(a, "a").x -= 200;
    boxOf(b, "a").x -= 200;
    for (const cb of pageListeners) cb({ nodeChanges: [moved(boxOf(a, "a")).nodeChanges[0], moved(boxOf(b, "a")).nodeChanges[0]] });
    await settle();
    await settle();
    expect(pausedOnce, "frame A was never re-routed").toBe(true);
    expect(pathOf(b, "edge root->a"), "frame B was routed while paused").toBe(beforeB);

    resumeLive();
    await settle();
    await settle();
    expect(pathOf(b, "edge root->a")).not.toBe(beforeB);
  });
});
