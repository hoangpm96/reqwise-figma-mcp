import { describe, it, expect } from "vitest";
import { buildChildMap, MiniNode } from "../../src/plugin/tree-walk.js";

describe("buildChildMap", () => {
  it("maps roots and all descendants in parallel order", () => {
    const orig: MiniNode = {
      id: "o0",
      children: [
        { id: "o1", children: [{ id: "o3" }] },
        { id: "o2" },
      ],
    };
    const clone: MiniNode = {
      id: "c0",
      children: [
        { id: "c1", children: [{ id: "c3" }] },
        { id: "c2" },
      ],
    };
    expect(buildChildMap(orig, clone)).toEqual({
      o0: "c0",
      o1: "c1",
      o2: "c2",
      o3: "c3",
    });
  });

  it("handles leaf nodes", () => {
    expect(buildChildMap({ id: "a" }, { id: "b" })).toEqual({ a: "b" });
  });

  it("stops gracefully on divergent child counts", () => {
    const orig: MiniNode = { id: "o", children: [{ id: "o1" }, { id: "o2" }] };
    const clone: MiniNode = { id: "c", children: [{ id: "c1" }] };
    const map = buildChildMap(orig, clone);
    expect(map.o).toBe("c");
    expect(map.o1).toBe("c1");
    expect(map.o2).toBeUndefined();
  });
});
