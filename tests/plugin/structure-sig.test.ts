import { describe, it, expect } from "vitest";
import {
  structureSignature,
  structureSignatureAtDepth,
  StructNode,
} from "../../src/plugin/structure-sig.js";

const card = (label: string): StructNode => ({
  type: "FRAME",
  name: "Card",
  children: [
    { type: "TEXT", name: "Title" },
    { type: "TEXT", name: label },
    { type: "RECTANGLE", name: "Divider" },
  ],
});

describe("structureSignature", () => {
  it("identical trees produce identical signatures", () => {
    expect(structureSignature(card("Body"))).toBe(structureSignature(card("Body")));
  });

  it("differing child name or order changes the signature", () => {
    expect(structureSignature(card("Body"))).not.toBe(structureSignature(card("Other")));
    const swapped: StructNode = {
      ...card("Body"),
      children: [...card("Body").children!].reverse(),
    };
    expect(structureSignature(card("Body"))).not.toBe(structureSignature(swapped));
  });

  it("depth cutoff collapses deeper levels", () => {
    const deep: StructNode = {
      type: "FRAME",
      name: "A",
      children: [{ type: "FRAME", name: "B", children: [{ type: "TEXT", name: "C" }] }],
    };
    const shallowDiff: StructNode = {
      type: "FRAME",
      name: "A",
      children: [{ type: "FRAME", name: "B", children: [{ type: "TEXT", name: "DIFFERENT" }] }],
    };
    expect(structureSignatureAtDepth(deep, 1)).toBe(structureSignatureAtDepth(shallowDiff, 1));
    expect(structureSignatureAtDepth(deep, 3)).not.toBe(structureSignatureAtDepth(shallowDiff, 3));
  });
});
