import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildActivity } from "../../src/shared/activity/index.js";
import { buildErd } from "../../src/shared/erd/index.js";
import { buildSequence } from "../../src/shared/sequence/index.js";
import { buildSitemap } from "../../src/shared/sitemap/index.js";
import { buildState } from "../../src/shared/state/index.js";

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${name}.dsl`, import.meta.url)), "utf8");

/**
 * A frame stores the MODEL it was drawn from, so a later change can patch one
 * field instead of re-sending the whole spec. That only works if the stored
 * model is a faithful stand-in for the spec that produced it: feed it back in
 * and the same picture has to come out, or the first patch silently redraws a
 * different diagram than the one on the canvas.
 *
 * This is also what makes patching safe for a `text`-authored diagram: the
 * model is the merged, checked arrays, so the text is not needed to redraw it.
 */
const KINDS = [
  { kind: "sequence", build: buildSequence },
  { kind: "state", build: buildState },
  { kind: "erd", build: buildErd },
  { kind: "activity", build: buildActivity },
  { kind: "sitemap", build: buildSitemap },
] as const;

describe("the model a frame stores", () => {
  it("redraws the diagram it came from, byte for byte", () => {
    for (const { kind, build } of KINDS) {
      const b = build as (s: unknown) => { draw: unknown; model: unknown; warnings: string[] };
      const first = b({ title: "T", subtitle: "S", text: fixture(kind) });
      const again = b(first.model);
      expect(again.draw, `${kind}: the stored model drew something else`).toEqual(first.draw);
    }
  });

  it("reports the same findings the second time round", () => {
    // A model that has already been checked must not acquire NEW findings on
    // the way back in — that would mean the checker changed the model it
    // handed us, and a redraw would drift a little further every time.
    for (const { kind, build } of KINDS) {
      const b = build as (s: unknown) => { model: unknown; warnings: string[] };
      const first = b({ title: "T", subtitle: "S", text: fixture(kind) });
      const again = b(first.model);
      expect(again.warnings, kind).toEqual(first.warnings);
    }
  });

  it("carries no placement — where the frame sits is not part of the model", () => {
    for (const { kind, build } of KINDS) {
      const b = build as unknown as (s: unknown) => { model: Record<string, unknown> };
      const { model } = b({ title: "T", text: fixture(kind), x: 900, y: 700, parentId: "1:2" });
      for (const field of ["x", "y", "parentId", "text"]) {
        expect(model[field], `${kind}: ${field} leaked into the stored model`).toBeUndefined();
      }
    }
  });
});
