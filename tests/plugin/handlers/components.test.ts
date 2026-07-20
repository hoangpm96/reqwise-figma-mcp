import { describe, it, expect, beforeEach, vi } from "vitest";
import { instantiate, findOrCreateComponent, createVariants, arrangeComponentSet, setComponentDescription, componentize } from "../../../src/plugin/handlers/components.js";
import { makeContext, HandlerContext } from "../../../src/plugin/context.js";
import { HandlerError } from "../../../src/plugin/errors.js";
import { ErrorCode } from "../../../src/shared/protocol.js";

/**
 * Real handler tests with a mocked `figma` global — enough surface for the
 * instantiate resolution paths (id, name query, component-set default).
 */

type FakeNode = Record<string, any>;

let nodes: Map<string, FakeNode>;
let components: FakeNode[];

function addComponent(id: string, name: string): FakeNode {
  const comp: FakeNode = {
    id,
    name,
    type: "COMPONENT",
    createInstance: vi.fn(() => ({
      id: `I${id};0:1`,
      name,
      type: "INSTANCE",
      children: [],
      componentProperties: {},
      setProperties: vi.fn(),
    })),
  };
  nodes.set(id, comp);
  components.push(comp);
  return comp;
}

function ctx(params: Record<string, unknown>): HandlerContext {
  return makeContext(params, () => {});
}

function makeText(name: string, ref?: string): FakeNode {
  return {
    id: `T-${name}`,
    name,
    type: "TEXT",
    characters: "old",
    componentPropertyReferences: ref ? { characters: ref } : undefined,
    getRangeAllFontNames: () => [{ family: "Inter", style: "Regular" }],
  };
}

/** Component whose instances contain `child` (parent link wired up). */
function addComponentWith(
  id: string,
  name: string,
  child: FakeNode,
  componentProperties: Record<string, unknown> = {},
): FakeNode {
  const comp: FakeNode = {
    id,
    name,
    type: "COMPONENT",
    createInstance: vi.fn(() => {
      const inst: FakeNode = {
        id: `I${id};0:1`,
        name,
        type: "INSTANCE",
        children: [child],
        componentProperties,
        setProperties: vi.fn(),
      };
      child.parent = inst;
      return inst;
    }),
  };
  nodes.set(id, comp);
  components.push(comp);
  return comp;
}

beforeEach(() => {
  nodes = new Map();
  components = [];
  (globalThis as any).figma = {
    getNodeByIdAsync: async (id: string) => nodes.get(id) ?? null,
    loadAllPagesAsync: async () => {},
    loadFontAsync: async () => {},
    root: { findAllWithCriteria: () => components },
    currentPage: { appendChild: vi.fn() },
    mixed: Symbol("mixed"),
  };
});

describe("instantiate — component resolution", () => {
  it("resolves a real componentId by id (resolved.via = id)", async () => {
    const comp = addComponent("1:2", "Button/Primary");
    const res = (await instantiate(ctx({ componentId: "1:2" }))) as any;
    expect(comp.createInstance).toHaveBeenCalledTimes(1);
    expect(res.resolved).toEqual({ via: "id" });
    expect((globalThis as any).figma.currentPage.appendChild).toHaveBeenCalled();
  });

  it("resolves an exact name via `component` (resolved.via = query)", async () => {
    addComponent("1:2", "Button/Primary");
    addComponent("1:3", "Card");
    const res = (await instantiate(ctx({ component: "Button/Primary" }))) as any;
    expect(res.resolved.via).toBe("query");
    expect(res.resolved.score).toBe(1000);
    expect(res.resolved.reason).toBe("exact");
    expect(res.id).toBe("I1:2;0:1");
  });

  it("treats a non-id-shaped componentId string as a query", async () => {
    addComponent("1:2", "Button/Primary");
    const res = (await instantiate(ctx({ componentId: "Button Primary" }))) as any;
    expect(res.resolved.via).toBe("query");
    expect(res.id).toBe("I1:2;0:1");
  });

  it("below-threshold match throws NODE_NOT_FOUND listing candidates", async () => {
    addComponent("1:2", "Button/Primary");
    addComponent("1:3", "Button/Secondary");
    // "Button" is a prefix of both (score < 800) → ambiguous, must not guess.
    const e = (await instantiate(ctx({ query: "Button" })).catch((x) => x)) as HandlerError;
    expect(e).toBeInstanceOf(HandlerError);
    expect(e.code).toBe(ErrorCode.NODE_NOT_FOUND);
    expect(e.message).toContain("Button/Primary");
    expect(e.message).toContain("Button/Secondary");
    expect(e.message).toContain("score");
  });

  it("id-shaped componentId that does not exist fails WITHOUT fuzzy fallback", async () => {
    addComponent("1:2", "Button/Primary");
    const e = (await instantiate(ctx({ componentId: "99:99" })).catch((x) => x)) as HandlerError;
    expect(e).toBeInstanceOf(HandlerError);
    expect(e.code).toBe(ErrorCode.NODE_NOT_FOUND);
    expect(e.message).toContain("99:99");
    expect(e.message).not.toContain("Candidates");
  });

  it("query with zero matches throws NODE_NOT_FOUND with a create hint", async () => {
    addComponent("1:2", "Card");
    const e = (await instantiate(ctx({ component: "Sidebar" })).catch((x) => x)) as HandlerError;
    expect(e).toBeInstanceOf(HandlerError);
    expect(e.code).toBe(ErrorCode.NODE_NOT_FOUND);
    expect(e.hint).toContain("find_or_create_component");
  });

  it("COMPONENT_SET id instantiates its default variant with a warning", async () => {
    const variant = addComponent("2:1", "state=default");
    components.length = 0; // variant lives inside the set, not top-level
    nodes.set("2:0", {
      id: "2:0",
      name: "Button",
      type: "COMPONENT_SET",
      defaultVariant: variant,
    });
    const c = ctx({ componentId: "2:0" });
    const res = (await instantiate(c)) as any;
    expect(variant.createInstance).toHaveBeenCalledTimes(1);
    expect(res.resolved.via).toBe("id");
    expect(c.warnings.join(" ")).toContain("COMPONENT_SET");
  });

  it("resolves a COMPONENT_SET by its exact name and instantiates the default variant", async () => {
    const variant = addComponent("2:2", "State=Default");
    components.length = 0;
    const set = {
      id: "2:0",
      name: "Button",
      type: "COMPONENT_SET",
      defaultVariant: variant,
      parent: null,
    };
    nodes.set(set.id, set);
    components.push(set);
    const c = ctx({ component: "Button" });
    const res = (await instantiate(c)) as any;
    expect(variant.createInstance).toHaveBeenCalledTimes(1);
    expect(res.resolved).toMatchObject({ via: "query", componentSetId: "2:0", score: 1000 });
    expect(c.warnings.join(" ")).toContain("COMPONENT_SET");
  });

  it("no componentId/component/query → INVALID_PARAMS", async () => {
    const e = (await instantiate(ctx({})).catch((x) => x)) as HandlerError;
    expect(e).toBeInstanceOf(HandlerError);
    expect(e.code).toBe(ErrorCode.INVALID_PARAMS);
  });
});

describe("instantiate — text overrides via component property", () => {
  it("applies text through setProperties when the layer is wired to a property", async () => {
    const label = makeText("Label", "Label#1:0");
    const comp = addComponentWith("3:1", "Button", label, {
      "Label#1:0": { type: "TEXT", value: "old" },
    });
    const res = (await instantiate(
      ctx({ componentId: "3:1", overrides: { Label: { text: "Save" } } }),
    )) as any;
    const inst = comp.createInstance.mock.results[0]!.value;
    expect(inst.setProperties).toHaveBeenCalledWith({ "Label#1:0": "Save" });
    expect(label.characters).toBe("old"); // NOT written directly
    expect(res.overridesApplied).toEqual([
      { target: "Label", field: "text", appliedVia: "property", ok: true },
    ]);
  });

  it("falls back to characters by name when the layer has no property ref", async () => {
    const label = makeText("Label");
    const comp = addComponentWith("3:2", "Chip", label);
    const res = (await instantiate(
      ctx({ componentId: "3:2", overrides: { Label: { text: "Hi" } } }),
    )) as any;
    const inst = comp.createInstance.mock.results[0]!.value;
    expect(inst.setProperties).not.toHaveBeenCalled();
    expect(label.characters).toBe("Hi");
    expect(res.overridesApplied[0].appliedVia).toBe("name");
  });

  it("falls back to characters (with a warning) when setProperties throws", async () => {
    const label = makeText("Label", "Label#1:0");
    const comp = addComponentWith("3:3", "Badge", label, {
      "Label#1:0": { type: "TEXT", value: "old" },
    });
    const c = ctx({ componentId: "3:3", overrides: { Label: { text: "X" } } });
    // Make setProperties fail on the created instance.
    comp.createInstance.mockImplementationOnce(() => {
      const inst: FakeNode = {
        id: "I3:3;0:1",
        name: "Badge",
        type: "INSTANCE",
        children: [label],
        componentProperties: { "Label#1:0": { type: "TEXT", value: "old" } },
        setProperties: vi.fn(() => {
          throw new Error("property is read-only");
        }),
      };
      label.parent = inst;
      return inst;
    });
    const res = (await instantiate(c)) as any;
    expect(label.characters).toBe("X");
    expect(res.overridesApplied[0]).toMatchObject({ field: "text", appliedVia: "name", ok: true });
    expect(c.warnings.join(" ")).toContain("fell back");
  });

  it("reports missing override targets as ok:false", async () => {
    const label = makeText("Label");
    addComponentWith("3:4", "Card", label);
    const res = (await instantiate(
      ctx({ componentId: "3:4", overrides: { Nope: { text: "Hi", visible: false } } }),
    )) as any;
    expect(res.overridesApplied).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: "Nope", field: "text", ok: false, error: "target not found" }),
        expect.objectContaining({ target: "Nope", field: "visible", ok: false }),
      ]),
    );
  });
});

describe("find_or_create_component — transparent decisions", () => {
  it("reuses an exact match with decision/score/reason", async () => {
    addComponent("1:2", "Button");
    const res = (await findOrCreateComponent(ctx({ name: "Button" }))) as any;
    expect(res).toMatchObject({
      decision: "reuse",
      id: "1:2",
      created: false,
      score: 1000,
      reason: "exact",
    });
  });

  it("dryRun with no match decides create without creating anything", async () => {
    addComponent("1:2", "Card");
    // figma.createComponent is NOT mocked — a create attempt would throw.
    const res = (await findOrCreateComponent(
      ctx({ name: "Sidebar", dryRun: true }),
    )) as any;
    expect(res.decision).toBe("create");
    expect(res.created).toBe(false);
    expect(res.dryRun).toBe(true);
    expect(res.candidates).toEqual([]);
    expect(res.reason).toContain("no local component");
  });

  it("dryRun below threshold lists ranked candidates with the losing score", async () => {
    addComponent("1:2", "Button/Primary");
    const res = (await findOrCreateComponent(
      ctx({ name: "Button", dryRun: true }),
    )) as any;
    expect(res.decision).toBe("create");
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0]).toMatchObject({ id: "1:2", name: "Button/Primary" });
    expect(res.reason).toMatch(/scored \d+ < 800/);
  });

  it("a custom threshold can turn that same case into a reuse", async () => {
    addComponent("1:2", "Button/Primary");
    const res = (await findOrCreateComponent(
      ctx({ name: "Button", threshold: 700 }),
    )) as any;
    expect(res.decision).toBe("reuse");
    expect(res.id).toBe("1:2");
    expect(res.score).toBeGreaterThanOrEqual(700);
  });

  it("blank name throws INVALID_PARAMS", async () => {
    const e = (await findOrCreateComponent(ctx({ name: "  " })).catch((x) => x)) as HandlerError;
    expect(e).toBeInstanceOf(HandlerError);
    expect(e.code).toBe(ErrorCode.INVALID_PARAMS);
  });

  it("create branch reports decision create with the losing score", async () => {
    addComponent("1:2", "Card");
    const created: FakeNode = {
      id: "9:1",
      name: "Component",
      type: "COMPONENT",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      children: [],
      appendChild: vi.fn(),
      resize: vi.fn(),
    };
    const fig = (globalThis as any).figma;
    fig.createComponent = vi.fn(() => created);
    fig.currentPage = {
      id: "0:1",
      type: "PAGE",
      children: [],
      appendChild: vi.fn(),
      insertChild: vi.fn(),
    };
    const res = (await findOrCreateComponent(ctx({ name: "Sidebar" }))) as any;
    expect(fig.createComponent).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ decision: "create", id: "9:1", created: true });
    expect(res.reason).toContain("no local component");
  });
});

describe("create_variants — multi-axis matrix", () => {
  /** Wire up createComponent to mint registered fake components + a page. */
  function mockCreateSurface() {
    const fig = (globalThis as any).figma;
    let n = 0;
    fig.createComponent = vi.fn(() => {
      n += 1;
      const node: FakeNode = {
        id: `9:${n}`,
        name: "Component",
        type: "COMPONENT",
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        fills: [],
        children: [],
        appendChild: vi.fn(),
        resize: vi.fn(),
      };
      nodes.set(node.id, node);
      return node;
    });
    fig.currentPage = {
      id: "0:1",
      type: "PAGE",
      children: [],
      appendChild: vi.fn(),
      insertChild: vi.fn(),
    };
    fig.combineAsVariants = vi.fn((comps: FakeNode[]) => ({
      id: "5:0",
      name: "Set",
      type: "COMPONENT_SET",
      children: comps,
      defaultVariant: comps[0],
    }));
    return fig;
  }

  it("axes {Size×State} → Cartesian set with combo names", async () => {
    const fig = mockCreateSurface();
    const res = (await createVariants(
      ctx({
        baseSpec: { name: "Button", width: 120, height: 44 },
        axes: { Size: ["sm", "md"], State: ["default", "hover"] },
      }),
    )) as any;
    expect(fig.createComponent).toHaveBeenCalledTimes(4);
    expect(res.componentSet).toBe(true);
    expect(res.axes).toEqual({ Size: ["sm", "md"], State: ["default", "hover"] });
    expect(res.variants.map((v: any) => v.name)).toEqual([
      "Size=sm, State=default",
      "Size=sm, State=hover",
      "Size=md, State=default",
      "Size=md, State=hover",
    ]);
  });

  it("detects an axes-shaped variants argument (positional call)", async () => {
    const fig = mockCreateSurface();
    const res = (await createVariants(
      ctx({
        baseSpec: { name: "Chip" },
        variants: { State: ["on", "off"] },
      }),
    )) as any;
    expect(fig.createComponent).toHaveBeenCalledTimes(2);
    expect(res.variants.map((v: any) => v.name)).toEqual(["State=on", "State=off"]);
  });

  it("legacy string states keep the single state axis", async () => {
    mockCreateSurface();
    const res = (await createVariants(
      ctx({ baseSpec: { name: "Badge" }, states: ["default", "hover"] }),
    )) as any;
    expect(res.variants.map((v: any) => v.name)).toEqual(["state=default", "state=hover"]);
  });

  it("legacy object entries use their name and merge per-variant spec", async () => {
    const fig = mockCreateSurface();
    const res = (await createVariants(
      ctx({
        baseSpec: { name: "Button", width: 120 },
        variants: [
          { name: "State=Default", fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }] },
          { name: "State=Pressed" },
        ],
      }),
    )) as any;
    expect(res.variants.map((v: any) => v.name)).toEqual(["State=Default", "State=Pressed"]);
    const first = fig.createComponent.mock.results[0]!.value;
    expect(first.fills).toBeDefined(); // per-variant fills reached create()
  });

  it("rejects a matrix above the combo cap", async () => {
    mockCreateSurface();
    const e = (await createVariants(
      ctx({
        baseSpec: { name: "X" },
        axes: { A: Array.from({ length: 8 }, (_, i) => `a${i}`), B: Array.from({ length: 8 }, (_, i) => `b${i}`) },
      }),
    ).catch((x) => x)) as HandlerError;
    expect(e).toBeInstanceOf(HandlerError);
    expect(e.code).toBe(ErrorCode.INVALID_PARAMS);
    expect(e.message).toContain("64");
  });

  it("falls back to loose components when combineAsVariants throws", async () => {
    const fig = mockCreateSurface();
    fig.combineAsVariants = vi.fn(() => {
      throw new Error("nope");
    });
    const c = ctx({ baseSpec: { name: "Tag" }, axes: { State: ["a", "b"] } });
    const res = (await createVariants(c)) as any;
    expect(res.componentSet).toBe(false);
    expect(res.variants).toHaveLength(2);
    expect(c.warnings.join(" ")).toContain("combineAsVariants failed");
  });
});

describe("arrange_component_set — variant grid", () => {
  function addSet(id: string, variantDefs: Array<Record<string, string>>): FakeNode {
    const children = variantDefs.map((props, i) => ({
      id: `${id};v${i}`,
      name: Object.entries(props).map(([k, v]) => `${k}=${v}`).join(", "),
      type: "COMPONENT",
      variantProperties: props,
      width: 100,
      height: 40,
      x: 0,
      y: 0,
    }));
    const set: FakeNode = {
      id,
      name: "Set",
      type: "COMPONENT_SET",
      children,
      resizeWithoutConstraints: vi.fn(),
    };
    nodes.set(id, set);
    return set;
  }

  it("grids Size×State with columns on the last axis (State)", async () => {
    const set = addSet("5:0", [
      { Size: "sm", State: "default" },
      { Size: "sm", State: "hover" },
      { Size: "md", State: "default" },
      { Size: "md", State: "hover" },
    ]);
    const res = (await arrangeComponentSet(ctx({ nodeId: "5:0" }))) as any;
    expect(res).toMatchObject({ arranged: 4, rows: 2, cols: 2, columnsBy: "State" });
    const [smDef, smHov, mdDef, mdHov] = set.children;
    expect([smDef.x, smDef.y]).toEqual([16, 16]);
    expect([smHov.x, smHov.y]).toEqual([16 + 124, 16]); // cellW 100 + gap 24
    expect([mdDef.x, mdDef.y]).toEqual([16, 16 + 64]); // cellH 40 + gap 24
    expect([mdHov.x, mdHov.y]).toEqual([140, 80]);
    expect(set.resizeWithoutConstraints).toHaveBeenCalledWith(
      2 * 16 + 2 * 100 + 24,
      2 * 16 + 2 * 40 + 24,
    );
  });

  it("columnsBy picks the column axis; unknown axis warns and falls back", async () => {
    const set = addSet("5:1", [
      { Size: "sm", State: "default" },
      { Size: "md", State: "default" },
    ]);
    const res = (await arrangeComponentSet(
      ctx({ nodeId: "5:1", columnsBy: "Size" }),
    )) as any;
    expect(res.columnsBy).toBe("Size");
    expect(res.cols).toBe(2);
    expect(res.rows).toBe(1);
    expect(set.children[1]!.x).toBeGreaterThan(set.children[0]!.x);

    const c = ctx({ nodeId: "5:1", columnsBy: "Nope" });
    const res2 = (await arrangeComponentSet(c)) as any;
    expect(res2.columnsBy).toBe("State");
    expect(c.warnings.join(" ")).toContain('"Nope"');
  });

  it("a single-axis set becomes one row", async () => {
    const res = (await arrangeComponentSet(
      ctx({
        nodeId: addSet("5:2", [{ State: "a" }, { State: "b" }, { State: "c" }]).id,
      }),
    )) as any;
    expect(res).toMatchObject({ rows: 1, cols: 3 });
  });

  it("rejects a node that is not a COMPONENT_SET", async () => {
    nodes.set("7:0", { id: "7:0", name: "Frame", type: "FRAME", children: [] });
    const e = (await arrangeComponentSet(ctx({ nodeId: "7:0" })).catch((x) => x)) as HandlerError;
    expect(e).toBeInstanceOf(HandlerError);
    expect(e.code).toBe(ErrorCode.INVALID_PARAMS);
    expect(e.hint).toContain("create_variants");
  });
});

describe("set_component_description", () => {
  it("writes description + documentationLinks on a COMPONENT", async () => {
    const comp = addComponent("1:2", "Button");
    comp.description = "";
    comp.documentationLinks = [];
    const res = (await setComponentDescription(
      ctx({
        nodeId: "1:2",
        description: "Primary action. Use once per view.",
        documentationLinks: [{ uri: "https://ds.example.com/button" }],
      }),
    )) as any;
    expect(comp.description).toBe("Primary action. Use once per view.");
    expect(comp.documentationLinks).toEqual([{ uri: "https://ds.example.com/button" }]);
    expect(res).toMatchObject({ id: "1:2", description: "Primary action. Use once per view." });
  });

  it("empty string clears the description", async () => {
    const comp = addComponent("1:2", "Button");
    comp.description = "old";
    await setComponentDescription(ctx({ nodeId: "1:2", description: "" }));
    expect(comp.description).toBe("");
  });

  it("rejects nodes that are not COMPONENT/COMPONENT_SET", async () => {
    nodes.set("7:0", { id: "7:0", name: "Frame", type: "FRAME" });
    const e = (await setComponentDescription(
      ctx({ nodeId: "7:0", description: "x" }),
    ).catch((x) => x)) as HandlerError;
    expect(e).toBeInstanceOf(HandlerError);
    expect(e.code).toBe(ErrorCode.INVALID_PARAMS);
  });
});

describe("componentize — draw once, reuse everywhere", () => {
  /** A Card-shaped frame with mutable parent/remove wiring. */
  function makeCard(id: string, parent: FakeNode, extraChildName = "Body"): FakeNode {
    const n: FakeNode = {
      id,
      name: "Card",
      type: "FRAME",
      x: Number(id.split(":")[1]) * 10,
      y: 5,
      parent,
      children: [
        { id: `${id}-t`, name: "Title", type: "TEXT" },
        { id: `${id}-b`, name: extraChildName, type: "TEXT" },
      ],
      remove: vi.fn(function (this: FakeNode) {
        parent.children = parent.children.filter((c: FakeNode) => c !== n);
      }),
    };
    nodes.set(id, n);
    parent.children.push(n);
    return n;
  }

  function pageWith(): FakeNode {
    const page: FakeNode = {
      id: "0:1",
      type: "PAGE",
      name: "Page",
      children: [],
      appendChild: vi.fn(),
      insertChild: vi.fn(function (this: FakeNode, i: number, child: FakeNode) {
        page.children.splice(i, 0, child);
        child.parent = page;
      }),
    };
    (globalThis as any).figma.currentPage = page;
    let instN = 0;
    (globalThis as any).figma.createComponentFromNode = vi.fn((node: FakeNode) => ({
      id: "C:1",
      name: node.name,
      type: "COMPONENT",
      createInstance: vi.fn(() => ({
        id: `I:${++instN}`,
        name: "Card",
        type: "INSTANCE",
        x: 0,
        y: 0,
      })),
    }));
    return page;
  }

  it("converts the node and replaces structural copies at their spot", async () => {
    const page = pageWith();
    const original = makeCard("30:1", page);
    const copy1 = makeCard("30:2", page);
    const copy2 = makeCard("30:3", page);
    const different = makeCard("30:4", page, "Footer"); // different structure

    const res = (await componentize(ctx({ nodeId: "30:1" }))) as any;
    expect(res.componentId).toBe("C:1");
    expect(res.candidatesFound).toBe(2);
    expect(res.replacedCount).toBe(2);
    expect(copy1.remove).toHaveBeenCalled();
    expect(copy2.remove).toHaveBeenCalled();
    expect(different.remove).not.toHaveBeenCalled();
    // Instances landed on the page and inherited the copies' positions.
    const instances = page.children.filter((c: FakeNode) => c.type === "INSTANCE");
    expect(instances).toHaveLength(2);
    expect(instances.map((i: FakeNode) => [i.x, i.y])).toEqual([
      [copy1.x, copy1.y],
      [copy2.x, copy2.y],
    ]);
  });

  it("replaceCopies: false only converts", async () => {
    const page = pageWith();
    makeCard("30:1", page);
    const copy = makeCard("30:2", page);
    const res = (await componentize(
      ctx({ nodeId: "30:1", replaceCopies: false, name: "Card/Base" }),
    )) as any;
    expect(res.candidatesFound).toBe(0);
    expect(res.name).toBe("Card/Base");
    expect(copy.remove).not.toHaveBeenCalled();
  });

  it("skips copies living inside instances/components", async () => {
    const page = pageWith();
    makeCard("30:1", page);
    const inst: FakeNode = {
      id: "40:1",
      name: "Widget",
      type: "INSTANCE",
      parent: page,
      children: [],
    };
    page.children.push(inst);
    makeCard("40:2", inst); // copy nested inside an instance — untouchable
    const res = (await componentize(ctx({ nodeId: "30:1" }))) as any;
    expect(res.candidatesFound).toBe(0);
  });

  it("rejects COMPONENT and INSTANCE inputs with guidance", async () => {
    nodes.set("50:1", { id: "50:1", type: "COMPONENT", name: "Done" });
    nodes.set("50:2", { id: "50:2", type: "INSTANCE", name: "Inst" });
    for (const [id, hintPart] of [
      ["50:1", "instantiate"],
      ["50:2", "detach_instance"],
    ] as const) {
      const e = (await componentize(ctx({ nodeId: id })).catch((x) => x)) as HandlerError;
      expect(e).toBeInstanceOf(HandlerError);
      expect(e.code).toBe(ErrorCode.INVALID_PARAMS);
      expect(e.hint).toContain(hintPart);
    }
  });
});
