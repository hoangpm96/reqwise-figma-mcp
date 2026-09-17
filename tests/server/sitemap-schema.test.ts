import { describe, expect, it } from "vitest";
import { TOOLS } from "../../src/server/index.js";
import { applyPatch } from "../../src/server/patch.js";
import { buildSitemap } from "../../src/shared/sitemap/index.js";
import { sitemapSpecSchema, validateSitemapSpec } from "../../src/server/validate.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `options.layout` is ONE field in the JSON tool schema and TWO meanings:
 * `table|columns|cards|curve|poster` arrange a journey map, `tree|dagre`
 * arrange a sitemap. Sharing the field saved ~150B on a 195B budget and
 * follows `rankdir`, which has meant different things per kind since the
 * beginning.
 *
 * The cost of sharing is that the JSON enum can no longer say which value is
 * legal where — zod is the only thing that knows. An untested narrowing is a
 * claim rather than a guarantee, and a wrong value that slips through does not
 * error: it silently draws the other kind's shape. (That failure was live for
 * an hour: both options had landed in `userflowSpecSchema` by a sed that
 * matched the wrong `font:`, and journey's `.passthrough()` accepted anything.)
 */
describe("options.layout, shared between two kinds", () => {
  const enumValues = ((): string[] => {
    const tool = TOOLS.find((t) => t.name === "figma_diagram")!;
    const schema = tool.inputSchema as unknown as {
      properties: { options: { properties: { layout: { enum: string[] } } } };
    };
    return schema.properties.options.properties.layout.enum;
  })();

  it("declares both kinds' values in the JSON enum", () => {
    for (const v of ["tree", "dagre"]) {
      expect(enumValues, v).toContain(v);
    }
  });

  const sitemap = (layout: string) =>
    sitemapSpecSchema.safeParse({ title: "T", pages: [{ id: "a" }], options: { layout } });

  it("accepts the sitemap's own two", () => {
    for (const v of ["tree", "dagre"]) expect(sitemap(v).success, v).toBe(true);
  });

  it("rejects every journey arrangement, rather than drawing a tree anyway", () => {
    for (const v of ["table", "columns", "cards", "curve", "poster", "radial", ""]) {
      expect(sitemap(v).success, `sitemap accepted layout:"${v}"`).toBe(false);
    }
  });

});

describe("the sitemap spec schema", () => {
  it("insists on `text` or a non-empty `pages`, and says which", () => {
    const bad = sitemapSpecSchema.safeParse({ title: "T" });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error)).toContain("INDENTED");
  });

  it("refuses an id with whitespace, because the layer is named with it", () => {
    expect(sitemapSpecSchema.safeParse({ title: "T", pages: [{ id: "a b" }] }).success).toBe(false);
  });

  it("has no edges array to accept — containment is the parent", () => {
    // `.passthrough()` means an unknown key is carried rather than refused, so
    // the guarantee that matters is that nothing in the pipeline READS one:
    // the stored model is built from `pages` alone.
    const spec = validateSitemapSpec({
      title: "T",
      pages: [{ id: "a" }, { id: "b", parent: "a" }],
    });
    expect(Object.keys(spec).sort()).toEqual(["pages", "title"]);
  });

  it("throws the standard INVALID_PARAMS, with the containment rule in the hint", () => {
    try {
      validateSitemapSpec({ pages: [] });
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as { code?: string; hint?: string };
      expect(err.code).toBe("INVALID_PARAMS");
      expect(err.hint).toContain("containment, not navigation");
    }
  });

  it("bounds maxDepth, so a typo cannot turn the depth rule off", () => {
    const ok = { title: "T", pages: [{ id: "a" }] };
    expect(sitemapSpecSchema.safeParse({ ...ok, options: { maxDepth: 5 } }).success).toBe(true);
    expect(sitemapSpecSchema.safeParse({ ...ok, options: { maxDepth: 0 } }).success).toBe(false);
    expect(sitemapSpecSchema.safeParse({ ...ok, options: { maxDepth: 999 } }).success).toBe(false);
  });
});

describe("every kind has a marker", () => {
  it("names each `type` figma_diagram accepts", () => {
    // The marker list is read as TEXT, not imported. `src/plugin/diagram-mark.ts`
    // carries `/// <reference types="@figma/plugin-typings" />`, and pulling
    // that into the server program redefines setTimeout as the DOM one —
    // which makes bridge.ts and leader.ts red for reasons that have nothing
    // to do with this test (see the note in tsconfig.json). The dependency
    // is one-way in both directions, so the seam is a regex.
    const markers = [
      ...readFileSync(
        join(import.meta.dirname, "../../src/plugin/diagram-mark.ts"),
        "utf8",
      ).matchAll(/"(reqwise\.[a-z]+)"/g),
    ].map((m) => m[1]!);
    // A kind that ships without a marker is a kind whose frame cannot be read
    // back, patched or redrawn in place — and the only symptom is "not a frame
    // drawn by a diagram tool" on a frame the tool has just drawn. userflow's
    // key is `reqwise.userflow`; every other kind is `reqwise.<type>`, so the
    // two lists are checkable against each other.
    const tool = TOOLS.find((t) => t.name === "figma_diagram")!;
    const kinds = (tool.inputSchema as unknown as { properties: { type: { enum: string[] } } })
      .properties.type.enum;
    expect(kinds.length).toBeGreaterThanOrEqual(6);
    for (const kind of kinds) {
      expect(markers, kind).toContain(`reqwise.${kind}`);
    }
  });
});

describe("moving a page in the tree is a patch, not a redraw", () => {
  // The skill and figma_docs both tell the reader to patch `parent` rather
  // than re-send the model, and `collection: "pages"` works only because the
  // patch layer is kind-agnostic (a collection is any array on the spec). That
  // is an assumption about somebody else's module, so it is checked here
  // rather than asserted in prose.
  const model = buildSitemap({
    title: "IA",
    text: 'crm "CRM"\n  settings "Cài đặt"\n  billing "Thanh toán"',
  }).model;

  it("re-parents a page by id", () => {
    const out = applyPatch(model, [
      { collection: "pages", id: "billing", set: { parent: "settings" } },
    ]);
    const spec = out.spec as { pages: Array<{ id: string; parent?: string }> };
    expect(spec.pages.find((p) => p.id === "billing")!.parent).toBe("settings");
    // And the result is a model that redraws: the tree is one level deeper.
    const again = buildSitemap({ ...(out.spec as object), title: "IA" } as never);
    expect(again.stats.depth).toBe(3);
    expect(again.warnings).toEqual([]);
  });

  it("adds and removes a page", () => {
    const added = applyPatch(model, [
      { collection: "pages", add: { id: "team", label: "Thành viên", parent: "settings" } },
    ]);
    expect(buildSitemap({ ...(added.spec as object), title: "IA" } as never).stats.pages).toBe(4);
    const gone = applyPatch(model, [{ collection: "pages", remove: "billing" }]);
    expect(buildSitemap({ ...(gone.spec as object), title: "IA" } as never).stats.pages).toBe(2);
  });
});
