import { beforeEach, describe, expect, it, vi } from "vitest";
import { createUserflow } from "../../src/plugin/handlers/userflow.js";
import { createSequence } from "../../src/plugin/handlers/sequence.js";
import { createSitemap } from "../../src/plugin/handlers/sitemap.js";
import { reflowAnyFrame } from "../../src/plugin/diagram-reflow.js";
import { makeContext } from "../../src/plugin/context.js";
import { buildUserflow } from "../../src/shared/userflow/index.js";
import { buildSequence } from "../../src/shared/sequence/index.js";
import { buildSitemap } from "../../src/shared/sitemap/index.js";

/**
 * What a re-route hid when a box went away has to come back when THAT box
 * comes back — not only once every missing box is back — and only while the
 * hide is still ours.
 *
 *  - Delete two boxes, undo one: the layers of the one that came back stayed
 *    hidden for as long as the other was gone (the restore ran only when no
 *    box at all was missing, and a pinned arrow was never un-hidden by the
 *    full pass either).
 *  - A layer somebody showed by hand kept our stamp, so when they hid it
 *    again the next pass showed it for them.
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
const layer = (frame: any, name: string) => frame.children.find((c: any) => c.name === name);
const boxOf = (frame: any, prefix: string, id: string) =>
  frame.children.find((c: any) => c.name === `${prefix}${id}` || c.name.indexOf(`${prefix}${id} `) === 0);

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

describe("sequence: undoing one of two deleted participants", () => {
  it("brings back that participant's lifeline, bars, messages and notes while the other is still gone", async () => {
    await createSequence(ctx(draw(buildSequence({
      title: "T",
      participants: [{ id: "u", name: "U" }, { id: "s", name: "S" }, { id: "x", name: "X" }],
      messages: [
        { id: "m1", from: "u", to: "s", label: "call", note: "why" },
        { id: "m2", from: "s", to: "u", label: "reply", kind: "return" },
      ],
    }))));
    const frame = page.children[0];
    const bars = () => frame.children.filter((c: any) => c.name.indexOf("bar ") === 0);
    expect(layer(frame, "note m1"), "no note drawn").toBeTruthy();
    expect(bars().length, "no activation bar drawn").toBeGreaterThan(0);

    const x = boxOf(frame, "party:", "x");
    const s = boxOf(frame, "party:", "s");
    x.remove();
    s.remove();
    await reflowAnyFrame(frame, { deleted: true });
    for (const name of ["life x", "life s", "edge m1", "edge m2", "note m1"]) {
      expect(layer(frame, name).visible, `${name} was not hidden by the delete`).toBe(false);
    }

    // Undo the delete of S only. X has no messages, so nothing reads as moved
    // or dropped: the live pass takes the quiet branch.
    frame.appendChild(s);
    await reflowAnyFrame(frame, { onlyIfMoved: true });
    for (const name of ["life s", "edge m1", "edge m2", "note m1"]) {
      expect(layer(frame, name).visible, `${name} stayed hidden although S is back`).toBe(true);
    }
    for (const bar of bars()) expect(bar.visible, `${bar.name} stayed hidden`).toBe(true);
    expect(layer(frame, "life x").visible, "X is still gone, its lifeline must stay hidden").toBe(false);

    // And the rest once X is back too.
    frame.appendChild(x);
    await reflowAnyFrame(frame, { onlyIfMoved: true });
    expect(layer(frame, "life x").visible).toBe(true);
  });
});

describe("userflow: a hand-moved arrow of a box that came back", () => {
  it("is shown again by the full pass while an unrelated box is still gone", async () => {
    await createUserflow(ctx(draw(buildUserflow({
      title: "T",
      nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }],
      edges: [{ from: "a", to: "b" }, { from: "a", to: "c" }],
    }))));
    const frame = page.children[0];
    // Reshaped by hand into a curve — nothing a connection point can be read
    // out of — so the reflow leaves this arrow exactly as it is (pinned).
    layer(frame, "edge a->b").vectorPaths = [{ windingRule: "NONE", data: "M 0 0 C 10 10 20 20 30 30" }];

    const b = boxOf(frame, "flow:", "b");
    boxOf(frame, "flow:", "c").remove();
    b.remove();
    await reflowAnyFrame(frame, { deleted: true });
    expect(layer(frame, "edge a->b").visible).toBe(false);
    expect(layer(frame, "edge a->c").visible).toBe(false);

    frame.appendChild(b);
    const out = (await reflowAnyFrame(frame, { onlyIfMoved: true })) as any;
    expect(out.pinned).toContain("a->b");
    expect(layer(frame, "edge a->b").visible, "the pinned arrow of the restored box stayed hidden").toBe(true);
    expect(layer(frame, "edge a->c").visible, "C is still gone").toBe(false);
  });
});

describe("a layer shown by hand", () => {
  it("loses our stamp, so hiding it again by hand sticks", async () => {
    await createSitemap(ctx(draw(buildSitemap({ title: "T", text: `root "Root"\n  a "A"\n  b "B"` }))));
    const frame = page.children[0];
    const box = boxOf(frame, "page:", "a");
    box.remove();
    await reflowAnyFrame(frame, { deleted: true });
    const line = layer(frame, "edge root->a");
    expect(line.visible).toBe(false);

    // The box is back and the person shows the line themselves, before any
    // pass has run; a pass then sees it visible.
    frame.appendChild(box);
    line.visible = true;
    await reflowAnyFrame(frame, { onlyIfMoved: true });

    // Later they hide it on purpose.
    line.visible = false;
    await reflowAnyFrame(frame, { onlyIfMoved: true });
    expect(line.visible, "a hand-hidden line was shown again").toBe(false);
    await reflowAnyFrame(frame);
    expect(line.visible, "a hand-hidden line was shown again by a full pass").toBe(false);
  });
});

describe("the end-of-pass restore", () => {
  it("never shows a line the same pass just hid, even with no box reported missing", async () => {
    // An arrow whose end is not a box in the stored graph at all is dropped on
    // every pass while goneBoxes stays empty. Showing it at the end of the
    // pass would hide it on the next one and show it again after: a loop.
    await createUserflow(ctx(draw(buildUserflow({
      title: "T",
      nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }],
      edges: [{ from: "a", to: "b" }, { from: "a", to: "c" }],
    }))));
    const frame = page.children[0];
    const mark = JSON.parse(frame.getPluginData("reqwise.userflow"));
    mark.graph.nodes = mark.graph.nodes.filter((n: any) => n.id !== "c");
    frame.setPluginData("reqwise.userflow", JSON.stringify(mark));
    boxOf(frame, "flow:", "c").remove();

    for (let pass = 0; pass < 3; pass++) {
      const out = (await reflowAnyFrame(frame)) as any;
      expect(out.goneBoxes).toEqual([]);
      expect(layer(frame, "edge a->c").visible, `pass ${pass} showed the dropped line`).toBe(false);
    }
  });
});
