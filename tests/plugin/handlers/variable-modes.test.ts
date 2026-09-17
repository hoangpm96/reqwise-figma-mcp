import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ensureMode,
  setupTokens,
  createVariable,
  importTokens,
} from "../../../src/plugin/handlers/tokens.js";
import { makeContext, HandlerContext } from "../../../src/plugin/context.js";
import { HandlerError } from "../../../src/plugin/errors.js";
import { ErrorCode } from "../../../src/shared/protocol.js";

/**
 * Variable modes are the columns of a token table: one row per variable, one
 * column per mode, and a node binds to the ROW so switching mode re-themes it.
 * Figma caps the columns by pricing tier — one on Starter — and `addMode`
 * throws `in addMode: Limited to N modes only` when you ask for one too many.
 *
 * Every collection already HAS its first column, so asking for one mode must
 * never spend one. These pin that: single-mode work succeeds on a plan that
 * allows exactly one mode, and only a genuine second mode reports PLAN_LIMIT.
 */

type FakeNode = Record<string, any>;

let collections: FakeNode[];
let variablesById: Map<string, FakeNode>;
let varCounter: number;

/** A collection whose `addMode` refuses past `modeLimit`, the way Figma's does. */
function makeCollection(
  name: string,
  modeNames: string[] = ["Mode 1"],
  modeLimit = 1,
): FakeNode {
  const col: FakeNode = {
    id: `VariableCollectionId:${collections.length + 1}`,
    name,
    modes: modeNames.map((n, i) => ({ modeId: `m${i}`, name: n })),
    defaultModeId: "m0",
    variableIds: [],
    addMode: vi.fn((n: string) => {
      if (col.modes.length >= modeLimit) {
        throw new Error(`in addMode: Limited to ${modeLimit} modes only`);
      }
      const modeId = `m${col.modes.length}`;
      col.modes.push({ modeId, name: n });
      return modeId;
    }),
    // The real one renames in place; a no-op mock would hide the whole point.
    renameMode: vi.fn((modeId: string, newName: string) => {
      const m = col.modes.find((x: FakeNode) => x.modeId === modeId);
      if (m) m.name = newName;
    }),
  };
  collections.push(col);
  return col;
}

function ctx(params: Record<string, unknown>): HandlerContext {
  return makeContext(params, () => {});
}

function planError(fn: () => Promise<unknown>): Promise<HandlerError> {
  return fn().then(
    () => {
      throw new Error("expected PLAN_LIMIT, but the call succeeded");
    },
    (e: unknown) => {
      expect(e).toBeInstanceOf(HandlerError);
      return e as HandlerError;
    },
  );
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
      createVariable: vi.fn((name: string, col: FakeNode, type: string) => {
        const v: FakeNode = {
          id: `VariableID:${++varCounter}`,
          name,
          resolvedType: type,
          variableCollectionId: col.id,
          description: "",
          valuesByMode: {} as Record<string, unknown>,
          setValueForMode: vi.fn((modeId: string, val: unknown) => {
            v.valuesByMode[modeId] = val;
          }),
          remove: vi.fn(),
        };
        variablesById.set(v.id, v);
        col.variableIds.push(v.id);
        return v;
      }),
    },
    mixed: Symbol("mixed"),
  };
});

describe("ensureMode", () => {
  it("claims the untouched default by renaming, never by spending a mode", () => {
    const col = makeCollection("Reqwise Tokens", ["Mode 1"], 1);
    expect(ensureMode(col as never, "light")).toEqual({ modeId: "m0", name: "light" });
    expect(col.renameMode).toHaveBeenCalledWith("m0", "light");
    expect(col.addMode).not.toHaveBeenCalled();
    expect(col.modes).toEqual([{ modeId: "m0", name: "light" }]);
  });

  it("is idempotent — an existing mode is found, by name or by id", () => {
    const col = makeCollection("Reqwise Tokens", ["light"], 1);
    expect(ensureMode(col as never, "light").modeId).toBe("m0");
    expect(ensureMode(col as never, "m0").name).toBe("light");
    expect(col.renameMode).not.toHaveBeenCalled();
    expect(col.addMode).not.toHaveBeenCalled();
  });

  it("never renames a mode the user named — that one costs a real addMode", () => {
    const col = makeCollection("Reqwise Tokens", ["Brand A"], 4);
    ensureMode(col as never, "light");
    expect(col.renameMode).not.toHaveBeenCalled();
    expect(col.addMode).toHaveBeenCalledWith("light");
    expect(col.modes.map((m: FakeNode) => m.name)).toEqual(["Brand A", "light"]);
  });

  it("adds a third and fourth mode when the plan allows them", () => {
    const col = makeCollection("Reqwise Tokens", ["Mode 1"], 4);
    for (const n of ["light", "dark", "high-contrast", "brand-b"]) {
      ensureMode(col as never, n);
    }
    expect(col.modes.map((m: FakeNode) => m.name)).toEqual([
      "light",
      "dark",
      "high-contrast",
      "brand-b",
    ]);
    // Four modes, three addMode calls: the first was free.
    expect(col.addMode).toHaveBeenCalledTimes(3);
  });

  it("reports PLAN_LIMIT with the limit Figma named, not a hardcoded one", () => {
    const col = makeCollection("Reqwise Tokens", ["a", "b", "c", "d"], 4);
    let caught: unknown;
    try {
      ensureMode(col as never, "e");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HandlerError);
    const e = caught as HandlerError;
    expect(e.code).toBe(ErrorCode.PLAN_LIMIT);
    expect(e.message).toContain("allows 4 modes per collection");
    expect(e.message).toContain('mode "e" was not created');
    // The hint lists what IS there, so the caller can send a subset instead.
    expect(e.hint).toContain("a, b, c, d");
  });

  it("re-throws anything that is not the mode cap", () => {
    const col = makeCollection("Reqwise Tokens", ["Brand A"], 99);
    col.addMode = vi.fn(() => {
      throw new Error("something else entirely");
    });
    expect(() => ensureMode(col as never, "light")).toThrow("something else entirely");
  });
});

describe("on a plan that allows exactly one mode", () => {
  it("setup_tokens with plain values writes the mode that is already there", async () => {
    const res = (await setupTokens(
      ctx({ colors: { surface: "#FFFFFF" }, numbers: { "radius-md": 8 } }),
    )) as any;
    const col = collections[0]!;
    expect(col.addMode).not.toHaveBeenCalled();
    expect(res.modes).toEqual(["Mode 1"]);
    expect(res.total).toBe(2);
  });

  it("setup_tokens run twice in a row still writes, after a rename", async () => {
    // The regression this guards: run one, ask for `light` (renames Mode 1),
    // then run two with plain hexes. Demanding "Mode 1" back would addMode.
    await setupTokens(ctx({ colors: { surface: { light: "#FFFFFF" } } })).catch(() => {});
    const col = collections[0]!;
    expect(col.modes.map((m: FakeNode) => m.name)).toEqual(["light"]);

    const res = (await setupTokens(ctx({ colors: { ink: "#111111" } }))) as any;
    expect(col.addMode).not.toHaveBeenCalled();
    expect(res.modes).toEqual(["light"]);
  });

  it("setup_tokens asking for light AND dark reports PLAN_LIMIT", async () => {
    const e = await planError(() =>
      setupTokens(ctx({ colors: { surface: { light: "#FFFFFF", dark: "#0B0B0F" } } })),
    );
    expect(e.code).toBe(ErrorCode.PLAN_LIMIT);
    expect(e.message).toContain("allows 1 mode per collection");
    expect(e.hint).toContain("single value");
  });

  it("import_tokens with ONE named mode succeeds — it used to not", async () => {
    // `{ tokens, mode: "light" }` asks for a single mode, which every
    // collection already has room for. Before ensureMode this called addMode
    // because the existing mode was still called "Mode 1", and died.
    const res = (await importTokens(
      ctx({
        tokens: { color: { primary: { $type: "color", $value: "#3366ee" } } },
        mode: "light",
        createCollection: true,
      }),
    )) as any;
    const col = collections[0]!;
    expect(col.addMode).not.toHaveBeenCalled();
    expect(col.modes.map((m: FakeNode) => m.name)).toEqual(["light"]);
    expect(res.created).toContain("color/primary");
  });

  it("import_tokens with a light/dark tree reports PLAN_LIMIT", async () => {
    const e = await planError(() =>
      importTokens(
        ctx({
          modes: {
            light: { color: { bg: { $type: "color", $value: "#ffffff" } } },
            dark: { color: { bg: { $type: "color", $value: "#000000" } } },
          },
          createCollection: true,
        }),
      ),
    );
    expect(e.code).toBe(ErrorCode.PLAN_LIMIT);
  });

  it("create_variable with valuesByMode reports PLAN_LIMIT on the second mode", async () => {
    makeCollection("Reqwise Tokens", ["Mode 1"], 1);
    const e = await planError(() =>
      createVariable(ctx({ name: "bg", valuesByMode: { light: "#ffffff", dark: "#111111" } })),
    );
    expect(e.code).toBe(ErrorCode.PLAN_LIMIT);
    // `light` still landed on the renamed default before `dark` was refused.
    expect(collections[0]!.modes.map((m: FakeNode) => m.name)).toEqual(["light"]);
  });

  it("create_variable with a single value writes every existing mode", async () => {
    makeCollection("Reqwise Tokens", ["light"], 1);
    const res = (await createVariable(ctx({ name: "primary", value: "#3366ee" }))) as any;
    expect(res.modes).toEqual(["light"]);
    expect(collections[0]!.addMode).not.toHaveBeenCalled();
  });
});
