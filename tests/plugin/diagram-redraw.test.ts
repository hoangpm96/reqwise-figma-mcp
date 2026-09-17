import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Redrawing a diagram IN PLACE. The frame keeps its id, so comments pinned to
 * it, prototype links into it and wherever the user dragged it all survive a
 * change to the model — that is the difference between editing a diagram and
 * replacing it.
 *
 * Emptying a frame is destructive and a frame id is easy to get wrong by one
 * digit, so most of what is worth testing here is what it REFUSES to empty.
 */
const { createActivity } = await import("../../src/plugin/handlers/activity.js");
const { createUserflow } = await import("../../src/plugin/handlers/userflow.js");
const { readDiagramSource } = await import("../../src/plugin/diagram-apply.js");
const { buildUserflow } = await import("../../src/shared/userflow/index.js");
const { getPageModel } = await import("../../src/plugin/handlers/page-model.js");
const { makeContext } = await import("../../src/plugin/context.js");
const { buildActivity } = await import("../../src/shared/activity/index.js");

let page: any;
let seq = 0;

function base(id: string, type: string): any {
  const n: any = {
    id, type, name: "", x: 0, y: 0, width: 100, height: 100,
    visible: true, opacity: 1, rotation: 0, fills: [], strokes: [], strokeWeight: 1,
    strokeAlign: "CENTER", strokeCap: "NONE", strokeJoin: "MITER", dashPattern: [],
    effects: [], cornerRadius: 0, clipsContent: false, children: [], vectorPaths: [],
    characters: "", fontName: { family: "Inter", style: "Regular" }, fontSize: 12,
    textAutoResize: "NONE", reactions: [], pluginData: {} as Record<string, string>,
    async setVectorNetworkAsync(net: any) { this.vectorNetwork = net; },
    resize(w: number, h: number) { this.width = w; this.height = h; },
    appendChild(c: any) { this.children.push(c); c.parent = this; },
    insertChild(i: number, c: any) { this.children.splice(i, 0, c); c.parent = this; },
    remove() {
      const kids = this.parent?.children;
      if (kids) kids.splice(kids.indexOf(this), 1);
      this.parent = null;
    },
    setBoundVariable: vi.fn(),
    getPluginData(k: string) { return this.pluginData[k] ?? ""; },
    setPluginData(k: string, v: string) { this.pluginData[k] = v; },
    setReactionsAsync: vi.fn(async function (this: any, r: unknown) { this.reactions = r; }),
  };
  if (type === "FRAME") n.layoutMode = "NONE";
  return n;
}

beforeEach(() => {
  seq = 0;
  page = {
    id: "0:1", type: "PAGE", children: [] as any[],
    appendChild(n: any) { this.children.push(n); n.parent = this; },
    insertChild(i: number, n: any) { this.children.splice(i, 0, n); n.parent = this; },
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
    createEllipse: vi.fn(() => base(`60:${++seq}`, "ELLIPSE")),
    createLine: vi.fn(() => base(`70:${++seq}`, "LINE")),
  };
});

const draw = (label: string, extra: Record<string, unknown> = {}) => ({
  ...(buildActivity({
    title: "Approval",
    nodes: [
      { id: "s", label: "Need", kind: "start" },
      { id: "draft", label },
      { id: "done", label: "Done", kind: "end" },
    ],
    edges: [{ from: "s", to: "draft" }, { from: "draft", to: "done" }],
  } as any).draw),
  ...extra,
});

const run = (d: unknown) => createActivity(makeContext(d as any, () => {}));

/** Step labels live in nested frames, so a redraw has to be read all the way down. */
const allText = (n: any): string =>
  [n.characters ?? "", ...(n.children ?? []).map(allText)].join(" ");

describe("drawing a diagram into a frame that already exists", () => {
  it("keeps the frame — same id, same position, new contents", async () => {
    const first = (await run(draw("Draft it"))) as any;
    const frame = page.children[0];
    frame.x = 900; // the user dragged it somewhere they wanted it
    frame.y = 700;
    const before = frame.children.length;
    expect(before).toBeGreaterThan(5);

    const again = (await run(draw("Draft the thing", { intoFrameId: first.frameId }))) as any;

    expect(again.frameId).toBe(first.frameId);
    expect(page.children.length).toBe(1); // no second frame was made
    expect(frame.x).toBe(900); // and it did not jump back to the layout's x/y
    expect(frame.y).toBe(700);
    const text = allText(frame);
    expect(text).toContain("Draft the thing");
    expect(text).not.toContain("Draft it");
  });

  it("leaves nothing of the old drawing behind", async () => {
    const first = (await run(draw("Draft it"))) as any;
    const frame = page.children[0];
    const stale = base("99:1", "TEXT");
    stale.characters = "left over";
    frame.appendChild(stale);

    await run(draw("Draft it", { intoFrameId: first.frameId }));
    expect(allText(frame)).not.toContain("left over");
  });

  it("stores the model on the frame, so the next change can be a patch", async () => {
    const model = { title: "Approval", nodes: [{ id: "draft", label: "Draft it" }] };
    await run(draw("Draft it", { source: model }));
    const mark = JSON.parse(page.children[0].pluginData["reqwise.activity"]);
    expect(mark.source).toEqual(model);
    // The routing graph is a different thing and both are kept.
    expect(mark.kind).toBe("activity");
  });
});

describe("what it refuses to empty", () => {
  const refused = async (intoFrameId: string, ...expected: string[]) => {
    try {
      await run(draw("Draft it", { intoFrameId }));
    } catch (e) {
      for (const want of expected) {
        expect(`${(e as any).message} ${(e as any).hint ?? ""}`).toContain(want);
      }
      return;
    }
    throw new Error("expected the redraw to be refused");
  };

  it("a frame no diagram tool drew — somebody's artwork, one digit away", async () => {
    const art = base("77:7", "FRAME");
    art.name = "Hand-drawn thing";
    art.appendChild(base("77:8", "RECTANGLE"));
    page.appendChild(art);

    await refused("77:7", "was not drawn by a diagram tool", "clears the frame");
    expect(art.children.length).toBe(1); // still there
  });

  it("a node that is not a frame", async () => {
    const text = base("88:8", "TEXT");
    page.appendChild(text);
    await refused("88:8", "is a TEXT, not a frame");
  });

  it("a node that is not there at all", async () => {
    await refused("404:1", "not found", "nothing was changed");
  });
});


describe("every kind leaves a marker the edit path can read", () => {
  /**
   * `readDiagramSource` once looked for "reqwise.flow" while the userflow
   * marker was "reqwise.userflow", and the userflow marker carried no `kind`
   * at all. Both bugs had the same symptom — a frame one of these tools had
   * just drawn reported "not a frame drawn by a diagram tool" — and neither
   * showed up in tests that only ever drew an activity diagram.
   */
  it("a userflow frame can be read back, and says what it is", async () => {
    const built = buildUserflow({
      title: "Book a seat",
      nodes: [
        { id: "home", label: "Home" },
        { id: "seats", label: "Pick seats" },
      ],
      edges: [{ from: "home", to: "seats" }],
    } as any);
    await createUserflow(
      makeContext({ ...built.draw, source: built.model } as any, () => {}),
    );

    const mark = readDiagramSource(page.children[0]);
    expect(mark.kind).toBe("userflow");
    expect(mark.title).toBe("Book a seat");
    expect((mark.source as any).nodes.map((n: any) => n.id)).toEqual(["home", "seats"]);
  });

  it("an activity frame does too", async () => {
    await run(draw("Draft it", { source: { title: "Approval" } }));
    const mark = readDiagramSource(page.children[0]);
    expect(mark.kind).toBe("activity");
    expect(mark.source).toEqual({ title: "Approval" });
  });
});

describe("a frame nothing can read is reported, not hidden", () => {
  /**
   * A diagram drawn before the model was stored carries no `kind`, so no
   * check can see it. Omitting it from the page model made the page LOOK
   * compared while a diagram sat in it that nothing had looked at — worse than
   * admitting the gap, because the caller has no way to notice.
   */
  it("lists an old diagram frame as unreadable", async () => {
    const old = base("77:1", "FRAME");
    old.name = "Sequence · drawn by an older build";
    page.appendChild(old);
    await run(draw("Draft it", { source: { title: "T" } }));

    const res = (await getPageModel(makeContext({} as any, () => {}))) as any;
    const names = res.diagrams.map((d: any) => d.nodeId);
    expect(names).toContain("77:1");
    const stale = res.diagrams.find((d: any) => d.nodeId === "77:1");
    expect(stale.unreadable).toBe(true);
    expect(stale.spec).toBeUndefined();
  });

  it("ignores a frame that is not a diagram at all", async () => {
    const art = base("88:1", "FRAME");
    art.name = "Login screen";
    page.appendChild(art);
    await run(draw("Draft it", { source: { title: "T" } }));

    const res = (await getPageModel(makeContext({} as any, () => {}))) as any;
    expect(res.diagrams.map((d: any) => d.nodeId)).not.toContain("88:1");
  });
});

describe("a diagram inside a SECTION", () => {
  /**
   * `artboards` already looked inside sections; `diagrams` did not, so a
   * diagram dragged into one vanished from the page model — not even listed
   * as unreadable — and every cross-check ran on part of the page.
   */
  const section = () => {
    const s = base("5:1", "SECTION");
    page.appendChild(s);
    return s;
  };

  it("get_page_model lists it", async () => {
    const res0 = (await run(draw("Draft it", { source: { title: "T" } }))) as any;
    const frame = page.children[0];
    page.children.splice(0, 1);
    section().appendChild(frame);

    const res = (await getPageModel(makeContext({} as any, () => {}))) as any;
    expect(res.diagrams.map((d: any) => d.nodeId)).toContain(res0.frameId);
  });

  it("a draw inside a section still sees the diagrams on the page, and vice versa", async () => {
    const onPage = (await run(draw("Draft it", { source: { title: "A" } }))) as any;
    const s = section();
    const inSection = (await run(draw("Other", { source: { title: "B" }, parentId: s.id }))) as any;
    expect(page.children.find((c: any) => c.id === inSection.frameId)).toBeUndefined();
    const ids = (inSection.pageModel ?? []).map((d: any) => d.nodeId);
    expect(ids).toContain(onPage.frameId);
    expect(ids).toContain(inSection.frameId);
  });
});

describe("a diagram inside a plain board frame, or a section inside a section", () => {
  it("the draw's page model still lists itself and its neighbour on the board", async () => {
    const board = base("6:1", "FRAME");
    page.appendChild(board);
    const a = (await run(draw("Draft it", { source: { title: "A" }, parentId: board.id }))) as any;
    const b = (await run(draw("Other", { source: { title: "B" }, parentId: board.id }))) as any;
    const ids = (b.pageModel ?? []).map((d: any) => d.nodeId);
    expect(ids).toContain(a.frameId);
    expect(ids).toContain(b.frameId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("get_page_model looks inside nested sections", async () => {
    const res0 = (await run(draw("Draft it", { source: { title: "T" } }))) as any;
    const frame = page.children.find((c: any) => c.id === res0.frameId);
    page.children.splice(page.children.indexOf(frame), 1);
    const outer = base("7:1", "SECTION");
    const inner = base("7:2", "SECTION");
    page.appendChild(outer);
    outer.appendChild(inner);
    inner.appendChild(frame);
    const res = (await getPageModel(makeContext({} as any, () => {}))) as any;
    expect(res.diagrams.map((d: any) => d.nodeId)).toContain(res0.frameId);
  });
});

describe("a diagram nested deeper than a board's direct child", () => {
  /**
   * The page model only walked the canvas (plus the drawn frame's siblings),
   * so frame > frame > diagram was invisible to every cross-check, while the
   * re-route sweep already found it with one native search. Both now use it.
   */
  function withNativeSearch() {
    page.findAllWithCriteria = function (criteria: { types?: string[]; pluginData?: { keys?: string[] } }) {
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
    };
  }

  it("is in the draw's page model and in get_page_model, once, and not when it sits in a component", async () => {
    withNativeSearch();
    const outer = base("8:1", "FRAME");
    const inner = base("8:2", "FRAME");
    page.appendChild(outer);
    outer.appendChild(inner);
    const deep = (await run(draw("Deep", { source: { title: "Deep" }, parentId: inner.id }))) as any;
    const comp = base("8:3", "COMPONENT");
    page.appendChild(comp);
    const pictured = (await run(draw("Pictured", { source: { title: "P" }, parentId: comp.id }))) as any;

    const onPage = (await run(draw("Top", { source: { title: "Top" } }))) as any;
    const ids = (onPage.pageModel ?? []).map((d: any) => d.nodeId);
    expect(ids, "the draw's cross-check missed the nested diagram").toContain(deep.frameId);
    expect(ids).toContain(onPage.frameId);
    expect(ids).not.toContain(pictured.frameId);
    expect(new Set(ids).size).toBe(ids.length);

    const res = (await getPageModel(makeContext({} as any, () => {}))) as any;
    const listed = res.diagrams.map((d: any) => d.nodeId);
    expect(listed, "get_page_model missed the nested diagram").toContain(deep.frameId);
    expect(listed).toContain(onPage.frameId);
    expect(listed).not.toContain(pictured.frameId);
    expect(new Set(listed).size).toBe(listed.length);
  });
});
