import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  setupTextStyles,
  setTextStyle,
  parseLineHeight,
  parseLetterSpacing,
} from "../../../src/plugin/handlers/styles.js";
import { makeContext } from "../../../src/plugin/context.js";

/**
 * setup_text_styles / set_text_style — the typography half of the design
 * system. Upsert-by-name (idempotent), enum/shape mistakes throw INVALID_PARAMS
 * (never a silent no-op), and applying resolves styles by name with candidate
 * hints on a miss.
 */

function ctx(params: Record<string, unknown>) {
  return makeContext(params, () => {});
}

function fakeTextStyle(id: string, name: string): any {
  return {
    id,
    name,
    fontName: { family: "Inter", style: "Regular" },
    fontSize: 16,
    description: "",
  };
}

let localStyles: any[];
let createdStyles: any[];

beforeEach(() => {
  localStyles = [];
  createdStyles = [];
  (globalThis as any).figma = {
    mixed: Symbol("mixed"),
    getLocalTextStylesAsync: vi.fn(async () => localStyles),
    createTextStyle: vi.fn(() => {
      const s = fakeTextStyle(`S:${createdStyles.length + 1}`, "");
      createdStyles.push(s);
      localStyles.push(s);
      return s;
    }),
    listAvailableFontsAsync: vi.fn(async () =>
      ["Regular", "Medium", "Bold"].map((style) => ({
        fontName: { family: "Inter", style },
      })),
    ),
    loadFontAsync: vi.fn(async () => {}),
    getNodeByIdAsync: vi.fn(async () => null),
  };
});

describe("setupTextStyles", () => {
  it("creates the ramp and maps numeric weight → font style", async () => {
    const res: any = await setupTextStyles(
      ctx({
        styles: [
          { name: "Title 01", fontSize: 40, weight: 700, lineHeight: "120%" },
          { name: "Body", fontSize: 14 },
        ],
      }),
    );
    expect(res.created).toEqual(["Title 01", "Body"]);
    expect(res.updated).toEqual([]);
    expect(createdStyles[0].fontName).toEqual({ family: "Inter", style: "Bold" });
    expect(createdStyles[0].fontSize).toBe(40);
    expect(createdStyles[0].lineHeight).toEqual({ unit: "PERCENT", value: 120 });
    expect(createdStyles[1].fontName).toEqual({
      family: "Inter",
      style: "Regular",
    });
  });

  it("is idempotent: re-running updates in place instead of duplicating", async () => {
    await setupTextStyles(ctx({ styles: [{ name: "Body", fontSize: 14 }] }));
    const res: any = await setupTextStyles(
      ctx({ styles: [{ name: "Body", fontSize: 16 }] }),
    );
    expect(res.created).toEqual([]);
    expect(res.updated).toEqual(["Body"]);
    expect(localStyles).toHaveLength(1);
    expect(localStyles[0].fontSize).toBe(16);
  });

  it("throws INVALID_PARAMS on a missing name", async () => {
    await expect(
      setupTextStyles(ctx({ styles: [{ fontSize: 14 }] })),
    ).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  });

  it("throws INVALID_PARAMS on a missing/invalid fontSize", async () => {
    await expect(
      setupTextStyles(ctx({ styles: [{ name: "Body" }] })),
    ).rejects.toMatchObject({
      code: "INVALID_PARAMS",
      message: expect.stringContaining("fontSize"),
    });
  });

  it("throws INVALID_PARAMS on an unknown weight", async () => {
    await expect(
      setupTextStyles(ctx({ styles: [{ name: "Body", fontSize: 14, weight: 450 }] })),
    ).rejects.toMatchObject({
      code: "INVALID_PARAMS",
      message: expect.stringContaining("450"),
    });
  });

  it("throws on duplicate names within one call", async () => {
    await expect(
      setupTextStyles(
        ctx({
          styles: [
            { name: "Body", fontSize: 14 },
            { name: "Body", fontSize: 16 },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  });

  it("throws on an empty styles array", async () => {
    await expect(setupTextStyles(ctx({ styles: [] }))).rejects.toMatchObject({
      code: "INVALID_PARAMS",
    });
  });

  it("warns (not throws) when the font substitutes via fallback", async () => {
    const c = ctx({
      styles: [{ name: "Fancy", fontSize: 20, fontFamily: "NoSuchFont" }],
    });
    await setupTextStyles(c);
    expect(c.warnings.length).toBeGreaterThan(0);
    expect(c.warnings[0]).toContain("Fancy");
  });
});

describe("setTextStyle", () => {
  let textNode: any;

  beforeEach(() => {
    localStyles.push(
      fakeTextStyle("S:10", "Title 01"),
      fakeTextStyle("S:11", "Title 02"),
      fakeTextStyle("S:12", "Body"),
    );
    textNode = {
      id: "1:1",
      type: "TEXT",
      name: "heading",
      x: 0,
      y: 0,
      width: 100,
      height: 20,
      characters: "Hi",
      textAutoResize: "WIDTH_AND_HEIGHT",
      fontSize: 16,
      lineHeight: { unit: "AUTO" },
      fontName: { family: "Inter", style: "Regular" },
      textStyleId: "",
    };
    (globalThis as any).figma.getNodeByIdAsync = vi.fn(async (id: string) =>
      id === "1:1" ? textNode : null,
    );
  });

  it("applies a style by exact name", async () => {
    const res: any = await setTextStyle(ctx({ nodeId: "1:1", style: "Title 02" }));
    expect(textNode.textStyleId).toBe("S:11");
    expect(res.styleName).toBe("Title 02");
  });

  it("prefers setTextStyleIdAsync when available", async () => {
    const spy = vi.fn(async (id: string) => {
      textNode.textStyleId = id;
    });
    textNode.setTextStyleIdAsync = spy;
    await setTextStyle(ctx({ nodeId: "1:1", style: "Body" }));
    expect(spy).toHaveBeenCalledWith("S:12");
  });

  it("resolves an unambiguous partial match", async () => {
    await setTextStyle(ctx({ nodeId: "1:1", style: "body" }));
    expect(textNode.textStyleId).toBe("S:12");
  });

  it("throws with candidates when the name is ambiguous", async () => {
    await expect(
      setTextStyle(ctx({ nodeId: "1:1", style: "Title" })),
    ).rejects.toMatchObject({
      code: "INVALID_PARAMS",
      hint: expect.stringContaining("Title 01"),
    });
  });

  it("throws with candidates when no style matches", async () => {
    await expect(
      setTextStyle(ctx({ nodeId: "1:1", style: "Caption" })),
    ).rejects.toMatchObject({
      code: "INVALID_PARAMS",
      message: expect.stringContaining("Caption"),
    });
  });

  it("throws INVALID_PARAMS on a non-TEXT node", async () => {
    textNode.type = "FRAME";
    await expect(
      setTextStyle(ctx({ nodeId: "1:1", style: "Body" })),
    ).rejects.toMatchObject({
      code: "INVALID_PARAMS",
      message: expect.stringContaining("FRAME"),
    });
  });
});

describe("parse helpers", () => {
  it("parseLineHeight: px, %, auto, object", () => {
    expect(parseLineHeight(24)).toEqual({ unit: "PIXELS", value: 24 });
    expect(parseLineHeight("150%")).toEqual({ unit: "PERCENT", value: 150 });
    expect(parseLineHeight("auto")).toEqual({ unit: "AUTO" });
    expect(parseLineHeight({ unit: "PERCENT", value: 120 })).toEqual({
      unit: "PERCENT",
      value: 120,
    });
    expect(() => parseLineHeight("big")).toThrow(/Invalid lineHeight/);
  });

  it("parseLetterSpacing: px, %, bad shape", () => {
    expect(parseLetterSpacing(0.5)).toEqual({ unit: "PIXELS", value: 0.5 });
    expect(parseLetterSpacing("-2%")).toEqual({ unit: "PERCENT", value: -2 });
    expect(() => parseLetterSpacing("wide")).toThrow(/Invalid letterSpacing/);
  });
});
