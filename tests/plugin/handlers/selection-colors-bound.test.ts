import { beforeEach, describe, expect, it } from "vitest";
import { setSelectionColors } from "../../../src/plugin/handlers/paint-edit.js";
import { makeContext } from "../../../src/plugin/context.js";

/**
 * A SOLID paint bound to a color variable renders the variable, whatever its
 * `color` field says. Recoloring it with `{...paint, color}` kept the binding,
 * so set_selection_colors reported the paint as changed while the canvas still
 * showed the token colour.
 */

const BLUE = { r: 0, g: 0, b: 1 };

let root: any;

beforeEach(() => {
  const bound = {
    id: "1:2",
    type: "RECTANGLE",
    fills: [
      {
        type: "SOLID",
        color: BLUE,
        boundVariables: { color: { type: "VARIABLE_ALIAS", id: "VariableID:1" } },
      },
    ],
    strokes: [],
  };
  const plain = { id: "1:3", type: "RECTANGLE", fills: [{ type: "SOLID", color: BLUE }], strokes: [] };
  root = { id: "1:1", type: "FRAME", fills: [], strokes: [], children: [bound, plain] };
  (globalThis as any).figma = {
    mixed: Symbol("mixed"),
    currentPage: { selection: [] },
    getNodeByIdAsync: async (id: string) => (id === "1:1" ? root : null),
  };
});

describe("set_selection_colors on token-bound paints", () => {
  it("does not count a bound paint as changed, leaves its binding, and says so", async () => {
    const c = makeContext({ nodeId: "1:1", from: "#0000ff", to: "#ff0000" }, () => {});
    const res = (await setSelectionColors(c)) as { changed: number; skippedBound?: number };
    expect(res.changed).toBe(1);
    expect(res.skippedBound).toBe(1);
    const [bound, plain] = root.children;
    expect(bound.fills[0].color).toEqual(BLUE);
    expect(bound.fills[0].boundVariables.color.id).toBe("VariableID:1");
    expect(plain.fills[0].color).toEqual({ r: 1, g: 0, b: 0 });
    expect(c.warnings.some((w) => /bound to a color variable/.test(w))).toBe(true);
  });
});
