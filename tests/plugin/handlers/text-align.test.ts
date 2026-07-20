import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyTextAlign } from "../../../src/plugin/handlers/text.js";
import { create } from "../../../src/plugin/handlers/create.js";
import { makeContext } from "../../../src/plugin/context.js";

/**
 * Regression tests for the silent-drop bug: `textAlignHorizontal` /
 * `textAlignVertical` were never written on create OR modify, so an agent
 * setting them got a {ok:true} no-op and left-aligned text. See the field
 * plumbing in create.applyText / write.modifyText and the shared helper in
 * handlers/text.applyTextAlign.
 */

function fakeTextNode(): any {
  return {
    type: "TEXT",
    textAlignHorizontal: "LEFT",
    textAlignVertical: "TOP",
  };
}

describe("applyTextAlign — the alignment write that used to be dropped", () => {
  it("writes textAlignHorizontal onto the node", () => {
    const node = fakeTextNode();
    applyTextAlign(node, { textAlignHorizontal: "CENTER" });
    expect(node.textAlignHorizontal).toBe("CENTER");
  });

  it("writes textAlignVertical onto the node", () => {
    const node = fakeTextNode();
    applyTextAlign(node, { textAlignVertical: "BOTTOM" });
    expect(node.textAlignVertical).toBe("BOTTOM");
  });

  it("normalizes case (center → CENTER)", () => {
    const node = fakeTextNode();
    applyTextAlign(node, { textAlignHorizontal: "center" });
    expect(node.textAlignHorizontal).toBe("CENTER");
  });

  it("leaves alignment untouched when the field is absent", () => {
    const node = fakeTextNode();
    applyTextAlign(node, { fontSize: 16 });
    expect(node.textAlignHorizontal).toBe("LEFT");
    expect(node.textAlignVertical).toBe("TOP");
  });

  it("throws INVALID_PARAMS on a bad enum instead of silently no-op'ing", () => {
    const node = fakeTextNode();
    expect(() => applyTextAlign(node, { textAlignHorizontal: "MIDDLE" })).toThrow(
      /Invalid textAlignHorizontal/,
    );
    // The bad value must NOT have been partially applied.
    expect(node.textAlignHorizontal).toBe("LEFT");
  });

  it("supports JUSTIFIED for horizontal", () => {
    const node = fakeTextNode();
    applyTextAlign(node, { textAlignHorizontal: "JUSTIFIED" });
    expect(node.textAlignHorizontal).toBe("JUSTIFIED");
  });
});

describe("create(TEXT) — textAlignHorizontal reaches the node", () => {
  let created: any;

  beforeEach(() => {
    const page: any = {
      id: "0:1",
      type: "PAGE",
      children: [],
      appendChild(n: any) { this.children.push(n); n.parent = this; },
      insertChild(i: number, n: any) { this.children.splice(i, 0, n); n.parent = this; },
    };
    created = null;

    (globalThis as any).figma = {
      currentPage: page,
      mixed: Symbol("mixed"),
      getNodeByIdAsync: vi.fn(async (id: string) => (id === "0:1" ? page : null)),
      listAvailableFontsAsync: vi.fn(async () => [
        { fontName: { family: "Inter", style: "Regular" } },
      ]),
      loadFontAsync: vi.fn(async () => {}),
      createText: vi.fn(() => {
        created = {
          id: "10:5",
          type: "TEXT",
          name: "",
          characters: "",
          fontName: { family: "Inter", style: "Regular" },
          fontSize: 16,
          textAlignHorizontal: "LEFT",
          textAlignVertical: "TOP",
          textAutoResize: "WIDTH_AND_HEIGHT",
          width: 40,
          height: 20,
          x: 0,
          y: 0,
          lineHeight: { unit: "AUTO" },
          letterSpacing: { value: 0 },
          textCase: "ORIGINAL",
          textDecoration: "NONE",
          fills: [],
          resize(w: number, h: number) { this.width = w; this.height = h; },
        };
        return created;
      }),
    };
  });

  it("create({ textAlignHorizontal: 'CENTER' }) sets it on the TEXT node", async () => {
    const ctx = makeContext(
      { type: "TEXT", parentId: "0:1", characters: "Hello", textAlignHorizontal: "CENTER" },
      () => {},
    );
    await create(ctx);
    expect(created.textAlignHorizontal).toBe("CENTER");
  });

  it("create with a bad alignment value rejects (no silent no-op)", async () => {
    const ctx = makeContext(
      { type: "TEXT", parentId: "0:1", characters: "Hello", textAlignHorizontal: "BOGUS" },
      () => {},
    );
    await expect(create(ctx)).rejects.toThrow(/Invalid textAlignHorizontal/);
  });
});
