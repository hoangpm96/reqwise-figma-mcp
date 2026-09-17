import { beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "../../../src/plugin/handlers/create.js";
import { makeContext } from "../../../src/plugin/context.js";
import { defaultLineHeight } from "../../../src/plugin/layout-math.js";

/**
 * Tastiness defaults on create() — the "make it look less like a wireframe"
 * pass. A bare TEXT used to come out Inter Regular 12px pure-black with AUTO
 * line-height; a bare auto-layout used to come out with itemSpacing 0. These
 * tests pin the new defaults AND that an explicit value / textStyle still wins
 * (no bias over the caller's intent). See create.applyText / applyAutoLayout.
 */

let created: any;
let autoFrame: any;

function makeFigma() {
  const page: any = {
    id: "0:1",
    type: "PAGE",
    children: [],
    appendChild(n: any) { this.children.push(n); n.parent = this; },
    insertChild(i: number, n: any) { this.children.splice(i, 0, n); n.parent = this; },
  };
  return {
    currentPage: page,
    mixed: Symbol("mixed"),
    getNodeByIdAsync: vi.fn(async (id: string) => (id === "0:1" ? page : null)),
    listAvailableFontsAsync: vi.fn(async () => [
      { fontName: { family: "Inter", style: "Regular" } },
    ]),
    loadFontAsync: vi.fn(async () => {}),
    createText: vi.fn(() => {
      // Deliberately weird starting values so a passing assertion proves the
      // handler WROTE the default, not that the mock happened to match.
      created = {
        id: "10:5", type: "TEXT", name: "", characters: "",
        fontName: { family: "Inter", style: "Regular" },
        fontSize: 99,
        textAlignHorizontal: "LEFT", textAlignVertical: "TOP",
        textAutoResize: "WIDTH_AND_HEIGHT",
        width: 40, height: 20, x: 0, y: 0,
        lineHeight: { unit: "AUTO" },
        letterSpacing: { value: 0, unit: "PIXELS" },
        textCase: "ORIGINAL", textDecoration: "NONE",
        fills: [],
        resize(w: number, h: number) { this.width = w; this.height = h; },
      };
      return created;
    }),
    createFrame: vi.fn(() => {
      autoFrame = {
        id: "20:1", type: "FRAME", name: "", children: [],
        layoutMode: "NONE", itemSpacing: 0,
        paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0,
        primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO",
        primaryAxisAlignItems: "MIN", counterAxisAlignItems: "MIN",
        width: 100, height: 100, x: 0, y: 0,
        fills: [], strokes: [],
        appendChild(n: any) { this.children.push(n); n.parent = this; },
        insertChild(i: number, n: any) { this.children.splice(i, 0, n); n.parent = this; },
        resize(w: number, h: number) { this.width = w; this.height = h; },
      };
      return autoFrame;
    }),
  };
}

describe("create(TEXT) — default typography (no wireframe look)", () => {
  beforeEach(() => {
    created = null;
    (globalThis as any).figma = makeFigma();
  });

  it("defaults fontSize to 16 (not Figma's native 12) when omitted", async () => {
    const ctx = makeContext({ type: "TEXT", parentId: "0:1", characters: "Hi" }, () => {});
    await create(ctx);
    expect(created.fontSize).toBe(16);
  });

  it("honors an explicit fontSize (caller's intent wins)", async () => {
    const ctx = makeContext(
      { type: "TEXT", parentId: "0:1", characters: "Hi", fontSize: 24 },
      () => {},
    );
    await create(ctx);
    expect(created.fontSize).toBe(24);
  });

  it("sets a size-aware line height for ALL text, not only wrapped", async () => {
    const ctx = makeContext(
      { type: "TEXT", parentId: "0:1", characters: "Hi", fontSize: 32 },
      () => {},
    );
    await create(ctx);
    expect(created.lineHeight).toEqual({ value: defaultLineHeight(32), unit: "PIXELS" });
  });

  it("honors an explicit lineHeight (previously dropped on create)", async () => {
    const ctx = makeContext(
      { type: "TEXT", parentId: "0:1", characters: "Hi", fontSize: 16, lineHeight: "150%" },
      () => {},
    );
    await create(ctx);
    expect(created.lineHeight).toEqual({ value: 150, unit: "PERCENT" });
  });

  it("honors letterSpacing (previously dropped on create)", async () => {
    const ctx = makeContext(
      { type: "TEXT", parentId: "0:1", characters: "Hi", letterSpacing: "-2%" },
      () => {},
    );
    await create(ctx);
    expect(created.letterSpacing).toEqual({ value: -2, unit: "PERCENT" });
  });

  it("warns when a TEXT is created with no color (would render pure black)", async () => {
    const ctx = makeContext({ type: "TEXT", parentId: "0:1", characters: "Hi" }, () => {});
    await create(ctx);
    expect(ctx.warnings.join(" ")).toContain("pure black");
  });

  it("does NOT warn about color when a fill is given", async () => {
    const ctx = makeContext(
      { type: "TEXT", parentId: "0:1", characters: "Hi", fill: "#111111" },
      () => {},
    );
    await create(ctx);
    expect(ctx.warnings.join(" ")).not.toContain("pure black");
  });
});

describe("create(auto-layout) — default gap", () => {
  beforeEach(() => {
    autoFrame = null;
    (globalThis as any).figma = makeFigma();
  });

  it("defaults itemSpacing to 8 (not 0) and warns when omitted", async () => {
    const ctx = makeContext({ type: "FRAME", parentId: "0:1", layoutMode: "VERTICAL" }, () => {});
    await create(ctx);
    expect(autoFrame.itemSpacing).toBe(8);
    expect(ctx.warnings.join(" ")).toContain("itemSpacing");
  });

  it("honors an explicit itemSpacing of 0 (seamless list) with no gap warning", async () => {
    const ctx = makeContext(
      { type: "FRAME", parentId: "0:1", layoutMode: "VERTICAL", itemSpacing: 0 },
      () => {},
    );
    await create(ctx);
    expect(autoFrame.itemSpacing).toBe(0);
    expect(ctx.warnings.join(" ")).not.toContain("defaulted the gap");
  });
});
