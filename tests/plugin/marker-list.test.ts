import { describe, expect, it } from "vitest";
import * as mark from "../../src/plugin/diagram-mark.js";
import { FLOW_MARKER, LEGACY_FLOW_MARKER } from "../../src/plugin/flow-mark.js";

/**
 * NOTE: this file must not import anything under `src/server`.
 * `tsconfig.plugin.json` compiles `tests/plugin` with the Figma typings and no
 * node or DOM globals, so one server import here makes `fetch` and
 * `__VERSION__` undeclared in three files that have nothing to do with it. The
 * claim about the tool schema lives in `tests/server/sitemap-schema.test.ts`.
 *
 * `DIAGRAM_MARKERS` is the one list of "keys a diagram tool writes on a
 * frame", and three different questions are answered from it: can this frame
 * be read back and patched, can `reflow_diagram` be pointed at it, and does
 * the live watcher care when it moves.
 *
 * Before it existed each of those carried its own copy, and each copy went
 * stale on its own schedule — one named `reqwise.flow` against a marker
 * actually called `reqwise.userflow` (so no userflow frame could be patched,
 * symptom: "not a frame drawn by a diagram tool"), and another named two
 * markers out of seven. A list that must not drift needs a test that fails
 * when it does, because the symptom always points somewhere else.
 */
describe("the list of diagram markers", () => {
  const exported = Object.entries(mark)
    .filter(([k, v]) => k.endsWith("_MARKER") && typeof v === "string")
    .map(([, v]) => v as string);

  it("holds every per-kind marker this module exports", () => {
    // Seven here; userflow's two keys live in flow-mark.ts. The guard is on
    // the reflection working at all — the invariant that matters is the
    // "names every kind" test below.
    expect(exported.length).toBeGreaterThanOrEqual(7);
    for (const key of exported) {
      expect(mark.DIAGRAM_MARKERS as readonly string[], key).toContain(key);
    }
  });

  it("holds the two userflow keys, which live in the other module", () => {
    // They are spelled out in diagram-mark.ts rather than imported, to keep
    // that module dependency-free. This is the assertion that makes the two
    // copies safe.
    expect(mark.DIAGRAM_MARKERS as readonly string[]).toContain(FLOW_MARKER);
    expect(mark.DIAGRAM_MARKERS as readonly string[]).toContain(LEGACY_FLOW_MARKER);
  });

  it("recognises a frame by its marker alone, graph or no graph", () => {
    // A frame drawn by an older build carries a marker and no routing graph,
    // and `reflow_diagram` has to give it the "redraw it" warning rather than
    // refuse it as not-a-diagram. So this asks about the MARKER.
    const withMarker = fakeNode({ [mark.SITEMAP_MARKER]: '{"kind":"sitemap"}' });
    const without = fakeNode({ "some.other.plugin": "{}" });
    expect(mark.hasDiagramMarker(withMarker as never)).toBe(true);
    expect(mark.hasDiagramMarker(without as never)).toBe(false);
  });

  it("treats a node that throws on getPluginData as simply unmarked", () => {
    const hostile = { getPluginData: () => { throw new Error("nope"); } };
    expect(mark.hasDiagramMarker(hostile as never)).toBe(false);
  });
});

/** The two methods `hasDiagramMarker` actually touches. */
interface MarkedNode {
  getPluginData(key: string): string;
}

function fakeNode(data: Record<string, string>): MarkedNode {
  return { getPluginData: (key: string) => data[key] ?? "" };
}
