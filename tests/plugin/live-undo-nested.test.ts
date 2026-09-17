import { beforeEach, describe, expect, it, vi } from "vitest";
import { installDiagramLive } from "../../src/plugin/diagram-live.js";
import { owningDiagram, reflowAnyFrame } from "../../src/plugin/diagram-reflow.js";
import { HANDLERS } from "../../src/plugin/handlers/registry.js";
import { makeContext } from "../../src/plugin/context.js";
import { buildSitemap } from "../../src/shared/sitemap/index.js";

/**
 * Three ways the live re-router used to leave a diagram wrong for good:
 *  - undoing a box delete never brought its hidden arrows back (CREATE was
 *    ignored, and a pass with nothing moved returned before un-hiding);
 *  - a diagram inside a plain frame was not in the DELETE sweep, so its
 *    arrows dangled after a box delete;
 *  - owningDiagram gave up after four hops.
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

/** Figma's native search, as far as this listener uses it. */
function findAllWithCriteria(this: any, criteria: { types?: string[]; pluginData?: { keys?: string[] } }) {
  const out: any[] = [];
  const walk = (nodes: any[]) => {
    for (const n of nodes) {
      const typeOk = !criteria.types || criteria.types.includes(n.type);
      const keys = criteria.pluginData?.keys;
      const dataOk = !keys || keys.some((k) => (n.pluginData?.[k] ?? "") !== "");
      if (typeOk && dataOk) out.push(n);
      if (n.children) walk(n.children);
    }
  };
  walk(this.children);
  return out;
}

const ctx = (params: Record<string, unknown>) => makeContext(params, () => {});
const drawData = (extra: Record<string, unknown> = {}) => ({
  ...(buildSitemap({ title: "T", text: `root "Root"\n  a "A"\n  b "B"` }).draw as unknown as Record<string, unknown>),
  ...extra,
});
const settle = () => new Promise((r) => setTimeout(r, 0));
const boxOf = (frame: any, id: string) => frame.children.find((c: any) => c.name.indexOf(`page:${id}`) === 0);
const layer = (frame: any, name: string) => frame.children.find((c: any) => c.name === name);
const fire = (changes: any[]) => {
  for (const cb of pageListeners) cb({ nodeChanges: changes });
};

beforeEach(() => {
  seq = 0;
  pageListeners = [];
  page = {
    id: "0:1", type: "PAGE", children: [] as any[],
    appendChild(n: any) { this.children.push(n); n.parent = this; },
    insertChild(i: number, n: any) { this.children.splice(i, 0, n); n.parent = this; },
    on(type: string, cb: (e: any) => void) { if (type === "nodechange") pageListeners.push(cb); },
    off(type: string, cb: (e: any) => void) { pageListeners = pageListeners.filter((f) => f !== cb); },
    findAllWithCriteria,
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

describe("undoing a box delete", () => {
  it("brings back the arrows the delete hid", async () => {
    await HANDLERS.create_sitemap(ctx(drawData()));
    const frame = page.children[0];
    installDiagramLive();

    const box = boxOf(frame, "a");
    box.remove();
    fire([{ type: "DELETE", id: box.id }]);
    await settle();
    expect(layer(frame, "edge root->a").visible, "the delete did not hide the arrow").toBe(false);

    // Undo: the same box comes back exactly where it was.
    box.removed = false;
    frame.appendChild(box);
    fire([{ type: "CREATE", id: box.id, node: box }]);
    await settle();
    expect(layer(frame, "edge root->a").visible, "the undone delete left the arrow hidden").toBe(true);
  });

  it("a pass that finds nothing moved still restores what WE hid — and only that", async () => {
    await HANDLERS.create_sitemap(ctx(drawData()));
    const frame = page.children[0];
    const box = boxOf(frame, "a");
    box.remove();
    await reflowAnyFrame(frame, { onlyIfMoved: true, deleted: true });
    expect(layer(frame, "edge root->a").visible).toBe(false);
    // Hidden by hand: no stamp, so it must stay hidden.
    layer(frame, "edge root->b").visible = false;

    box.removed = false;
    frame.appendChild(box);
    const out = (await reflowAnyFrame(frame, { onlyIfMoved: true })) as any;
    expect(out.changed).toBe(false);
    expect(layer(frame, "edge root->a").visible).toBe(true);
    expect(layer(frame, "edge root->b").visible, "a hand-hidden arrow was un-hidden").toBe(false);
  });

  it("keeps the arrows hidden while their box is still gone", async () => {
    await HANDLERS.create_sitemap(ctx(drawData()));
    const frame = page.children[0];
    boxOf(frame, "a").remove();
    await reflowAnyFrame(frame, { onlyIfMoved: true, deleted: true });
    await reflowAnyFrame(frame, { onlyIfMoved: true });
    expect(layer(frame, "edge root->a").visible).toBe(false);
  });
});

describe("a diagram inside a plain frame", () => {
  it("hides the arrows of a deleted box", async () => {
    const holder = base("5:1", "FRAME");
    holder.width = 4000;
    holder.height = 4000;
    page.appendChild(holder);
    await HANDLERS.create_sitemap(ctx(drawData({ parentId: "5:1" })));
    const frame = holder.children[0];
    expect(frame.getPluginData("reqwise.sitemap")).not.toBe("");
    installDiagramLive();

    const box = boxOf(frame, "a");
    box.remove();
    fire([{ type: "DELETE", id: box.id }]);
    await settle();
    expect(layer(frame, "edge root->a").visible, "the nested diagram kept a dangling arrow").toBe(false);
  });
});

describe("owningDiagram", () => {
  it("walks past four hops to the diagram (an ERD column's text is five deep)", async () => {
    await HANDLERS.create_sitemap(ctx(drawData()));
    const frame = page.children[0];
    let cur = frame;
    for (const t of ["FRAME", "FRAME", "FRAME", "FRAME", "TEXT"]) {
      const n = base(`90:${++seq}`, t);
      cur.appendChild(n);
      cur = n;
    }
    expect(owningDiagram(cur)?.id).toBe(frame.id);
    const memo = new Map();
    expect(owningDiagram(cur, memo)?.id).toBe(frame.id);
    // A sibling in the same subtree is answered from the memo, and right.
    const sib = base("91:1", "TEXT");
    cur.parent.appendChild(sib);
    expect(owningDiagram(sib, memo)?.id).toBe(frame.id);
    expect(owningDiagram(page.children[0].children[0].parent.parent)).toBe(null);
  });
});

describe("a diagram inside a component", () => {
  /**
   * The native search reaches into components and instances. A diagram drawn
   * as part of a component is a picture, not a live diagram: routing or hiding
   * its layers would write overrides onto every instance.
   */
  it("is not treated as live, however deep", async () => {
    const comp = base("6:1", "COMPONENT");
    comp.width = 4000;
    comp.height = 4000;
    page.appendChild(comp);
    await HANDLERS.create_sitemap(ctx(drawData({ parentId: "6:1" })));
    const frame = comp.children[0];
    expect(frame.getPluginData("reqwise.sitemap")).not.toBe("");
    expect(owningDiagram(boxOf(frame, "a"))).toBe(null);
    installDiagramLive();
    const box = boxOf(frame, "a");
    box.remove();
    fire([{ type: "DELETE", id: box.id }]);
    await settle();
    expect(layer(frame, "edge root->a").visible, "an arrow inside a component was hidden").toBe(true);
  });
});
