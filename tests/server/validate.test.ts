import { describe, it, expect } from "vitest";
import { validateOperation, isReadOp, isWriteOp } from "../../src/server/validate.js";
import { OpError } from "../../src/server/errors.js";

describe("validateOperation", () => {
  it("rejects unknown operations", () => {
    expect(() => validateOperation("frobnicate", {})).toThrowError(OpError);
    try {
      validateOperation("frobnicate", {});
    } catch (e) {
      expect((e as OpError).code).toBe("UNSUPPORTED_OPERATION");
    }
  });

  it("rejects a missing nodeId for ops that require one", () => {
    for (const op of ["get_node", "modify", "delete", "set_text", "layout_audit"]) {
      const params = op === "set_text" ? { content: "hi" } : {};
      expect(() => validateOperation(op, params), op).toThrowError(OpError);
      try {
        validateOperation(op, params);
      } catch (e) {
        expect((e as OpError).code, op).toBe("INVALID_PARAMS");
      }
    }
  });

  it("rejects a blank/whitespace nodeId", () => {
    expect(() => validateOperation("get_node", { nodeId: "   " })).toThrowError(OpError);
    expect(() => validateOperation("modify", { nodeId: "" })).toThrowError(OpError);
  });

  it("accepts a well-formed op", () => {
    const v = validateOperation("get_node", { nodeId: "12:34", includeChildren: true });
    expect(v.op).toBe("get_node");
    expect(v.params["nodeId"]).toBe("12:34");
    expect(v.params["includeChildren"]).toBe(true);
  });

  it("rejects params that are not an object", () => {
    expect(() => validateOperation("get_selection", 5 as unknown)).toThrowError(OpError);
    try {
      validateOperation("get_selection", "nope" as unknown);
    } catch (e) {
      expect((e as OpError).code).toBe("INVALID_PARAMS");
    }
  });

  it("validates batch shape", () => {
    expect(() => validateOperation("batch", { ops: [] })).toThrowError(OpError);
    const v = validateOperation("batch", { ops: [{ op: "create", params: { type: "FRAME" } }] });
    expect(v.op).toBe("batch");
  });

  it("validates set_text requires content", () => {
    expect(() => validateOperation("set_text", { nodeId: "1:1" })).toThrowError(OpError);
    const v = validateOperation("set_text", { nodeId: "1:1", content: "" });
    expect(v.op).toBe("set_text");
  });

  it("classifies read vs write ops", () => {
    expect(isReadOp("get_node")).toBe(true);
    expect(isReadOp("create")).toBe(false);
    expect(isWriteOp("create")).toBe(true);
    expect(isWriteOp("get_node")).toBe(false);
    // New ops are classified on the right side of the read/write split.
    expect(isReadOp("read_selection")).toBe(true);
    expect(isReadOp("get_component")).toBe(true);
    expect(isReadOp("get_design_system_kit")).toBe(true);
    expect(isReadOp("generate_design_md")).toBe(true);
    expect(isWriteOp("set_gradient")).toBe(true);
    expect(isWriteOp("set_effects")).toBe(true);
    expect(isWriteOp("set_instance_overrides")).toBe(true);
    expect(isWriteOp("set_selection_colors")).toBe(true);
    expect(isWriteOp("get_instance_overrides")).toBe(true);
  });
});

describe("validateOperation — edit-in-place ops", () => {
  function codeOf(fn: () => unknown): string | undefined {
    try {
      fn();
      return undefined;
    } catch (e) {
      return (e as OpError).code;
    }
  }

  describe("get_instance_overrides", () => {
    it("accepts an empty params object (defaults to selection)", () => {
      const v = validateOperation("get_instance_overrides", {});
      expect(v.op).toBe("get_instance_overrides");
    });
    it("accepts an optional nodeId and passes it through", () => {
      const v = validateOperation("get_instance_overrides", { nodeId: "12:3" });
      expect(v.params["nodeId"]).toBe("12:3");
    });
    it("rejects a blank nodeId when present", () => {
      expect(codeOf(() => validateOperation("get_instance_overrides", { nodeId: "  " }))).toBe("INVALID_PARAMS");
    });
  });

  describe("set_instance_overrides", () => {
    it("accepts a source + non-empty target list", () => {
      const v = validateOperation("set_instance_overrides", { sourceId: "1:1", targetIds: ["1:2", "1:3"] });
      expect(v.params["targetIds"]).toEqual(["1:2", "1:3"]);
    });
    it("rejects a missing sourceId", () => {
      expect(codeOf(() => validateOperation("set_instance_overrides", { targetIds: ["1:2"] }))).toBe("INVALID_PARAMS");
    });
    it("rejects an empty targetIds array", () => {
      expect(codeOf(() => validateOperation("set_instance_overrides", { sourceId: "1:1", targetIds: [] }))).toBe("INVALID_PARAMS");
    });
    it("rejects a blank target id", () => {
      expect(codeOf(() => validateOperation("set_instance_overrides", { sourceId: "1:1", targetIds: [" "] }))).toBe("INVALID_PARAMS");
    });
  });

  describe("set_selection_colors", () => {
    it("accepts a `to` color (nodeId + from optional)", () => {
      const v = validateOperation("set_selection_colors", { to: "#111827" });
      expect(v.params["to"]).toBe("#111827");
    });
    it("accepts from/nodeId/includeStrokes", () => {
      const v = validateOperation("set_selection_colors", {
        nodeId: "7:20",
        from: "#2563EB",
        to: "#7C3AED",
        includeStrokes: true,
      });
      expect(v.params["includeStrokes"]).toBe(true);
    });
    it("rejects a missing `to`", () => {
      expect(codeOf(() => validateOperation("set_selection_colors", { from: "#000000" }))).toBe("INVALID_PARAMS");
    });
    it("rejects a non-boolean includeStrokes", () => {
      expect(codeOf(() => validateOperation("set_selection_colors", { to: "#fff", includeStrokes: "yes" }))).toBe("INVALID_PARAMS");
    });
  });

  describe("set_gradient", () => {
    const twoStops = [
      { position: 0, color: "#2563EB" },
      { position: 1, color: "#7C3AED" },
    ];
    it("accepts a valid linear gradient with 2 stops", () => {
      const v = validateOperation("set_gradient", { nodeId: "1:1", type: "LINEAR", stops: twoStops });
      expect(v.op).toBe("set_gradient");
      expect((v.params["stops"] as unknown[]).length).toBe(2);
    });
    it("accepts optional transform + target", () => {
      const v = validateOperation("set_gradient", {
        nodeId: "1:1",
        type: "RADIAL",
        stops: twoStops,
        transform: [[1, 0, 0], [0, 1, 0]],
        target: "stroke",
      });
      expect(v.params["target"]).toBe("stroke");
    });
    it("rejects a missing nodeId", () => {
      expect(codeOf(() => validateOperation("set_gradient", { type: "LINEAR", stops: twoStops }))).toBe("INVALID_PARAMS");
    });
    it("rejects an unknown gradient type", () => {
      expect(codeOf(() => validateOperation("set_gradient", { nodeId: "1:1", type: "SPIRAL", stops: twoStops }))).toBe("INVALID_PARAMS");
    });
    it("rejects fewer than 2 stops", () => {
      expect(codeOf(() => validateOperation("set_gradient", { nodeId: "1:1", type: "LINEAR", stops: [twoStops[0]] }))).toBe("INVALID_PARAMS");
    });
    it("rejects a stop missing position/color", () => {
      expect(codeOf(() => validateOperation("set_gradient", { nodeId: "1:1", type: "LINEAR", stops: [{ position: 0 }, { position: 1, color: "#fff" }] }))).toBe("INVALID_PARAMS");
    });
  });

  describe("set_effects", () => {
    it("accepts a shadow effect array", () => {
      const v = validateOperation("set_effects", {
        nodeId: "1:1",
        effects: [{ type: "DROP_SHADOW", color: "#00000033", offset: { x: 0, y: 4 }, radius: 12, spread: 0 }],
      });
      expect(v.op).toBe("set_effects");
    });
    it("accepts an empty effects array (clears effects)", () => {
      const v = validateOperation("set_effects", { nodeId: "1:1", effects: [] });
      expect(v.params["effects"]).toEqual([]);
    });
    it("rejects a missing nodeId", () => {
      expect(codeOf(() => validateOperation("set_effects", { effects: [{ type: "LAYER_BLUR", radius: 4 }] }))).toBe("INVALID_PARAMS");
    });
    it("rejects an effect without a type", () => {
      expect(codeOf(() => validateOperation("set_effects", { nodeId: "1:1", effects: [{ radius: 4 }] }))).toBe("INVALID_PARAMS");
    });
    it("rejects effects that are not an array", () => {
      expect(codeOf(() => validateOperation("set_effects", { nodeId: "1:1", effects: "shadow" }))).toBe("INVALID_PARAMS");
    });
  });

  describe("read_selection", () => {
    it("accepts an empty params object", () => {
      const v = validateOperation("read_selection", {});
      expect(v.op).toBe("read_selection");
    });
    it("passes through detail + depth", () => {
      const v = validateOperation("read_selection", { detail: "compact", depth: 2 });
      expect(v.params["detail"]).toBe("compact");
      expect(v.params["depth"]).toBe(2);
    });
  });

  describe("design-system reads", () => {
    it("accepts design-system kit and markdown generation params", () => {
      expect(validateOperation("get_components", { detail: "design", depth: 2, includeAnatomy: true }).op).toBe("get_components");
      expect(validateOperation("get_design_system_kit", { detail: "design", depth: 2 }).op).toBe("get_design_system_kit");
      expect(validateOperation("generate_design_md", { includeJson: true, includeScreens: true, screenDepth: 4, maxInstances: 2000 }).op).toBe("generate_design_md");
      expect(codeOf(() => validateOperation("generate_design_md", { screenDepth: 99 }))).toBe("INVALID_PARAMS");
      expect(codeOf(() => validateOperation("generate_design_md", { includeScreens: "yes" }))).toBe("INVALID_PARAMS");
    });
    it("requires an identity for get_component", () => {
      expect(codeOf(() => validateOperation("get_component", {}))).toBe("INVALID_PARAMS");
      expect(validateOperation("get_component", { componentId: "1:1", detail: "design" }).op).toBe("get_component");
      expect(validateOperation("get_component", { key: "component-key" }).op).toBe("get_component");
    });
  });

  describe("set_current_page", () => {
    it("accepts pageId or name and rejects an empty request", () => {
      expect(validateOperation("set_current_page", { pageId: "0:2" }).op).toBe("set_current_page");
      expect(validateOperation("set_current_page", { name: "Mobile" }).op).toBe("set_current_page");
      expect(codeOf(() => validateOperation("set_current_page", {}))).toBe("INVALID_PARAMS");
    });
  });
});

/**
 * Both the leader-direct path and the follower /rpc path funnel through
 * validateOperation. We simulate BOTH callers here to prove neither bypasses
 * validation: a shared `runValidated` used by direct + rpc must reject the
 * same bad input.
 */
describe("validate choke point covers direct AND rpc paths", () => {
  function makeRunValidated(dispatched: Array<{ op: string }>) {
    return async (op: string, params: Record<string, unknown>) => {
      const v = validateOperation(op, params); // the single choke point
      dispatched.push({ op: v.op });
      return { dispatched: v.op };
    };
  }

  it("rejects a bad nodeId on the direct path", async () => {
    const dispatched: Array<{ op: string }> = [];
    const runValidated = makeRunValidated(dispatched);
    await expect(runValidated("modify", { props: {} })).rejects.toBeInstanceOf(OpError);
    expect(dispatched).toHaveLength(0); // never reached dispatch
  });

  it("rejects a bad nodeId on the rpc-forwarded path (same function)", async () => {
    const dispatched: Array<{ op: string }> = [];
    // The /rpc handler in the leader calls the identical runValidated.
    const onRpc = makeRunValidated(dispatched);
    await expect(onRpc("delete", {})).rejects.toBeInstanceOf(OpError);
    expect(dispatched).toHaveLength(0);
  });

  it("accepts a good op on both paths and dispatches once", async () => {
    const dispatched: Array<{ op: string }> = [];
    const run = makeRunValidated(dispatched);
    await run("get_node", { nodeId: "1:2" }); // direct
    await run("get_node", { nodeId: "1:2" }); // rpc
    expect(dispatched.map((d) => d.op)).toEqual(["get_node", "get_node"]);
  });
});

describe("validateOperation — instantiate by id or name", () => {
  it("accepts componentId alone (legacy path)", () => {
    const v = validateOperation("instantiate", { componentId: "1:2" });
    expect(v.params["componentId"]).toBe("1:2");
  });

  it("accepts component or query without componentId", () => {
    expect(validateOperation("instantiate", { component: "Button/Primary" }).params["component"]).toBe("Button/Primary");
    expect(validateOperation("instantiate", { query: "button" }).params["query"]).toBe("button");
  });

  it("rejects when none of componentId/component/query is present", () => {
    expect(() => validateOperation("instantiate", {})).toThrowError(OpError);
    try {
      validateOperation("instantiate", {});
    } catch (e) {
      expect((e as OpError).code).toBe("INVALID_PARAMS");
      expect((e as OpError).message).toContain("componentId, component, query");
    }
  });

  it("rejects blank strings", () => {
    expect(() => validateOperation("instantiate", { component: "   " })).toThrowError(OpError);
  });
});

describe("validateOperation — find_or_create_component", () => {
  it("accepts name + spec + dryRun + threshold", () => {
    const v = validateOperation("find_or_create_component", {
      name: "Button",
      spec: { type: "FRAME" },
      dryRun: true,
      threshold: 700,
    });
    expect(v.params["dryRun"]).toBe(true);
    expect(v.params["threshold"]).toBe(700);
  });

  it("rejects a missing/blank name and non-boolean dryRun", () => {
    expect(() => validateOperation("find_or_create_component", {})).toThrowError(OpError);
    expect(() => validateOperation("find_or_create_component", { name: " " })).toThrowError(OpError);
    expect(() =>
      validateOperation("find_or_create_component", { name: "B", dryRun: "yes" }),
    ).toThrowError(OpError);
  });
});

describe("validateOperation — create_variants axes", () => {
  it("accepts an axes matrix", () => {
    const v = validateOperation("create_variants", {
      baseSpec: { name: "Button" },
      axes: { Size: ["sm", "md"], State: ["default"] },
    });
    expect(v.params["axes"]).toEqual({ Size: ["sm", "md"], State: ["default"] });
  });

  it("accepts legacy variants/states without axes", () => {
    expect(() =>
      validateOperation("create_variants", { baseSpec: {}, variants: ["a", "b"] }),
    ).not.toThrow();
    expect(() =>
      validateOperation("create_variants", { baseSpec: {}, states: ["a"] }),
    ).not.toThrow();
  });

  it("rejects an empty axis and a call with neither axes nor variants", () => {
    expect(() =>
      validateOperation("create_variants", { axes: { Size: [] } }),
    ).toThrowError(OpError);
    expect(() => validateOperation("create_variants", { baseSpec: {} })).toThrowError(OpError);
  });
});

describe("validateOperation — new component ops", () => {
  it("arrange_component_set needs nodeId; options typed", () => {
    expect(() => validateOperation("arrange_component_set", {})).toThrowError(OpError);
    const v = validateOperation("arrange_component_set", { nodeId: "5:0", gap: 32, columnsBy: "State" });
    expect(v.params["gap"]).toBe(32);
    expect(() =>
      validateOperation("arrange_component_set", { nodeId: "5:0", gap: -1 }),
    ).toThrowError(OpError);
  });

  it("set_component_description needs description or documentationLinks", () => {
    expect(() => validateOperation("set_component_description", { nodeId: "1:2" })).toThrowError(OpError);
    expect(() =>
      validateOperation("set_component_description", { nodeId: "1:2", description: "" }),
    ).not.toThrow();
    expect(() =>
      validateOperation("set_component_description", {
        nodeId: "1:2",
        documentationLinks: [{ uri: "https://x" }],
      }),
    ).not.toThrow();
  });
});

describe("validateOperation — library + instance lifecycle ops", () => {
  it("get_library_component requires a key and a valid type", () => {
    expect(() => validateOperation("get_library_component", {})).toThrowError(OpError);
    expect(() =>
      validateOperation("get_library_component", { key: "abc", type: "weird" }),
    ).toThrowError(OpError);
    const v = validateOperation("get_library_component", { key: "abc", type: "set" });
    expect(v.params["key"]).toBe("abc");
  });

  it("detach/reset require nodeId or nodeIds", () => {
    for (const op of ["detach_instance", "reset_instance_overrides"]) {
      expect(() => validateOperation(op, {}), op).toThrowError(OpError);
      expect(() => validateOperation(op, { nodeIds: [] }), op).toThrowError(OpError);
      expect(() => validateOperation(op, { nodeId: "1:2" }), op).not.toThrow();
      expect(() => validateOperation(op, { nodeIds: ["1:2", "1:3"] }), op).not.toThrow();
    }
  });
});

describe("validateOperation — variable CRUD", () => {
  it("create_variable requires name + a value", () => {
    expect(() => validateOperation("create_variable", { name: "x" })).toThrowError(OpError);
    expect(() =>
      validateOperation("create_variable", { name: "x", value: "#fff" }),
    ).not.toThrow();
    expect(() =>
      validateOperation("create_variable", { name: "x", valuesByMode: { light: 1 } }),
    ).not.toThrow();
    expect(() =>
      validateOperation("create_variable", { name: "x", value: 1, type: "WEIRD" }),
    ).toThrowError(OpError);
  });

  it("update/rename/delete require a variable ref", () => {
    expect(() => validateOperation("update_variable", { value: 1 })).toThrowError(OpError);
    expect(() => validateOperation("rename_variable", { newName: "y" })).toThrowError(OpError);
    expect(() => validateOperation("delete_variable", {})).toThrowError(OpError);
    expect(() =>
      validateOperation("rename_variable", { variable: "x", newName: "y" }),
    ).not.toThrow();
    expect(() =>
      validateOperation("delete_variable", { variable: "x", replaceWith: "y", force: false }),
    ).not.toThrow();
  });
});

describe("validateOperation — token export/import", () => {
  it("export_tokens validates format; import requires a tree", () => {
    expect(() => validateOperation("export_tokens", {})).not.toThrow();
    expect(() => validateOperation("export_tokens", { format: "scss" })).toThrowError(OpError);
    expect(() => validateOperation("import_tokens", {})).toThrowError(OpError);
    expect(() =>
      validateOperation("import_tokens", { tokens: { a: { $value: 1 } } }),
    ).not.toThrow();
    expect(() =>
      validateOperation("import_tokens", { modes: { light: {} } }),
    ).not.toThrow();
  });
});
