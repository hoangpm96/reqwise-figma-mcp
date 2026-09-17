import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupEffectStyles } from "../../../src/plugin/handlers/styles.js";
import { makeContext } from "../../../src/plugin/context.js";

/**
 * setup_effect_styles makes elevation TOKENIZABLE — previously effect styles
 * could be counted but never created, so kits came out flat (effect:0).
 */

let store: Array<{ id: string; name: string; effects: any[]; description?: string }>;

function installFigma() {
  store = [];
  let seq = 0;
  (globalThis as any).figma = {
    getLocalEffectStylesAsync: vi.fn(async () => store),
    createEffectStyle: vi.fn(() => {
      const st: any = { id: `S:${++seq}`, name: "", effects: [], description: "" };
      store.push(st);
      return st;
    }),
  };
}

const CARD = {
  name: "elevation/card",
  effects: [
    { type: "DROP_SHADOW", color: "#1C202412", offset: { x: 0, y: 1 }, radius: 2 },
    { type: "DROP_SHADOW", color: "#1C20240F", offset: { x: 0, y: 4 }, radius: 12, spread: -2 },
  ],
};

describe("setupEffectStyles", () => {
  beforeEach(installFigma);

  it("creates a new effect style with its layered shadows", async () => {
    const ctx = makeContext({ styles: [CARD] }, () => {});
    const res: any = await setupEffectStyles(ctx);
    expect(res.created).toEqual(["elevation/card"]);
    expect(store).toHaveLength(1);
    expect(store[0]!.name).toBe("elevation/card");
    expect(store[0]!.effects).toHaveLength(2);
    expect(store[0]!.effects[0].type).toBe("DROP_SHADOW");
  });

  it("is idempotent — re-running updates in place, no duplicate", async () => {
    await setupEffectStyles(makeContext({ styles: [CARD] }, () => {}));
    const res: any = await setupEffectStyles(
      makeContext({ styles: [{ ...CARD }] }, () => {}),
    );
    expect(res.updated).toEqual(["elevation/card"]);
    expect(store).toHaveLength(1); // not 2
  });

  it("rejects an empty styles array", async () => {
    await expect(
      setupEffectStyles(makeContext({ styles: [] }, () => {})),
    ).rejects.toThrow(/non-empty/);
  });

  it("rejects a style with no effects", async () => {
    await expect(
      setupEffectStyles(makeContext({ styles: [{ name: "x", effects: [] }] }, () => {})),
    ).rejects.toThrow(/effects array/);
  });

  it("rejects a nameless style", async () => {
    await expect(
      setupEffectStyles(makeContext({ styles: [{ effects: CARD.effects }] }, () => {})),
    ).rejects.toThrow(/name/);
  });
});
