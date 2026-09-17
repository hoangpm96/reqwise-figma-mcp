import { beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "../../../src/plugin/handlers/create.js";
import { makeContext } from "../../../src/plugin/context.js";
import { resetKeepClearGroups } from "../../../src/plugin/keep-clear.js";

/**
 * Proactive create-time guards (warnings, never blocking) for two silent traps:
 *  1. A page-level node that lands on an existing screen — the "component
 *     stacked on Home" bug. No longer a warning: the node is moved clear.
 *  2. A container's fill exactly matches its parent's fill — a same-colour
 *     wrapper that reads as a slab instead of sitting on the surface.
 */

function ctx(params: Record<string, unknown>) {
  return makeContext(params, () => {});
}

let page: any;

function solid(hex: { r: number; g: number; b: number }) {
  return [{ type: "SOLID", color: hex }];
}

function fakeFrame(id = "10:1"): any {
  return {
    id,
    type: "FRAME",
    name: "",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    visible: true,
    opacity: 1,
    layoutMode: "NONE",
    clipsContent: false,
    fills: solid({ r: 1, g: 1, b: 1 }),
    strokes: [],
    children: [],
    appendChild(n: any) {
      this.children.push(n);
      n.parent = this;
    },
    insertChild(i: number, n: any) {
      this.children.splice(i, 0, n);
      n.parent = this;
    },
    resize(w: number, h: number) {
      this.width = w;
      this.height = h;
    },
    setBoundVariable: vi.fn(),
  };
}

/** A pre-existing top-level screen sitting at (0,0). */
function existingScreen(): any {
  return {
    id: "9:1",
    type: "FRAME",
    name: "Wallet/Screen/Home",
    x: 0,
    y: 0,
    width: 390,
    height: 844,
  };
}

beforeEach(() => {
  resetKeepClearGroups();
  page = {
    id: "0:1",
    type: "PAGE",
    children: [],
    appendChild(n: any) {
      this.children.push(n);
      n.parent = this;
    },
    insertChild(i: number, n: any) {
      this.children.splice(i, 0, n);
      n.parent = this;
    },
  };
  let seq = 0;
  (globalThis as any).figma = {
    currentPage: page,
    mixed: Symbol("mixed"),
    getNodeByIdAsync: vi.fn(async (id: string) =>
      id === "0:1" ? page : page.children.find((c: any) => c.id === id) ?? null,
    ),
    createFrame: vi.fn(() => fakeFrame(`10:${++seq}`)),
    createComponent: vi.fn(() => {
      const n = fakeFrame(`20:${++seq}`);
      n.type = "COMPONENT";
      return n;
    }),
  };
});

describe("keepClearOnCanvas", () => {
  it("moves a page-level node with no x/y off the screen it landed on, keeping x", async () => {
    page.children.push(existingScreen());
    const c = ctx({ type: "COMPONENT", width: 342, height: 68 });
    const res = (await create(c)) as { id: string };
    const node = page.children.find((n: any) => n.id === res.id);
    expect(node.x).toBe(0);
    expect(node.y).toBeGreaterThanOrEqual(844 + 120);
    expect(c.warnings.some((w) => /overlapped existing "Wallet\/Screen\/Home"/.test(w))).toBe(true);
  });

  it("moves it too when the overlap came from explicit x/y — guessed coordinates are how work got covered", async () => {
    page.children.push(existingScreen());
    const c = ctx({ type: "FRAME", width: 200, height: 200, x: 100, y: 300 });
    const res = (await create(c)) as { id: string; node: { x: number; y: number } };
    const node = page.children.find((n: any) => n.id === res.id);
    expect(node.x).toBe(100);
    expect(node.y).toBeGreaterThanOrEqual(844);
    // The result reports where the node IS, not where it was asked to go
    // (independent check saw 0,0 echoed after a move to 0,990).
    expect(res.node.y).toBe(node.y);
  });

  it("leaves a clear spot alone, even right beside existing work", async () => {
    page.children.push(existingScreen());
    const c = ctx({ type: "FRAME", width: 390, height: 844, x: 430, y: 0 });
    const res = (await create(c)) as { id: string };
    const node = page.children.find((n: any) => n.id === res.id);
    expect([node.x, node.y]).toEqual([430, 0]);
    expect(c.warnings.some((w) => /overlapped/.test(w))).toBe(false);
  });

  it("allowOverlap:true lays it on top on purpose", async () => {
    page.children.push(existingScreen());
    const c = ctx({ type: "FRAME", width: 100, height: 100, x: 10, y: 10, allowOverlap: true });
    const res = (await create(c)) as { id: string };
    const node = page.children.find((n: any) => n.id === res.id);
    expect([node.x, node.y]).toEqual([10, 10]);
  });

  it("one call's screens move as a row: the same offset, and never obstacles to each other", async () => {
    page.children.push(existingScreen());
    const a = (await create(ctx({ type: "FRAME", width: 375, height: 800, x: 0, y: 0, placeGroup: "run-1" }))) as { id: string };
    // Starts beside the old screen, so on its own it would not have moved.
    const b = (await create(ctx({ type: "FRAME", width: 375, height: 800, x: 415, y: 0, placeGroup: "run-1" }))) as { id: string };
    const na = page.children.find((n: any) => n.id === a.id);
    const nb = page.children.find((n: any) => n.id === b.id);
    expect(na.y).toBeGreaterThan(0);
    expect(nb.y).toBe(na.y);
    expect(nb.x).toBe(415);
  });

  it("does NOT move a nested node (positioned by its parent, not the page)", async () => {
    const parent = fakeFrame("11:1");
    parent.layoutMode = "VERTICAL";
    page.children.push(parent);
    (globalThis as any).figma.getNodeByIdAsync = vi.fn(async (id: string) =>
      id === "11:1" ? parent : id === "0:1" ? page : null,
    );
    const c = ctx({ type: "FRAME", parentId: "11:1", width: 50, height: 50 });
    await create(c);
    expect(c.warnings.some((w) => /overlapped/.test(w))).toBe(false);
  });
});

describe("warnIfWrapperFillMatchesParent", () => {
  it("warns when a child frame's fill equals its container parent's fill", async () => {
    const parent = fakeFrame("12:1"); // white parent
    parent.fills = solid({ r: 1, g: 1, b: 1 });
    page.children.push(parent);
    (globalThis as any).figma.getNodeByIdAsync = vi.fn(async (id: string) =>
      id === "12:1" ? parent : id === "0:1" ? page : null,
    );
    const c = ctx({ type: "FRAME", parentId: "12:1", fill: "#ffffff" });
    await create(c);
    expect(c.warnings.some((w) => /same fill|slab|transparent/.test(w))).toBe(true);
  });

  it("does NOT warn when child and parent fills differ", async () => {
    const parent = fakeFrame("13:1");
    parent.fills = solid({ r: 0.96, g: 0.96, b: 0.97 }); // grey bg
    page.children.push(parent);
    (globalThis as any).figma.getNodeByIdAsync = vi.fn(async (id: string) =>
      id === "13:1" ? parent : id === "0:1" ? page : null,
    );
    const c = ctx({ type: "FRAME", parentId: "13:1", fill: "#ffffff" });
    await create(c);
    expect(c.warnings.some((w) => /same fill/.test(w))).toBe(false);
  });

  it("does NOT warn about a diagram's own notation label", async () => {
    // A sequence diagram's `else` caption is a white pill sitting ON the
    // dashed divider it interrupts: the matching fill IS the point of it, and
    // an agent that "fixes" this by going transparent breaks the notation.
    const parent = fakeFrame("14:1");
    parent.fills = solid({ r: 1, g: 1, b: 1 });
    page.children.push(parent);
    (globalThis as any).figma.getNodeByIdAsync = vi.fn(async (id: string) =>
      id === "14:1" ? parent : id === "0:1" ? page : null,
    );
    const c = ctx({ type: "FRAME", name: "frag-else-label frag0", parentId: "14:1", fill: "#ffffff" });
    await create(c);
    expect(c.warnings.some((w) => /same fill|slab/.test(w))).toBe(false);
  });
});

describe("hex fill and stroke next to an empty fills (seen live on the style board)", () => {
  it("a hex fill beats fills: []", async () => {
    const res = (await create(ctx({ type: "FRAME", width: 80, height: 40, x: 0, y: 2000, fills: [], fill: "#2563eb" }))) as { id: string };
    const node = page.children.find((n: any) => n.id === res.id);
    expect(node.fills).toHaveLength(1);
    expect(node.fills[0].color.b).toBeCloseTo(0xeb / 255, 2);
  });

  it("fills: [] alone stays transparent", async () => {
    const res = (await create(ctx({ type: "FRAME", width: 80, height: 40, x: 0, y: 2000, fills: [] }))) as { id: string };
    expect(page.children.find((n: any) => n.id === res.id).fills).toEqual([]);
  });

  it("a hex stroke is drawn, not dropped", async () => {
    const res = (await create(ctx({ type: "FRAME", width: 80, height: 40, x: 0, y: 2000, stroke: "#a5a09a", strokeWeight: 1 }))) as { id: string };
    const node = page.children.find((n: any) => n.id === res.id);
    expect(node.strokes).toHaveLength(1);
    expect(node.strokes[0].type).toBe("SOLID");
  });
});
