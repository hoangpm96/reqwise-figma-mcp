import { beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "../../src/plugin/handlers/create.js";
import { modify, deleteNode } from "../../src/plugin/handlers/write.js";
import { clone } from "../../src/plugin/handlers/clone.js";
import { createOverlay } from "../../src/plugin/handlers/assets.js";
import { setupTokens } from "../../src/plugin/handlers/tokens.js";
import { makeContext, HandlerContext } from "../../src/plugin/context.js";
import { resetKeepClearGroups } from "../../src/plugin/keep-clear.js";
import { HandlerError, toBridgeError } from "../../src/plugin/errors.js";
import { ErrorCode } from "../../src/shared/protocol.js";

/**
 * Plugin handler tests against the REAL handlers in src/plugin/handlers/*,
 * behind a mocked `figma` global — the same pattern the suites under
 * tests/plugin/handlers/ use. (The previous version of this file built
 * literals inside each test and asserted on them; it never imported a
 * handler, so it passed no matter what the handlers did.)
 *
 * Not covered here: `batch` — its dispatch loop lives in src/plugin/main.ts,
 * which is not importable in Node (it calls figma.showUI at module top
 * level and references the build-time __html__ constant).
 */

type FakeNode = Record<string, any>;

let nodes: Map<string, FakeNode>;
let components: FakeNode[];
let collections: FakeNode[];
let variablesById: Map<string, FakeNode>;
let page: FakeNode;
let seq: number;
let varCounter: number;

function register<T extends FakeNode>(n: T): T {
  nodes.set(n.id, n);
  return n;
}

/** nodes.get() for tests: the id exists or the test itself is broken. */
function mustGet(id: string): FakeNode {
  const n = nodes.get(id);
  if (!n) throw new Error(`test registry has no node ${id}`);
  return n;
}

/** Generic scene-node fake: the props the handlers read/write, guarded by `in`. */
function makeNode(id: string, type: string): FakeNode {
  const n: FakeNode = {
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
    effects: [],
    strokeWeight: 1,
    cornerRadius: 0,
    layoutAlign: "INHERIT",
    layoutGrow: 0,
    removed: false,
    children: [] as FakeNode[],
    parent: null,
    appendChild(c: FakeNode) {
      this.children.push(c);
      c.parent = this;
    },
    insertChild(i: number, c: FakeNode) {
      this.children.splice(i, 0, c);
      c.parent = this;
    },
    resize(w: number, h: number) {
      this.width = w;
      this.height = h;
    },
    remove() {
      this.removed = true;
    },
    getPluginData: () => "",
    setPluginData: vi.fn(),
    setBoundVariable: vi.fn(),
  };
  if (type === "FRAME" || type === "COMPONENT") {
    n.layoutMode = "NONE";
    n.clipsContent = false;
    n.itemSpacing = 0;
    n.paddingLeft = 0;
    n.paddingRight = 0;
    n.paddingTop = 0;
    n.paddingBottom = 0;
    n.primaryAxisSizingMode = "FIXED";
    n.counterAxisSizingMode = "FIXED";
    n.primaryAxisAlignItems = "MIN";
    n.counterAxisAlignItems = "MIN";
    n.layoutWrap = "NO_WRAP";
    n.counterAxisSpacing = 0;
  }
  return n;
}

function makeText(id: string): FakeNode {
  const n = makeNode(id, "TEXT");
  n.characters = "";
  n.fontName = { family: "Inter", style: "Regular" };
  n.fontSize = 16;
  n.lineHeight = { unit: "AUTO" };
  n.letterSpacing = { unit: "PIXELS", value: 0 };
  n.textAutoResize = "WIDTH_AND_HEIGHT";
  n.textAlignHorizontal = "LEFT";
  n.textAlignVertical = "TOP";
  n.textCase = "ORIGINAL";
  n.textDecoration = "NONE";
  n.getRangeAllFontNames = () => [{ family: "Inter", style: "Regular" }];
  return n;
}

function ctx(params: Record<string, unknown>): HandlerContext {
  return makeContext(params, () => {});
}

function makeCollection(name: string, modeNames: string[] = ["Mode 1"]): FakeNode {
  const col: FakeNode = {
    id: `VariableCollectionId:${collections.length + 1}`,
    name,
    modes: modeNames.map((n, i) => ({ modeId: `m${i}`, name: n })),
    variableIds: [] as string[],
    addMode(n: string) {
      const modeId = `m${this.modes.length}`;
      this.modes.push({ modeId, name: n });
      return modeId;
    },
    renameMode(modeId: string, n: string) {
      const m = this.modes.find((x: { modeId: string }) => x.modeId === modeId);
      if (m) m.name = n;
    },
  };
  collections.push(col);
  return col;
}

function makeVariable(name: string, col: FakeNode, type: string): FakeNode {
  const v: FakeNode = {
    id: `VariableID:${++varCounter}`,
    name,
    resolvedType: type,
    variableCollectionId: col.id,
    valuesByMode: {} as Record<string, unknown>,
    setValueForMode(modeId: string, val: unknown) {
      this.valuesByMode[modeId] = val;
    },
  };
  variablesById.set(v.id, v);
  col.variableIds.push(v.id);
  return v;
}

beforeEach(() => {
  resetKeepClearGroups();
  nodes = new Map();
  components = [];
  collections = [];
  variablesById = new Map();
  seq = 0;
  varCounter = 0;
  page = {
    id: "0:1",
    type: "PAGE",
    name: "Page 1",
    children: [] as FakeNode[],
    appendChild(c: FakeNode) {
      this.children.push(c);
      c.parent = this;
    },
    insertChild(i: number, c: FakeNode) {
      this.children.splice(i, 0, c);
      c.parent = this;
    },
  };
  nodes.set(page.id, page);
  (globalThis as any).figma = {
    currentPage: page,
    mixed: Symbol("mixed"),
    getNodeByIdAsync: vi.fn(async (id: string) => nodes.get(id) ?? null),
    createFrame: () => register(makeNode(`10:${++seq}`, "FRAME")),
    createText: () => register(makeText(`11:${++seq}`)),
    createRectangle: () => register(makeNode(`12:${++seq}`, "RECTANGLE")),
    createComponent: () => register(makeNode(`20:${++seq}`, "COMPONENT")),
    loadAllPagesAsync: vi.fn(async () => {}),
    listAvailableFontsAsync: vi.fn(async () => [
      { fontName: { family: "Inter", style: "Regular" } },
      { fontName: { family: "Inter", style: "Bold" } },
      { fontName: { family: "Courier", style: "Regular" } },
    ]),
    loadFontAsync: vi.fn(async () => {}),
    root: { findAllWithCriteria: vi.fn(() => components) },
    variables: {
      getLocalVariableCollectionsAsync: vi.fn(async () => collections),
      createVariableCollection: vi.fn((name: string) => makeCollection(name)),
      createVariable: vi.fn((name: string, col: FakeNode, type: string) =>
        makeVariable(name, col, type),
      ),
      getVariableByIdAsync: vi.fn(async (id: string) => variablesById.get(id) ?? null),
    },
  };
});

/** A fixed-size parent frame already on the page. */
function addParent(id = "30:1", w = 400, h = 300): FakeNode {
  const parent = register(makeNode(id, "FRAME"));
  parent.width = w;
  parent.height = h;
  page.children.push(parent);
  parent.parent = page;
  return parent;
}

describe("create — nested children", () => {
  it("builds the whole subtree in one call, array order first", async () => {
    const res = (await create(
      ctx({
        type: "FRAME",
        children: [
          { type: "TEXT", name: "title", characters: "Hi" },
          { type: "TEXT", name: "sub", characters: "There" },
        ],
      }),
    )) as { id: string };
    const frame = mustGet(res.id);
    expect(frame.children.map((c: FakeNode) => c.name)).toEqual(["title", "sub"]);
    expect(frame.children.every((c: FakeNode) => c.parent === frame)).toBe(true);
  });

  it("forces the child parentId to the new parent — a spec parentId cannot leak to the page", async () => {
    const res = (await create(
      ctx({
        type: "FRAME",
        children: [{ type: "TEXT", parentId: "9:9", characters: "x" }],
      }),
    )) as { id: string };
    const frame = mustGet(res.id);
    // "9:9" does not exist; had the handler honoured it, this create would
    // have thrown NODE_NOT_FOUND instead of nesting under the new frame.
    expect(frame.children).toHaveLength(1);
    expect(page.children.find((c: FakeNode) => c.type === "TEXT")).toBeUndefined();
  });

  it("recurses to arbitrary depth", async () => {
    const res = (await create(
      ctx({
        type: "FRAME",
        name: "card",
        children: [
          {
            type: "FRAME",
            name: "row",
            children: [
              { type: "TEXT", name: "label", characters: "L" },
              { type: "TEXT", name: "value", characters: "V" },
            ],
          },
        ],
      }),
    )) as { id: string };
    const row = mustGet(res.id).children[0]!;
    expect(row.type).toBe("FRAME");
    expect(row.children.map((c: FakeNode) => c.name)).toEqual(["label", "value"]);
  });

  it("a failing child removes the parent it already placed — no half-built subtree", async () => {
    // An unknown child type throws INVALID_PARAMS AFTER the outer frame was
    // created and appended, which used to leave it orphaned on the canvas.
    await expect(
      create(
        ctx({
          type: "FRAME",
          name: "doomed",
          children: [{ type: "WIDGET" }],
        }),
      ),
    ).rejects.toThrow();
    expect(nodes.get([...nodes.keys()].find((id) => nodes.get(id)?.name === "doomed")!)?.removed).toBe(true);
    expect(page.children.some((c: FakeNode) => c.name === "doomed" && !c.removed)).toBe(false);
  });
});

describe("create — sizing safe defaults", () => {
  it("auto-layout child under a fixed parent defaults counterAxisSizingMode to FIXED", async () => {
    const parent = addParent();
    const c = ctx({ type: "FRAME", parentId: parent.id, layoutMode: "HORIZONTAL", width: 100, height: 50 });
    const res = (await create(c)) as { id: string };
    const node = mustGet(res.id);
    expect(node.counterAxisSizingMode).toBe("FIXED");
    expect(c.warnings.some((w) => /counterAxisSizingMode/.test(w))).toBe(true);
  });

  it("an explicit counterAxisSizingMode is honoured and not warned about", async () => {
    const parent = addParent();
    const c = ctx({
      type: "FRAME",
      parentId: parent.id,
      layoutMode: "HORIZONTAL",
      counterAxisSizingMode: "AUTO",
      width: 100,
      height: 50,
    });
    const res = (await create(c)) as { id: string };
    expect(mustGet(res.id).counterAxisSizingMode).toBe("AUTO");
    expect(c.warnings.some((w) => /counterAxisSizingMode/.test(w))).toBe(false);
  });
});

describe("create — clip warning", () => {
  it("x + w beyond a clipsContent parent warns instead of silently clipping", async () => {
    const parent = addParent("30:1", 320, 240);
    parent.clipsContent = true;
    const c = ctx({ type: "FRAME", parentId: parent.id, x: 260, width: 100 });
    await create(c);
    expect(c.warnings.some((w) => /clipped by its parent/.test(w))).toBe(true);
  });
});

describe("create — text wrap safe defaults", () => {
  it("wrap:true sets textAutoResize HEIGHT + layoutAlign STRETCH", async () => {
    const res = (await create(
      ctx({ type: "TEXT", wrap: true, characters: "A long paragraph" }),
    )) as { id: string };
    const node = mustGet(res.id);
    expect(node.textAutoResize).toBe("HEIGHT");
    expect(node.layoutAlign).toBe("STRETCH");
  });

  it("wrap:true under a parent with no fixed width warns", async () => {
    // The fake page has no `width` property, like an unbounded canvas.
    const c = ctx({ type: "TEXT", wrap: true, characters: "Text" });
    await create(c);
    expect(c.warnings.some((w) => /wrap:true set but parent has no fixed width/.test(w))).toBe(true);
  });

  it("wrap:true under a fixed-width parent does not warn", async () => {
    const parent = addParent();
    const c = ctx({ type: "TEXT", parentId: parent.id, wrap: true, characters: "Text" });
    await create(c);
    expect(c.warnings.some((w) => /no fixed width/.test(w))).toBe(false);
  });
});

describe("create — overlay safe defaults", () => {
  it("create_overlay makes a RECTANGLE sized to the parent, at 0,0 on top", async () => {
    const parent = addParent("30:1", 320, 240);
    const res = (await createOverlay(
      ctx({ parentId: parent.id, color: "#000000", opacity: 0.3 }),
    )) as { id: string };
    const node = mustGet(res.id);
    expect(node.type).toBe("RECTANGLE");
    expect([node.x, node.y, node.width, node.height]).toEqual([0, 0, 320, 240]);
    expect(node.opacity).toBe(0.3);
    expect(node.fills[0].type).toBe("SOLID");
    // "top" insert: the overlay is the last (front-most) child.
    expect(parent.children[parent.children.length - 1]).toBe(node);
  });

  it("FRAME with opacity < 1 warns to use overlay instead", async () => {
    const c = ctx({ type: "FRAME", opacity: 0.5 });
    await create(c);
    expect(c.warnings.some((w) => /opacity < 1 on a FRAME/.test(w))).toBe(true);
  });
});

describe("create — relative layout", () => {
  it("inset {left,right} stretches width against the parent", async () => {
    const parent = addParent("30:1", 400, 300);
    const res = (await create(
      ctx({ type: "FRAME", parentId: parent.id, inset: { left: 16, right: 16 }, height: 100 }),
    )) as { id: string };
    const node = mustGet(res.id);
    expect([node.x, node.width]).toEqual([16, 368]);
  });

  it("align center-x / center-y / center center within the parent", async () => {
    const parent = addParent("30:1", 400, 300);
    const cx = mustGet(
      ((await create(ctx({ type: "FRAME", parentId: parent.id, align: "center-x", width: 100 }))) as { id: string }).id,
    );
    const cy = mustGet(
      ((await create(ctx({ type: "FRAME", parentId: parent.id, align: "center-y", height: 50 }))) as { id: string }).id,
    );
    const cb = mustGet(
      ((await create(ctx({ type: "FRAME", parentId: parent.id, align: "center", width: 100, height: 50 }))) as { id: string }).id,
    );
    expect(cx.x).toBe(150);
    expect(cy.y).toBe(125);
    expect([cb.x, cb.y]).toEqual([150, 125]);
  });
});

describe("create — insertAt z-order", () => {
  function parentWithKids(): FakeNode {
    const parent = addParent();
    for (const id of ["a", "b", "c"]) {
      const kid = makeNode(id, "RECTANGLE");
      parent.children.push(kid);
      kid.parent = parent;
    }
    return parent;
  }

  it.each([
    ["top", 3],
    ["bottom", 0],
    [{ above: "b" }, 2],
    [{ below: "b" }, 1],
    [1, 1],
  ] as const)("insertAt %j lands at index %i", async (insertAt, index) => {
    const parent = parentWithKids();
    const res = (await create(
      ctx({ type: "RECTANGLE", parentId: parent.id, insertAt }),
    )) as { id: string };
    expect(parent.children[index].id).toBe(res.id);
  });
});

describe("modify — safe constraints", () => {
  it("applies name, geometry and a hex fill to the real node", async () => {
    const node = register(makeNode("10:1", "FRAME"));
    await modify(ctx({ nodeId: "10:1", props: { name: "Renamed", w: 50, fill: "#2563eb" } }));
    expect(node.name).toBe("Renamed");
    expect(node.width).toBe(50);
    expect(node.fills[0].color.b).toBeCloseTo(0xeb / 255, 2);
  });

  it("falls back to Inter for an unavailable fontFamily and warns", async () => {
    const node = register(makeText("11:1"));
    const c = ctx({ nodeId: "11:1", props: { fontFamily: "SomeFancyFont" } });
    await modify(c);
    expect(node.fontName.family).toBe("Inter");
    expect(c.warnings.some((w) => /fell back/.test(w))).toBe(true);
  });
});

describe("delete — force safety", () => {
  function addComponentWithInstances(id: string, instanceCount: number): FakeNode {
    const comp = register(makeNode(id, "COMPONENT"));
    comp.getInstancesAsync = vi.fn(async () =>
      Array.from({ length: instanceCount }, (_, i) => ({ id: `I${id};${i}` })),
    );
    return comp;
  }

  it("refuses to delete a component that still has instances", async () => {
    addComponentWithInstances("20:1", 2);
    const error = (await deleteNode(ctx({ nodeId: "20:1" })).catch((e) => e)) as HandlerError;
    expect(error).toBeInstanceOf(HandlerError);
    expect(error.code).toBe(ErrorCode.COMPONENT_IN_USE);
    expect(error.hint).toMatch(/force:true/);
  });

  it("force:true deletes it anyway", async () => {
    const comp = addComponentWithInstances("20:1", 2);
    const res = (await deleteNode(ctx({ nodeId: "20:1", force: true }))) as any;
    expect(res.deleted).toBe(true);
    expect(comp.removed).toBe(true);
  });

  it("a component Figma soft-deletes (removed stays false, parent goes null) counts as deleted", async () => {
    // Live: a main component keeps living for its instances' "Restore
    // component" — `removed` never flips, only the parent link goes.
    const comp = addComponentWithInstances("20:2", 1);
    comp.parent = page;
    comp.remove = function (this: FakeNode) {
      this.parent = null;
    };
    const res = (await deleteNode(ctx({ nodeId: "20:2", force: true }))) as any;
    expect(res).toMatchObject({ id: "20:2", deleted: true, instancesLeft: 1 });
    expect(res.note).toMatch(/Restore component/);
  });

  it("removing the last variant reports the set went with it", async () => {
    const set = register(makeNode("30:1", "COMPONENT_SET"));
    set.name = "Button";
    const variant = addComponentWithInstances("30:2", 0);
    set.appendChild(variant);
    const res = (await deleteNode(ctx({ nodeId: "30:2" }))) as any;
    expect(res.componentSetDeleted).toBe("Button");
  });

  it("a page id is pointed at deletePage instead of 'not found'", async () => {
    const pg = register(makeNode("0:9", "PAGE"));
    pg.name = "Old";
    const error = (await deleteNode(ctx({ nodeId: "0:9" })).catch((e) => e)) as HandlerError;
    expect(error.code).toBe(ErrorCode.INVALID_PARAMS);
    expect(error.hint).toMatch(/deletePage/);
  });

  it("a plain node deletes without force", async () => {
    const node = register(makeNode("10:1", "FRAME"));
    const res = (await deleteNode(ctx({ nodeId: "10:1" }))) as any;
    expect(res).toEqual({ id: "10:1", deleted: true });
    expect(node.removed).toBe(true);
  });

  it("a remove() that silently does nothing is reported, not claimed", async () => {
    const node = register(makeNode("10:1", "FRAME"));
    node.parent = page; // still attached
    node.remove = () => {}; // e.g. a locked node — removed stays false
    const error = (await deleteNode(ctx({ nodeId: "10:1" })).catch((e) => e)) as HandlerError;
    expect(error.code).toBe(ErrorCode.INTERNAL);
  });
});

describe("fonts — fallback chain", () => {
  it("create TEXT reports {requestedFont, resolvedFont, reason} on substitution", async () => {
    const res = (await create(
      ctx({ type: "TEXT", characters: "Hi", fontFamily: "SomeFancyFont" }),
    )) as any;
    expect(res.font.requestedFont.family).toBe("SomeFancyFont");
    expect(res.font.resolvedFont.family).toBe("Inter");
    // `font` carries a reason only when a substitution happened.
    expect(res.font.reason).toMatch(/fell back/);
  });
});

describe("clone — child mapping", () => {
  it("returns a childMap of original → cloned ids, including the root", async () => {
    const original = register(makeNode("frame-1", "FRAME"));
    const t1 = makeNode("text-1", "TEXT");
    const r1 = makeNode("rect-1", "RECTANGLE");
    original.children.push(t1, r1);
    page.children.push(original);
    original.parent = page;
    original.clone = () => {
      const c = makeNode("frame-2", "FRAME");
      const t2 = makeNode("text-2", "TEXT");
      const r2 = makeNode("rect-2", "RECTANGLE");
      c.children.push(t2, r2);
      return c;
    };
    const res = (await clone(ctx({ nodeId: "frame-1" }))) as any;
    expect(res.id).toBe("frame-2");
    expect(res.childMap).toEqual({
      "frame-1": "frame-2",
      "text-1": "text-2",
      "rect-1": "rect-2",
    });
  });
});

describe("tokens — setupTokens", () => {
  it("creates variables in one collection and writes every mode explicitly", async () => {
    const res = (await setupTokens(
      ctx({
        tokens: {
          colors: { primary: { light: "#ffffff", dark: "#000000" } },
          numbers: { "radius-md": 8 },
        },
      }),
    )) as any;
    expect(res.collection).toBe("Reqwise Tokens");
    expect(res.modes).toEqual(["light", "dark"]);
    expect(res.created).toEqual(["primary", "radius-md"]);

    const primary = [...variablesById.values()].find((v) => v.name === "primary")!;
    // Both modes got a real value — the old bug left non-default modes unset.
    expect(primary.valuesByMode.m0.a).toBeCloseTo(1, 5);
    expect(primary.valuesByMode.m1.r).toBe(0);
    const radius = [...variablesById.values()].find((v) => v.name === "radius-md")!;
    expect(radius.valuesByMode).toEqual({ m0: 8, m1: 8 });
  });

  it("is idempotent: a second identical call updates, not recreates", async () => {
    const params = { tokens: { colors: { primary: "#2563EB" } } };
    const first = (await setupTokens(ctx(params))) as any;
    expect(first.created).toEqual(["primary"]);
    const second = (await setupTokens(ctx(params))) as any;
    expect(second.created).toEqual([]);
    expect(second.updated).toEqual(["primary"]);
    expect(collections).toHaveLength(1);
  });
});

describe("error reporting", () => {
  it("a missing parentId throws HandlerError with code, message and hint", async () => {
    const error = (await create(ctx({ type: "FRAME", parentId: "9:9" })).catch(
      (e) => e,
    )) as HandlerError;
    expect(error).toBeInstanceOf(HandlerError);
    expect(error.code).toBe(ErrorCode.NODE_NOT_FOUND);
    expect(error.message).toContain("9:9");
    expect(error.hint).toBeDefined();
  });

  it("toBridgeError passes HandlerError through and wraps anything else as INTERNAL", () => {
    const handled = toBridgeError(
      new HandlerError(ErrorCode.NODE_NOT_FOUND, "gone", "try get_selection"),
    );
    expect(handled).toEqual({
      code: ErrorCode.NODE_NOT_FOUND,
      message: "gone",
      hint: "try get_selection",
    });
    const wrapped = toBridgeError(new Error("boom"));
    expect(wrapped.code).toBe(ErrorCode.INTERNAL);
    expect(wrapped.message).toBe("boom");
  });
});
