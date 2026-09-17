import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deletePage,
  deleteStyle,
  deleteUnusedStyles,
} from "../../../src/plugin/handlers/cleanup.js";
import { makeContext } from "../../../src/plugin/context.js";
import { HandlerError } from "../../../src/plugin/errors.js";
import { ErrorCode } from "../../../src/shared/protocol.js";

type Fake = Record<string, any>;
const MIXED = Symbol("mixed");
const ctx = (params: Record<string, unknown>) => makeContext(params, () => {});
const fail = (p: Promise<unknown>) => p.catch((e) => e) as Promise<HandlerError>;

let root: Fake;
let styles: Record<string, Fake[]>;

function page(id: string, name: string, children: Fake[] = []): Fake {
  const pg: Fake = {
    id,
    name,
    type: "PAGE",
    children,
    loadAsync: vi.fn(async () => {}),
    remove: vi.fn(() => {
      root.children = root.children.filter((c: Fake) => c !== pg);
    }),
  };
  return pg;
}

function style(type: string, name: string): Fake {
  let removed = false;
  const s: Fake = { id: `S:${name},1`, type, remote: false };
  // Live Figma: every property of a removed style throws.
  Object.defineProperty(s, "name", {
    get: () => {
      if (removed) throw new Error(`in get_name: The style with id "${s.id}" does not exist`);
      return name;
    },
  });
  s.remove = vi.fn(() => {
    removed = true;
    styles[type] = styles[type]!.filter((x) => x !== s);
  });
  styles[type]!.push(s);
  return s;
}

function setup(pages: Fake[], current = pages[0]): void {
  root = { children: pages };
  styles = { PAINT: [], TEXT: [], EFFECT: [], GRID: [] };
  (globalThis as any).figma = {
    mixed: MIXED,
    root,
    currentPage: current,
    loadAllPagesAsync: vi.fn(async () => {}),
    setCurrentPageAsync: vi.fn(async (pg: Fake) => {
      (globalThis as any).figma.currentPage = pg;
    }),
    commitUndo: vi.fn(),
    loadFontAsync: vi.fn(async () => {}),
    getLocalPaintStylesAsync: async () => styles.PAINT,
    getLocalTextStylesAsync: async () => styles.TEXT,
    getLocalEffectStylesAsync: async () => styles.EFFECT,
    getLocalGridStylesAsync: async () => styles.GRID,
    getStyleByIdAsync: async () => null,
  };
  // root is replaced on page removal; keep the global pointing at it
  Object.defineProperty((globalThis as any).figma, "root", { get: () => root });
}

describe("delete_page", () => {
  it("refuses the only page", async () => {
    setup([page("0:1", "Only")]);
    const e = await fail(deletePage(ctx({ page: "Only" })));
    expect(e.code).toBe(ErrorCode.INVALID_PARAMS);
  });

  it("an empty page goes without force", async () => {
    const keep = page("0:1", "Keep");
    const old = page("0:2", "Old");
    setup([keep, old]);
    const res = (await deletePage(ctx({ page: "old" }))) as any;
    expect(res).toMatchObject({ deleted: "Old", layersRemoved: 0 });
    expect(root.children).toEqual([keep]);
  });

  it("a page with layers needs force, and says what is on it", async () => {
    const old = page("0:2", "Old", [
      { id: "1:1", name: "Screen A", type: "FRAME", children: [] },
      { id: "1:2", name: "Button", type: "COMPONENT", children: [] },
    ]);
    setup([page("0:1", "Keep"), old]);
    const e = await fail(deletePage(ctx({ page: "0:2" })));
    expect(e.code).toBe(ErrorCode.CONFIRM_REQUIRED);
    expect(e.message).toMatch(/2 top-level layer\(s\), including 1 component/);
    expect(e.message).toContain("Screen A");
    expect(old.remove).not.toHaveBeenCalled();

    const res = (await deletePage(ctx({ page: "0:2", force: true }))) as any;
    expect(res.layersRemoved).toBe(2);
    expect(res.note).toMatch(/Restore component/);
  });

  it("switches off the current page before removing it", async () => {
    const a = page("0:1", "A");
    const b = page("0:2", "B");
    setup([a, b], a);
    const res = (await deletePage(ctx({ page: "A" }))) as any;
    expect((globalThis as any).figma.setCurrentPageAsync).toHaveBeenCalledWith(b);
    expect(res.switchedTo).toBe("B");
    expect(root.children).toEqual([b]);
  });

  it("an ambiguous name asks for the id", async () => {
    setup([page("0:1", "Draft"), page("0:2", "draft"), page("0:3", "X")]);
    const e = await fail(deletePage(ctx({ page: "Draft" })));
    expect(e.code).toBe(ErrorCode.INVALID_PARAMS);
    expect(e.hint).toContain("0:1");
  });

  it("a remove() Figma refused is reported, not claimed", async () => {
    const old = page("0:2", "Old");
    setup([page("0:1", "Keep"), old]);
    old.remove = vi.fn();
    const e = await fail(deletePage(ctx({ page: "Old" })));
    expect(e.code).toBe(ErrorCode.INTERNAL);
  });
});

describe("delete_style", () => {
  function rect(id: string, fillStyleId = ""): Fake {
    const n: Fake = { id, type: "RECTANGLE", fillStyleId, strokeStyleId: "", effectStyleId: "" };
    n.setFillStyleIdAsync = vi.fn(async (sid: string) => {
      n.fillStyleId = sid;
    });
    return n;
  }

  it("an unused style deletes cleanly", async () => {
    setup([page("0:1", "P"), page("0:2", "Q")]);
    const s = style("PAINT", "brand/old");
    const res = (await deleteStyle(ctx({ style: "brand/old" }))) as any;
    expect(s.remove).toHaveBeenCalled();
    expect(res).toMatchObject({ deleted: "brand/old", type: "PAINT", usagesFound: 0 });
  });

  it("a used style is gated", async () => {
    setup([page("0:1", "P", [])]);
    const s = style("PAINT", "brand/primary");
    root.children[0].children.push(rect("1:1", s.id), rect("1:2", s.id));
    const e = await fail(deleteStyle(ctx({ style: "brand/primary" })));
    expect(e.code).toBe(ErrorCode.COMPONENT_IN_USE);
    expect(e.message).toMatch(/2 layer/);
    expect(s.remove).not.toHaveBeenCalled();
  });

  it("replaceWith moves the layers first, then deletes", async () => {
    setup([page("0:1", "P", [])]);
    const old = style("PAINT", "old");
    const next = style("PAINT", "new");
    const a = rect("1:1", old.id);
    root.children[0].children.push({ id: "1:0", type: "FRAME", fillStyleId: "", children: [a] });
    const res = (await deleteStyle(ctx({ style: "old", replaceWith: "new" }))) as any;
    expect(a.fillStyleId).toBe(next.id);
    expect(res).toMatchObject({ usagesFound: 1, rebound: 1, replacedWith: "new" });
    expect(old.remove).toHaveBeenCalled();
  });

  it("replaceWith must be the same style type", async () => {
    setup([page("0:1", "P")]);
    style("PAINT", "old");
    style("TEXT", "Body");
    const e = await fail(deleteStyle(ctx({ style: "old", replaceWith: "Body" })));
    expect(e.code).toBe(ErrorCode.NODE_NOT_FOUND);
  });

  it("finds a text style used on part of a text layer", async () => {
    setup([page("0:1", "P", [])]);
    const body = style("TEXT", "Body");
    const lead = style("TEXT", "Lead");
    const text: Fake = {
      id: "2:1",
      type: "TEXT",
      characters: "Hello world",
      fillStyleId: "",
      textStyleId: MIXED,
      getStyledTextSegments: () => [
        { start: 0, end: 5, textStyleId: body.id },
        { start: 5, end: 11, textStyleId: "" },
      ],
      getRangeAllFontNames: () => [{ family: "Inter", style: "Regular" }],
      setRangeTextStyleIdAsync: vi.fn(async () => {}),
    };
    root.children[0].children.push(text);
    const res = (await deleteStyle(ctx({ style: "Body", replaceWith: "Lead" }))) as any;
    expect(text.setRangeTextStyleIdAsync).toHaveBeenCalledWith(0, 5, lead.id);
    expect(res.rebound).toBe(1);
  });

  it("the same name on two types asks for type", async () => {
    setup([page("0:1", "P")]);
    style("PAINT", "brand");
    style("EFFECT", "brand");
    const e = await fail(deleteStyle(ctx({ style: "brand" })));
    expect(e.code).toBe(ErrorCode.INVALID_PARAMS);
    const res = (await deleteStyle(ctx({ style: "brand", type: "effect" }))) as any;
    expect(res.type).toBe("EFFECT");
  });
});

describe("delete_unused_styles", () => {
  function scene(): { used: Fake; unusedA: Fake; unusedB: Fake } {
    setup([page("0:1", "P", [])]);
    const used = style("PAINT", "used");
    const unusedA = style("PAINT", "unused-a");
    const unusedB = style("EFFECT", "unused-b");
    root.children[0].children.push({ id: "1:1", type: "RECTANGLE", fillStyleId: used.id });
    return { used, unusedA, unusedB };
  }

  it("without confirm it only previews", async () => {
    const { used, unusedA, unusedB } = scene();
    const res = (await deleteUnusedStyles(ctx({}))) as any;
    expect(res.preview).toBe(true);
    expect(res.wouldDelete.map((s: Fake) => s.name).sort()).toEqual(["unused-a", "unused-b"]);
    expect(res.inUse).toBe(1);
    expect(res.confirmToken).toMatch(/^del-2-/);
    expect(res.next).toMatch(/ask them to confirm/);
    for (const s of [used, unusedA, unusedB]) expect(s.remove).not.toHaveBeenCalled();
  });

  it("the preview's token deletes exactly that list", async () => {
    const { used, unusedA, unusedB } = scene();
    const { confirmToken } = (await deleteUnusedStyles(ctx({}))) as any;
    const res = (await deleteUnusedStyles(ctx({ confirm: confirmToken }))) as any;
    expect(res.count).toBe(2);
    expect(res.deleted.sort()).toEqual(["unused-a", "unused-b"]);
    expect(unusedA.remove).toHaveBeenCalled();
    expect(unusedB.remove).toHaveBeenCalled();
    expect(used.remove).not.toHaveBeenCalled();
  });

  it("a stale token deletes nothing", async () => {
    const { unusedA } = scene();
    const { confirmToken } = (await deleteUnusedStyles(ctx({}))) as any;
    style("GRID", "added-after-preview");
    const e = await fail(deleteUnusedStyles(ctx({ confirm: confirmToken })));
    expect(e.code).toBe(ErrorCode.CONFIRM_REQUIRED);
    expect(unusedA.remove).not.toHaveBeenCalled();
  });

  it("types and keep narrow the list, and the token follows them", async () => {
    const { unusedA, unusedB } = scene();
    const preview = (await deleteUnusedStyles(ctx({ types: ["effect", "paint"], keep: ["unused-a"] }))) as any;
    expect(preview.wouldDelete.map((s: Fake) => s.name)).toEqual(["unused-b"]);
    expect(preview.kept).toBe(1);
    // the same token without the same filters does not match
    const e = await fail(deleteUnusedStyles(ctx({ confirm: preview.confirmToken })));
    expect(e.code).toBe(ErrorCode.CONFIRM_REQUIRED);
    await deleteUnusedStyles(ctx({ types: ["effect", "paint"], keep: ["unused-a"], confirm: preview.confirmToken }));
    expect(unusedB.remove).toHaveBeenCalled();
    expect(unusedA.remove).not.toHaveBeenCalled();
  });
});
