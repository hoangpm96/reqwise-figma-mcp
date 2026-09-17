import { beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "../../../src/plugin/handlers/create.js";
import { createOverlay, loadImage } from "../../../src/plugin/handlers/assets.js";
import { makeContext } from "../../../src/plugin/context.js";
import { resetKeepClearGroups } from "../../../src/plugin/keep-clear.js";

/**
 * A GROUP (or BOOLEAN_OPERATION) is not a coordinate space: its children's
 * x/y are in the containing frame's coordinates. inset/align used to be
 * resolved as if the group sat at 0,0, so `inset:{left:8}` inside a group at
 * x=500 landed at x=8 — outside the group entirely.
 */

function ctx(params: Record<string, unknown>) {
  return makeContext(params, () => {});
}

function container(id: string, type: string, x: number, y: number, w: number, h: number): any {
  return {
    id,
    type,
    name: type,
    x,
    y,
    width: w,
    height: h,
    visible: true,
    opacity: 1,
    fills: [],
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
  };
}

function leaf(id: string, type: string): any {
  return {
    id,
    type,
    name: "",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    visible: true,
    opacity: 1,
    fills: [],
    strokes: [],
    resize(w: number, h: number) {
      this.width = w;
      this.height = h;
    },
    setBoundVariable: vi.fn(),
  };
}

let page: any;
let group: any;

beforeEach(() => {
  resetKeepClearGroups();
  page = container("0:1", "PAGE", 0, 0, 0, 0);
  delete page.width;
  delete page.height;
  const frame = container("1:1", "FRAME", 0, 0, 1000, 1000);
  (frame as any).layoutMode = "NONE";
  page.appendChild(frame);
  group = container("2:1", "GROUP", 500, 300, 200, 100);
  frame.appendChild(group);
  let seq = 0;
  (globalThis as any).figma = {
    currentPage: page,
    mixed: Symbol("mixed"),
    getNodeByIdAsync: vi.fn(async (id: string) =>
      id === "2:1" ? group : id === "1:1" ? frame : id === "0:1" ? page : null,
    ),
    createRectangle: vi.fn(() => leaf(`10:${++seq}`, "RECTANGLE")),
    createFrame: vi.fn(() => {
      const n = leaf(`11:${++seq}`, "FRAME");
      n.layoutMode = "NONE";
      n.children = [];
      return n;
    }),
    createImage: vi.fn(() => ({
      hash: "h",
      getSizeAsync: async () => ({ width: 40, height: 20 }),
    })),
  };
});

describe("placing into a GROUP", () => {
  it("create: inset left/top is measured from the group's own corner", async () => {
    const res = (await create(
      ctx({ type: "RECTANGLE", parentId: "2:1", width: 20, height: 20, inset: { left: 8, top: 4 } }),
    )) as { id: string };
    const node = group.children.find((n: any) => n.id === res.id);
    expect([node.x, node.y]).toEqual([508, 304]);
  });

  it("create: right/bottom inset and center align use the group's width/height and offset", async () => {
    const a = (await create(
      ctx({ type: "RECTANGLE", parentId: "2:1", width: 20, height: 20, inset: { right: 10, bottom: 10 } }),
    )) as { id: string };
    const na = group.children.find((n: any) => n.id === a.id);
    expect([na.x, na.y]).toEqual([500 + 200 - 10 - 20, 300 + 100 - 10 - 20]);

    const b = (await create(
      ctx({ type: "RECTANGLE", parentId: "2:1", width: 20, height: 20, align: "center" }),
    )) as { id: string };
    const nb = group.children.find((n: any) => n.id === b.id);
    expect([nb.x, nb.y]).toEqual([590, 340]);
  });

  it("create: a plain x/y stays raw — Figma already reads it in frame coordinates", async () => {
    const res = (await create(
      ctx({ type: "RECTANGLE", parentId: "2:1", width: 20, height: 20, x: 520, y: 310 }),
    )) as { id: string };
    const node = group.children.find((n: any) => n.id === res.id);
    expect([node.x, node.y]).toEqual([520, 310]);
  });

  it("create: a BOOLEAN_OPERATION parent is offset the same way", async () => {
    group.type = "BOOLEAN_OPERATION";
    const res = (await create(
      ctx({ type: "RECTANGLE", parentId: "2:1", width: 20, height: 20, inset: { left: 8 } }),
    )) as { id: string };
    const node = group.children.find((n: any) => n.id === res.id);
    expect(node.x).toBe(508);
  });

  it("load_image: inset inside a group is offset by the group's corner", async () => {
    const res = (await loadImage(
      ctx({ base64: "AAAA", parentId: "2:1", inset: { left: 8, top: 4 } }),
    )) as { id: string };
    const node = group.children.find((n: any) => n.id === res.id);
    expect([node.x, node.y]).toEqual([508, 304]);
  });

  it("create_overlay: covers the group where it is, not the frame's corner", async () => {
    const res = (await createOverlay(ctx({ parentId: "2:1" }))) as { id: string };
    const node = group.children.find((n: any) => n.id === res.id);
    expect([node.x, node.y, node.width, node.height]).toEqual([500, 300, 200, 100]);
  });
});
