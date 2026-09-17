import { describe, expect, it } from "vitest";
import { DOC_SECTIONS, DOC_SECTION_NAMES, getDoc } from "../../src/server/docs-content/index.js";
import { TOOLS } from "../../src/server/index.js";
import { handleDocs } from "../../src/server/tools.js";

/**
 * Every section figma_docs advertises has to exist, and every section that
 * exists has to be advertised. A section written but never registered is
 * invisible with no error anywhere — which is exactly what happened to the
 * activity docs once.
 */
describe("figma_docs sections", () => {
  it("registers every section with real content", () => {
    for (const name of DOC_SECTION_NAMES) {
      const md = DOC_SECTIONS[name];
      expect(md.length, name).toBeGreaterThan(400);
      expect(md.startsWith("#"), name).toBe(true);
    }
  });

  it("lists exactly the sections the figma_docs tool advertises", () => {
    const docsTool = TOOLS.find((t) => t.name === "figma_docs")!;
    const advertised = /Sections: ([a-z |]+)\./.exec(docsTool.description ?? "")![1]!;
    expect(advertised.split("|").map((s) => s.trim()).sort()).toEqual([...DOC_SECTION_NAMES].sort());
  });

  it("covers every diagram tool with a section of its own", () => {
    expect(DOC_SECTION_NAMES).toContain("userflow");
    expect(DOC_SECTION_NAMES).toContain("activity");
    expect(getDoc("activity")).toContain("swimlane");
  });

  it("names the available sections when asked for one that does not exist", () => {
    const md = getDoc("nope");
    expect(md).toContain('Unknown docs section "nope"');
    for (const name of DOC_SECTION_NAMES) expect(md).toContain(name);
  });
});

describe('figma_docs level:"cheat"', () => {
  /**
   * The short form is SLICED from the full section, never written twice: a
   * second copy of a field table is a second copy to drift out of date.
   */
  const shapeKinds = ["activity", "erd", "sequence", "state", "userflow"] as const;

  it("returns the call shape at a fraction of the size", () => {
    for (const kind of shapeKinds) {
      const full = handleDocs(kind);
      const cheat = handleDocs(kind, "cheat");
      expect(cheat, kind).toContain("## Shape");
      expect(cheat.length, `${kind} cheat is not shorter`).toBeLessThan(full.length * 0.75);
      // It has to be enough to write the call with.
      expect(cheat, `${kind} cheat lost the type`).toMatch(/type|figma_userflow/);
      expect(cheat, `${kind} cheat does not point at the full section`).toContain(
        `figma_docs({ section: "${kind}" })`,
      );
    }
  });

  it("says so instead of pretending a prose section has a call shape", () => {
    const cheat = handleDocs("style", "cheat");
    expect(cheat).toContain("No short form");
    expect(cheat.length).toBeGreaterThan(1000);
  });

  it("defaults to the full section", () => {
    expect(handleDocs("erd")).toBe(handleDocs("erd", "full"));
  });
});
