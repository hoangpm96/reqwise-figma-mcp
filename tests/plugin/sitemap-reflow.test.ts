import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSitemap } from "../../src/plugin/handlers/sitemap.js";
import { reflowSitemapFrame } from "../../src/plugin/sitemap-reflow.js";
import { readDiagramSource } from "../../src/plugin/diagram-apply.js";
import { makeContext } from "../../src/plugin/context.js";
import { buildSitemap } from "../../src/shared/sitemap/index.js";

/**
 * A sitemap's lines have NO arrow heads, and this is the file that says so
 * about the DRAWN canvas rather than about the payload.
 *
 * That distinction is not pedantic — it is the bug this file was written for.
 * `applyEdge` caps a line with a filled head unless told `arrow: false`, and
 * the sitemap reflow was not telling it. So the draw path was correct and the
 * reflow path was not: the diagram was right until somebody dragged a box, at
 * which point every containment line grew an arrow and the picture started
 * saying "go here next" — the one thing this kind exists not to say.
 *
 * 1,356 unit tests could not see it, because every one of them checks the
 * `DrawEdge` payload, which was right both times. It took drawing on a real
 * canvas and dragging a box.
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
    caps: [] as string[],
    characters: "",
    fontName: { family: "Inter", style: "Regular" },
    fontSize: 12,
    textAutoResize: "NONE",
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
  const built = buildSitemap({
    title: "CRM",
    text: `crm "CRM"
  leads "Danh sách lead"
    create "Tạo lead" modal
    detail "Chi tiết lead"
      convert "Chuyển thành học viên" modal`,
    ...over,
  });
  return built.draw as unknown as Record<string, unknown>;
}

const ctx = (params: Record<string, unknown>) => makeContext(params, () => {});

const layer = (frame: any, name: string): any => frame.children.find((c: any) => c.name === name);
const boxOf = (frame: any, id: string): any =>
  frame.children.find((c: any) => c.name.indexOf(`page:${id}`) === 0);
const lines = (frame: any): any[] => frame.children.filter((c: any) => c.name.indexOf("edge ") === 0);
const pathOf = (frame: any, name: string): string => {
  const l = layer(frame, name);
  return `${l.x},${l.y} ${l.vectorPaths[0]?.data ?? ""}`;
};
/** Every stroke cap the drawn line carries, heads included. */
const capsOf = (line: any): string[] => (line.caps ?? []).filter(Boolean);

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
    on: vi.fn(),
    off: vi.fn(),
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

describe("a containment line never grows an arrow head", () => {
  it("has none when it is first drawn", async () => {
    await createSitemap(ctx(drawData()));
    const frame = page.children[0];
    expect(lines(frame).length).toBe(4);
    for (const line of lines(frame)) {
      expect(capsOf(line), line.name).not.toContain("ARROW_EQUILATERAL");
      expect(capsOf(line), line.name).not.toContain("ARROW_LINES");
    }
  });

  it("still has none after a page is dragged and the lines re-route", async () => {
    // THE regression. `applyEdge` defaults to a filled head, so a reflow that
    // does not pass `arrow: false` turns "lives under" into "go here next" —
    // and only after a drag, which is why the first drawing looked right.
    await createSitemap(ctx(drawData()));
    const frame = page.children[0];
    const before = pathOf(frame, "edge leads->detail");

    const box = boxOf(frame, "detail");
    box.x -= 180;
    box.y += 60;
    const report = (await reflowSitemapFrame(frame))!;

    expect(report.routed).toBe(4);
    expect(pathOf(frame, "edge leads->detail")).not.toBe(before);
    for (const line of lines(frame)) {
      expect(capsOf(line), `${line.name} grew a head on reflow`).not.toContain("ARROW_EQUILATERAL");
      expect(capsOf(line), line.name).not.toContain("ARROW_LINES");
    }
  });

  it("re-routes the line out of a page that moved, and the one into it", async () => {
    await createSitemap(ctx(drawData()));
    const frame = page.children[0];
    const into = pathOf(frame, "edge leads->detail");
    const outOf = pathOf(frame, "edge detail->convert");

    boxOf(frame, "detail").x -= 200;
    await reflowSitemapFrame(frame);

    expect(pathOf(frame, "edge leads->detail")).not.toBe(into);
    expect(pathOf(frame, "edge detail->convert")).not.toBe(outOf);
  });

  it("reports nothing moved when nothing moved", async () => {
    await createSitemap(ctx(drawData()));
    const frame = page.children[0];
    const report = (await reflowSitemapFrame(frame, { onlyIfMoved: true }))!;
    expect(report.changed).toBe(false);
    expect(report.routed).toBe(0);
  });

  it("hides the line to a page somebody deleted, and names the box", async () => {
    await createSitemap(ctx(drawData()));
    const frame = page.children[0];
    boxOf(frame, "convert").remove();

    const report = (await reflowSitemapFrame(frame))!;
    expect(report.goneBoxes).toEqual(["convert"]);
    expect(report.hidden).toBe(1);
    expect(layer(frame, "edge detail->convert").visible).toBe(false);
  });
});

describe("the marker the edit path reads", () => {
  it("says what the frame is, and hands back the model a patch changes", async () => {
    // The `readDiagramSource` trap, for this kind: a marker missing from that
    // list draws fine and then cannot be read back, patched or redrawn, and
    // the only symptom is "not a frame drawn by a diagram tool".
    await createSitemap(ctx({ ...drawData(), source: { title: "CRM", pages: [{ id: "crm" }] } }));
    const frame = page.children[0];
    const mark = readDiagramSource(frame);
    expect(mark.kind).toBe("sitemap");
    expect(mark.title).toBe("CRM");
    expect(mark.source).toEqual({ title: "CRM", pages: [{ id: "crm" }] });
  });

  it("names the frame so the placement rule and the audit can recognise it", async () => {
    await createSitemap(ctx(drawData()));
    expect(page.children[0].name).toBe("Sitemap · CRM");
  });
});

describe("a server older than this plugin", () => {
  // They ship together, so this is a dev-time or half-updated-install state —
  // but it produced `n.screenId.join is not a function`, which names nothing
  // anybody can act on. An older server sends `screenId` as the raw string it
  // parsed, commas and all.
  it("draws the artboard list a stale server sent as one string", async () => {
    const d = drawData() as any;
    d.pages.find((p: any) => p.id === "leads").screenId = "01,02";
    await createSitemap(ctx(d));
    const frame = page.children[0];
    const box = boxOf(frame, "leads");
    const line = box.children.find((c: any) => c.name === "screen");
    expect(line.characters).toBe("· 01 · 02");
  });

  it("draws nothing extra when it sent no artboard at all", async () => {
    const d = drawData() as any;
    for (const p of d.pages) delete p.screenId;
    await createSitemap(ctx(d));
    const frame = page.children[0];
    const box = boxOf(frame, "leads");
    expect(box.children.some((c: any) => c.name === "screen")).toBe(false);
  });
});

describe("a frame caught mid-write", () => {
  // The lines are appended before the boxes, so they sit under them — and the
  // live watcher fires on `parent`, which every append changes. A pass that
  // lands in that window sees the lines and no boxes. Trusting it hid every
  // line on the diagram permanently, because nothing further changed to
  // trigger another pass. Seen on a real canvas; invisible to every test that
  // reflows a frame that is already finished.
  it("touches nothing when not one page box is there yet", async () => {
    await createSitemap(ctx(drawData()));
    const frame = page.children[0];
    for (const box of frame.children.filter((c: any) => c.name.indexOf("page:") === 0)) {
      box.remove();
    }

    const report = (await reflowSitemapFrame(frame))!;

    expect(report.changed).toBe(false);
    expect(report.hidden).toBe(0);
    expect(report.goneBoxes).toEqual([]);
    for (const line of lines(frame)) {
      expect(line.visible, `${line.name} was hidden mid-write`).toBe(true);
    }
  });

  it("still hides a line whose page really was deleted, when others remain", async () => {
    // The guard must not swallow the real case: one box gone, the rest there.
    await createSitemap(ctx(drawData()));
    const frame = page.children[0];
    boxOf(frame, "convert").remove();

    const report = (await reflowSitemapFrame(frame))!;
    expect(report.goneBoxes).toEqual(["convert"]);
    expect(layer(frame, "edge detail->convert").visible).toBe(false);
  });
});
