import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyTextTypography,
} from "../../../src/plugin/handlers/text.js";
import { create } from "../../../src/plugin/handlers/create.js";
import { makeContext } from "../../../src/plugin/context.js";

/**
 * Regression tests for silent-drop typography props: lineHeight, letterSpacing,
 * textCase, textDecoration, paragraphSpacing were serialized on read but never
 * written on create/modify — same class as the textAlign fix.
 */

function fakeTextNode(): any {
  return {
    type: "TEXT",
    lineHeight: { unit: "AUTO" },
    letterSpacing: { unit: "PIXELS", value: 0 },
    textCase: "ORIGINAL",
    textDecoration: "NONE",
    paragraphSpacing: 0,
  };
}

describe("applyTextTypography — props that used to be silently dropped", () => {
  it("writes lineHeight as PIXELS from a bare number", () => {
    const node = fakeTextNode();
    applyTextTypography(node, { lineHeight: 24 });
    expect(node.lineHeight).toEqual({ unit: "PIXELS", value: 24 });
  });

  it("writes lineHeight AUTO from string", () => {
    const node = fakeTextNode();
    applyTextTypography(node, { lineHeight: "AUTO" });
    expect(node.lineHeight).toEqual({ unit: "AUTO" });
  });

  it("writes lineHeight PERCENT from '150%'", () => {
    const node = fakeTextNode();
    applyTextTypography(node, { lineHeight: "150%" });
    expect(node.lineHeight).toEqual({ unit: "PERCENT", value: 150 });
  });

  it("writes lineHeight from Figma-native object", () => {
    const node = fakeTextNode();
    applyTextTypography(node, {
      lineHeight: { unit: "PERCENT", value: 140 },
    });
    expect(node.lineHeight).toEqual({ unit: "PERCENT", value: 140 });
  });

  it("writes letterSpacing from a bare number (PIXELS)", () => {
    const node = fakeTextNode();
    applyTextTypography(node, { letterSpacing: 0.5 });
    expect(node.letterSpacing).toEqual({ unit: "PIXELS", value: 0.5 });
  });

  it("writes letterSpacing percent string", () => {
    const node = fakeTextNode();
    applyTextTypography(node, { letterSpacing: "2%" });
    expect(node.letterSpacing).toEqual({ unit: "PERCENT", value: 2 });
  });

  it("writes textCase (case-normalized)", () => {
    const node = fakeTextNode();
    applyTextTypography(node, { textCase: "upper" });
    expect(node.textCase).toBe("UPPER");
  });

  it("writes textDecoration UNDERLINE", () => {
    const node = fakeTextNode();
    applyTextTypography(node, { textDecoration: "UNDERLINE" });
    expect(node.textDecoration).toBe("UNDERLINE");
  });

  it("writes paragraphSpacing", () => {
    const node = fakeTextNode();
    applyTextTypography(node, { paragraphSpacing: 12 });
    expect(node.paragraphSpacing).toBe(12);
  });

  it("leaves fields untouched when absent", () => {
    const node = fakeTextNode();
    applyTextTypography(node, { fontSize: 16 });
    expect(node.lineHeight).toEqual({ unit: "AUTO" });
    expect(node.letterSpacing).toEqual({ unit: "PIXELS", value: 0 });
    expect(node.textCase).toBe("ORIGINAL");
    expect(node.textDecoration).toBe("NONE");
    expect(node.paragraphSpacing).toBe(0);
  });

  it("throws INVALID_PARAMS on bad lineHeight instead of no-op", () => {
    const node = fakeTextNode();
    expect(() => applyTextTypography(node, { lineHeight: "tall" })).toThrow(
      /Invalid lineHeight/,
    );
    expect(node.lineHeight).toEqual({ unit: "AUTO" });
  });

  it("throws INVALID_PARAMS on bad textCase", () => {
    const node = fakeTextNode();
    expect(() => applyTextTypography(node, { textCase: "CAPS" })).toThrow(
      /Invalid textCase/,
    );
    expect(node.textCase).toBe("ORIGINAL");
  });

  it("throws INVALID_PARAMS on non-number paragraphSpacing", () => {
    const node = fakeTextNode();
    expect(() =>
      applyTextTypography(node, { paragraphSpacing: "wide" }),
    ).toThrow(/Invalid paragraphSpacing/);
    expect(node.paragraphSpacing).toBe(0);
  });
});

describe("create(TEXT) — typography props reach the node", () => {
  let created: any;

  beforeEach(() => {
    const page: any = {
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
          id: "10:6",
          type: "TEXT",
          name: "",
          characters: "",
          fontName: { family: "Inter", style: "Regular" },
          fontSize: 16,
          textAlignHorizontal: "LEFT",
          textAlignVertical: "TOP",
          textAutoResize: "WIDTH_AND_HEIGHT",
          layoutAlign: "INHERIT",
          width: 40,
          height: 20,
          x: 0,
          y: 0,
          lineHeight: { unit: "AUTO" },
          letterSpacing: { unit: "PIXELS", value: 0 },
          textCase: "ORIGINAL",
          textDecoration: "NONE",
          paragraphSpacing: 0,
          fills: [],
          resize(w: number, h: number) {
            this.width = w;
            this.height = h;
          },
        };
        return created;
      }),
    };
  });

  it("create applies lineHeight / letterSpacing / textCase / textDecoration", async () => {
    const ctx = makeContext(
      {
        type: "TEXT",
        parentId: "0:1",
        characters: "Hello",
        lineHeight: 22,
        letterSpacing: 0.4,
        textCase: "UPPER",
        textDecoration: "UNDERLINE",
        paragraphSpacing: 8,
      },
      () => {},
    );
    await create(ctx);
    expect(created.lineHeight).toEqual({ unit: "PIXELS", value: 22 });
    expect(created.letterSpacing).toEqual({ unit: "PIXELS", value: 0.4 });
    expect(created.textCase).toBe("UPPER");
    expect(created.textDecoration).toBe("UNDERLINE");
    expect(created.paragraphSpacing).toBe(8);
  });

  it("explicit lineHeight wins over wrap:true default", async () => {
    const ctx = makeContext(
      {
        type: "TEXT",
        parentId: "0:1",
        characters: "Wrapped",
        wrap: true,
        lineHeight: 28,
      },
      () => {},
    );
    await create(ctx);
    expect(created.textAutoResize).toBe("HEIGHT");
    expect(created.layoutAlign).toBe("STRETCH");
    expect(created.lineHeight).toEqual({ unit: "PIXELS", value: 28 });
  });

  it("wrap:true still sets default lineHeight when none provided", async () => {
    const ctx = makeContext(
      {
        type: "TEXT",
        parentId: "0:1",
        characters: "Wrapped",
        wrap: true,
        fontSize: 16,
      },
      () => {},
    );
    await create(ctx);
    // wrapLineHeight(16) ≈ 1.45 * 16 = 23.2
    expect(created.lineHeight.unit).toBe("PIXELS");
    expect(created.lineHeight.value).toBeCloseTo(23.2, 1);
  });

  it("create with bad lineHeight rejects (no silent no-op)", async () => {
    const ctx = makeContext(
      {
        type: "TEXT",
        parentId: "0:1",
        characters: "Hello",
        lineHeight: { unit: "EM", value: 1.2 },
      },
      () => {},
    );
    await expect(create(ctx)).rejects.toThrow(/Invalid lineHeight/);
  });
});
