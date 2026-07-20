import { beforeAll, describe, expect, it } from "vitest";
import { readComponentPropertyDefinitions } from "../../src/plugin/serialize.js";

beforeAll(() => {
  // plainValue() consults figma.mixed; provide a minimal global.
  (globalThis as any).figma = { mixed: Symbol("mixed") };
});

// Reproduces the Figma getter contract: `componentPropertyDefinitions` is
// readable on a COMPONENT_SET and a non-variant COMPONENT, but THROWS on a
// variant COMPONENT (one whose parent is a COMPONENT_SET). A variant's
// definitions live on its parent set. We model the throw with a getter so the
// test fails loudly if a call site ever reads the property unguarded again.
function throwingDefs(): never {
  throw new Error(
    "in get_componentPropertyDefinitions: Can only get component property definitions of a component set or non-variant component",
  );
}

describe("readComponentPropertyDefinitions", () => {
  it("reads definitions off a COMPONENT_SET", () => {
    const set: any = {
      type: "COMPONENT_SET",
      componentPropertyDefinitions: { "State": { type: "VARIANT", defaultValue: "Default" } },
    };
    expect(readComponentPropertyDefinitions(set)).toEqual({
      State: { type: "VARIANT", defaultValue: "Default" },
    });
  });

  it("reads definitions off a non-variant COMPONENT (parent is not a set)", () => {
    const page: any = { type: "PAGE" };
    const comp: any = {
      type: "COMPONENT",
      parent: page,
      componentPropertyDefinitions: { "Label#1:2": { type: "TEXT", defaultValue: "Continue" } },
    };
    expect(readComponentPropertyDefinitions(comp)).toEqual({
      "Label#1:2": { type: "TEXT", defaultValue: "Continue" },
    });
  });

  it("does NOT throw on a variant COMPONENT — falls back to the parent set's definitions", () => {
    const set: any = {
      type: "COMPONENT_SET",
      componentPropertyDefinitions: { "State": { type: "VARIANT", defaultValue: "Default" } },
    };
    const variant: any = {
      type: "COMPONENT",
      parent: set,
      // Reading this on a real variant throws; the helper must never touch it.
      get componentPropertyDefinitions() {
        return throwingDefs();
      },
    };
    // Must not throw, and must surface the set's real definitions.
    expect(() => readComponentPropertyDefinitions(variant)).not.toThrow();
    expect(readComponentPropertyDefinitions(variant)).toEqual({
      State: { type: "VARIANT", defaultValue: "Default" },
    });
  });

  it("returns null for non-component nodes", () => {
    expect(readComponentPropertyDefinitions({ type: "FRAME" } as any)).toBeNull();
    expect(readComponentPropertyDefinitions({ type: "INSTANCE" } as any)).toBeNull();
  });
});
