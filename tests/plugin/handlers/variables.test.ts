import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createVariable,
  updateVariable,
  renameVariable,
  deleteVariable,
} from "../../../src/plugin/handlers/tokens.js";
import { makeContext, HandlerContext } from "../../../src/plugin/context.js";
import { HandlerError } from "../../../src/plugin/errors.js";
import { ErrorCode } from "../../../src/shared/protocol.js";

type FakeNode = Record<string, any>;

let collections: FakeNode[];
let variablesById: Map<string, FakeNode>;
let varCounter: number;

function makeCollection(name: string, modeNames: string[] = ["Mode 1"]): FakeNode {
  const col: FakeNode = {
    id: `VariableCollectionId:${collections.length + 1}`,
    name,
    modes: modeNames.map((n, i) => ({ modeId: `m${i}`, name: n })),
    defaultModeId: "m0",
    variableIds: [],
    addMode: vi.fn((n: string) => {
      const modeId = `m${col.modes.length}`;
      col.modes.push({ modeId, name: n });
      return modeId;
    }),
    renameMode: vi.fn(),
  };
  collections.push(col);
  return col;
}

function makeVariable(
  name: string,
  col: FakeNode,
  type = "COLOR",
  valuesByMode: Record<string, unknown> = {},
): FakeNode {
  const v: FakeNode = {
    id: `VariableID:${++varCounter}`,
    name,
    resolvedType: type,
    variableCollectionId: col.id,
    description: "",
    valuesByMode,
    setValueForMode: vi.fn(function (this: FakeNode, modeId: string, val: unknown) {
      v.valuesByMode[modeId] = val;
    }),
    remove: vi.fn(),
  };
  variablesById.set(v.id, v);
  col.variableIds.push(v.id);
  return v;
}

function ctx(params: Record<string, unknown>): HandlerContext {
  return makeContext(params, () => {});
}

beforeEach(() => {
  collections = [];
  variablesById = new Map();
  varCounter = 0;
  (globalThis as any).figma = {
    root: { children: [] },
    loadAllPagesAsync: async () => {},
    variables: {
      getLocalVariableCollectionsAsync: async () => collections,
      getVariableCollectionByIdAsync: async (id: string) =>
        collections.find((c) => c.id === id) ?? null,
      getVariableByIdAsync: async (id: string) => variablesById.get(id) ?? null,
      createVariableCollection: vi.fn((name: string) => makeCollection(name)),
      createVariable: vi.fn((name: string, col: FakeNode, type: string) =>
        makeVariable(name, col, type),
      ),
      setBoundVariableForPaint: vi.fn((paint: FakeNode, _f: string, variable: FakeNode) => ({
        ...paint,
        boundVariables: { color: { type: "VARIABLE_ALIAS", id: variable.id } },
      })),
    },
    mixed: Symbol("mixed"),
  };
});

describe("create_variable", () => {
  it("infers COLOR from hex and writes ALL modes explicitly", async () => {
    makeCollection("Reqwise Tokens", ["light", "dark"]);
    const res = (await createVariable(
      ctx({ name: "primary", value: "#3366ee" }),
    )) as any;
    expect(res.type).toBe("COLOR");
    const v = variablesById.get(res.id)!;
    expect(v.setValueForMode).toHaveBeenCalledTimes(2); // both modes
    expect(res.modes).toEqual(["light", "dark"]);
  });

  it("valuesByMode targets modes by name and creates missing ones", async () => {
    const col = makeCollection("Reqwise Tokens", ["light"]);
    const res = (await createVariable(
      ctx({ name: "bg", valuesByMode: { light: "#ffffff", dark: "#111111" } }),
    )) as any;
    expect(col.addMode).toHaveBeenCalledWith("dark");
    expect(res.modes).toEqual(["light", "dark"]);
  });

  it("duplicate name in the collection is rejected", async () => {
    const col = makeCollection("Reqwise Tokens");
    makeVariable("primary", col);
    const e = (await createVariable(
      ctx({ name: "primary", value: "#000000" }),
    ).catch((x) => x)) as HandlerError;
    expect(e).toBeInstanceOf(HandlerError);
    expect(e.code).toBe(ErrorCode.INVALID_PARAMS);
    expect(e.hint).toContain("update_variable");
  });

  it("unknown named collection errors unless createCollection: true", async () => {
    makeCollection("Reqwise Tokens");
    const e = (await createVariable(
      ctx({ name: "x", value: 4, collection: "Brand" }),
    ).catch((x) => x)) as HandlerError;
    expect(e.code).toBe(ErrorCode.NODE_NOT_FOUND);
    const res = (await createVariable(
      ctx({ name: "x", value: 4, collection: "Brand", createCollection: true }),
    )) as any;
    expect(res.collection).toBe("Brand");
    expect(res.type).toBe("FLOAT");
  });
});

describe("update / rename", () => {
  it("update_variable by name writes values and description", async () => {
    const col = makeCollection("Reqwise Tokens", ["light", "dark"]);
    const v = makeVariable("primary", col);
    const res = (await updateVariable(
      ctx({ variable: "primary", value: "#ff0000", description: "brand red" }),
    )) as any;
    expect(v.description).toBe("brand red");
    expect(v.setValueForMode).toHaveBeenCalledTimes(2);
    expect(res.changed).toContain("description");
  });

  it("update with nothing to change is INVALID_PARAMS", async () => {
    const col = makeCollection("Reqwise Tokens");
    makeVariable("primary", col);
    const e = (await updateVariable(ctx({ variable: "primary" })).catch((x) => x)) as HandlerError;
    expect(e.code).toBe(ErrorCode.INVALID_PARAMS);
  });

  it("rename_variable keeps the id (bindings follow the id)", async () => {
    const col = makeCollection("Reqwise Tokens");
    const v = makeVariable("primary", col);
    const res = (await renameVariable(
      ctx({ variable: "primary", newName: "color/primary" }),
    )) as any;
    expect(res).toMatchObject({
      id: v.id,
      oldName: "primary",
      name: "color/primary",
      referencesKept: true,
    });
    expect(v.name).toBe("color/primary");
  });
});

describe("delete_variable — replace-gate", () => {
  function pageWithBoundNodes(varId: string): void {
    (globalThis as any).figma.root.children = [
      {
        id: "0:1",
        type: "PAGE",
        children: [
          {
            id: "40:1",
            type: "FRAME",
            boundVariables: { cornerRadius: { type: "VARIABLE_ALIAS", id: varId } },
            setBoundVariable: vi.fn(),
            children: [],
          },
          {
            id: "40:2",
            type: "RECTANGLE",
            fills: [
              {
                type: "SOLID",
                color: { r: 0, g: 0, b: 0 },
                boundVariables: { color: { type: "VARIABLE_ALIAS", id: varId } },
              },
            ],
          },
        ],
      },
    ];
  }

  it("unused variable deletes cleanly", async () => {
    const col = makeCollection("Reqwise Tokens");
    const v = makeVariable("old", col);
    const res = (await deleteVariable(ctx({ variable: "old" }))) as any;
    expect(v.remove).toHaveBeenCalled();
    expect(res).toMatchObject({ deleted: "old", usagesFound: 0 });
  });

  it("bound variable without replaceWith/force is gated", async () => {
    const col = makeCollection("Reqwise Tokens");
    const v = makeVariable("primary", col);
    pageWithBoundNodes(v.id);
    const e = (await deleteVariable(ctx({ variable: "primary" })).catch((x) => x)) as HandlerError;
    expect(e).toBeInstanceOf(HandlerError);
    expect(e.code).toBe(ErrorCode.COMPONENT_IN_USE);
    expect(e.message).toContain("2");
    expect(v.remove).not.toHaveBeenCalled();
  });

  it("replaceWith rebinds field + paint consumers, then deletes", async () => {
    const col = makeCollection("Reqwise Tokens");
    const v = makeVariable("primary", col);
    const next = makeVariable("primary2", col);
    pageWithBoundNodes(v.id);
    const res = (await deleteVariable(
      ctx({ variable: "primary", replaceWith: "primary2" }),
    )) as any;
    expect(res).toMatchObject({ usagesFound: 2, rebound: 2, replacedWith: "primary2" });
    const page = (globalThis as any).figma.root.children[0];
    expect(page.children[0].setBoundVariable).toHaveBeenCalledWith("cornerRadius", next);
    expect(page.children[1].fills[0].boundVariables.color.id).toBe(next.id);
    expect(v.remove).toHaveBeenCalled();
  });

  it("type mismatch on replaceWith is rejected", async () => {
    const col = makeCollection("Reqwise Tokens");
    makeVariable("primary", col, "COLOR");
    makeVariable("radius", col, "FLOAT");
    const e = (await deleteVariable(
      ctx({ variable: "primary", replaceWith: "radius" }),
    ).catch((x) => x)) as HandlerError;
    expect(e.code).toBe(ErrorCode.INVALID_PARAMS);
  });

  it("force: true deletes despite usages", async () => {
    const col = makeCollection("Reqwise Tokens");
    const v = makeVariable("primary", col);
    pageWithBoundNodes(v.id);
    const res = (await deleteVariable(ctx({ variable: "primary", force: true }))) as any;
    expect(v.remove).toHaveBeenCalled();
    expect(res.usagesFound).toBe(2);
    expect(res.rebound).toBe(0);
  });
});

describe("export_tokens / import_tokens", () => {
  async function seedKit() {
    const { exportTokens } = await import("../../../src/plugin/handlers/tokens.js");
    const col = makeCollection("Reqwise Tokens", ["light", "dark"]);
    const primary = makeVariable("color/primary", col, "COLOR", {
      m0: { r: 0.2, g: 0.4, b: 1, a: 1 },
      m1: { r: 0.5, g: 0.7, b: 1, a: 1 },
    });
    makeVariable("color/accent", col, "COLOR", {
      m0: { type: "VARIABLE_ALIAS", id: primary.id },
      m1: { type: "VARIABLE_ALIAS", id: primary.id },
    });
    makeVariable("radius", col, "FLOAT", { m0: 8, m1: 8 });
    return { exportTokens, col };
  }

  it("exports DTCG with hex colors and alias refs", async () => {
    const { exportTokens } = await seedKit();
    const res = (await exportTokens(ctx({ format: "dtcg" }))) as any;
    expect(res.count).toBe(3);
    expect(res.tokens.color.primary.$value).toMatch(/^#/);
    expect(res.tokens.color.accent.$value).toBe("{color.primary}");
    expect(res.tokens.radius.$value).toBe(8);
  });

  it("exports CSS with data-theme overrides and var() aliases", async () => {
    const { exportTokens } = await seedKit();
    const res = (await exportTokens(ctx({ format: "css" }))) as any;
    expect(res.content).toContain("--color-primary:");
    expect(res.content).toContain("--color-accent: var(--color-primary);");
    expect(res.content).toContain('[data-theme="dark"]');
  });

  it("exports a Tailwind theme extension", async () => {
    const { exportTokens } = await seedKit();
    const res = (await exportTokens(ctx({ format: "tailwind" }))) as any;
    expect(res.content).toContain("module.exports =");
    expect(res.content).toContain('"radius": "8px"');
  });

  it("unknown collection errors, empty file gets a create hint", async () => {
    const { exportTokens } = await import("../../../src/plugin/handlers/tokens.js");
    const e = (await exportTokens(ctx({ collection: "Nope" })).catch((x: unknown) => x)) as HandlerError;
    expect(e).toBeInstanceOf(HandlerError);
    expect(e.code).toBe(ErrorCode.NODE_NOT_FOUND);
  });

  it("imports a DTCG tree: literals first, aliases second", async () => {
    const { importTokens } = await import("../../../src/plugin/handlers/tokens.js");
    makeCollection("Reqwise Tokens", ["light"]);
    const res = (await importTokens(
      ctx({
        tokens: {
          color: {
            primary: { $type: "color", $value: "#3366ee" },
            accent: { $value: "{color.primary}" },
          },
          radius: { $value: 8 },
        },
      }),
    )) as any;
    expect(res.created.sort()).toEqual(["color/accent", "color/primary", "radius"]);
    expect(res.aliased).toBe(1);
    const accent = [...variablesById.values()].find((v) => v.name === "color/accent")!;
    const primary = [...variablesById.values()].find((v) => v.name === "color/primary")!;
    expect(accent.valuesByMode.m0).toEqual({ type: "VARIABLE_ALIAS", id: primary.id });
  });

  it("modes form writes per mode and creates missing modes", async () => {
    const { importTokens } = await import("../../../src/plugin/handlers/tokens.js");
    const col = makeCollection("Reqwise Tokens", ["light"]);
    const res = (await importTokens(
      ctx({
        modes: {
          light: { bg: { $type: "color", $value: "#ffffff" } },
          dark: { bg: { $type: "color", $value: "#111111" } },
        },
      }),
    )) as any;
    expect(col.addMode).toHaveBeenCalledWith("dark");
    expect(res.created).toEqual(["bg"]);
    const bg = [...variablesById.values()].find((v) => v.name === "bg")!;
    expect(Object.keys(bg.valuesByMode)).toEqual(["m0", "m1"]);
  });

  it("type conflicts warn instead of failing the whole import", async () => {
    const { importTokens } = await import("../../../src/plugin/handlers/tokens.js");
    const col = makeCollection("Reqwise Tokens", ["light"]);
    makeVariable("radius", col, "COLOR"); // wrong type on purpose
    const c = ctx({ tokens: { radius: { $value: 8 }, gap: { $value: 4 } } });
    const res = (await importTokens(c)) as any;
    expect(res.created).toEqual(["gap"]);
    expect(c.warnings.join(" ")).toContain("radius");
  });
});
