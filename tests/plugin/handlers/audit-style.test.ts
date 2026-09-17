import { describe, expect, it } from "vitest";
import { styleWarningsFor, zIndexWarningsFor } from "../../../src/plugin/handlers/audit.js";

function solid(hex = { r: 1, g: 1, b: 1 }): SolidPaint {
  return { type: "SOLID", color: hex };
}

function fakeFrame(
  overrides: Record<string, unknown> = {},
): SceneNode {
  return {
    id: String(overrides.id ?? "1:1"),
    name: String(overrides.name ?? "Card"),
    type: "FRAME",
    x: 0,
    y: 0,
    width: 320,
    height: 160,
    visible: true,
    fills: [solid()],
    strokes: [],
    cornerRadius: 16,
    layoutMode: "VERTICAL",
    paddingLeft: 16,
    paddingRight: 16,
    paddingTop: 16,
    paddingBottom: 16,
    children: [{ id: "1:2", name: "Content", type: "TEXT", x: 16, y: 16, width: 100, height: 24, visible: true }],
    parent: { id: "0:1", type: "FRAME" },
    ...overrides,
  } as unknown as SceneNode;
}

describe("layout audit style warnings", () => {
  it("does not treat a transparent structural frame as an error", () => {
    const node = fakeFrame({ name: "Header wrapper", fills: [], strokes: [] });
    expect(styleWarningsFor(node, [node])).toEqual([]);
  });

  it("flags a visible semantic surface with no radius", () => {
    const node = fakeFrame({ name: "Card / Account", cornerRadius: 0 });
    expect(styleWarningsFor(node, [node]).join(" ")).toContain("cornerRadius 0");
  });

  it("leaves a drawn diagram's own shapes out of the radius comparison", () => {
    // A live run had the audit telling the agent that the start pill's 20px
    // radius "differs from similar siblings" — it differs on purpose: that is
    // start/end notation, and an agent that fixes it breaks the diagram.
    const pill = fakeFrame({ id: "1:1", name: "step:s · Refund requested", cornerRadius: 20 });
    const a = fakeFrame({ id: "1:2", name: "step:check · Check order", cornerRadius: 10 });
    const b = fakeFrame({ id: "1:3", name: "step:deny · Explain why not", cornerRadius: 10 });
    expect(styleWarningsFor(pill, [pill, a, b])).toEqual([]);
  });

  it("flags a radius that differs from similar siblings", () => {
    const a = fakeFrame({ id: "1:1", name: "Card 1", cornerRadius: 0 });
    const b = fakeFrame({ id: "1:2", name: "Card 2", cornerRadius: 16 });
    const c = fakeFrame({ id: "1:3", name: "Card 3", cornerRadius: 16 });
    expect(styleWarningsFor(a, [a, b, c]).join(" ")).toContain("similar siblings");
  });

  it("flags large visible content containers with tight padding", () => {
    const node = fakeFrame({
      name: "Card / Tight",
      paddingLeft: 4,
      paddingRight: 4,
      paddingTop: 4,
      paddingBottom: 4,
    });
    expect(styleWarningsFor(node, [node]).join(" ")).toContain("only 4px");
  });

  it("accepts comfortable card padding", () => {
    const node = fakeFrame();
    expect(styleWarningsFor(node, [node]).join(" ")).not.toContain("container edge");
  });

  it("does not require padding on the root screen", () => {
    const node = fakeFrame({
      name: "Screen / Login",
      paddingLeft: 0,
      paddingRight: 0,
      paddingTop: 0,
      paddingBottom: 0,
      parent: { id: "0:0", type: "PAGE" },
    });
    expect(styleWarningsFor(node, [node]).join(" ")).not.toContain("container edge");
  });

  it("does not ask intentional hug-width text to stretch", () => {
    const parent = { id: "0:1", type: "FRAME", layoutMode: "VERTICAL" };
    const text = {
      id: "1:1",
      name: "Eyebrow",
      type: "TEXT",
      width: 72,
      height: 16,
      layoutAlign: "MIN",
      fills: [solid({ r: 0, g: 0, b: 0 })],
      parent,
    } as unknown as SceneNode;
    const wide = fakeFrame({
      id: "1:2",
      name: "Content",
      width: 320,
      layoutAlign: "STRETCH",
      parent,
      fills: [],
    });
    expect(styleWarningsFor(text, [text, wide]).join(" ")).not.toContain("STRETCH");
  });

  it("still flags a narrow layout container among stretched siblings", () => {
    const parent = { id: "0:1", type: "FRAME", layoutMode: "VERTICAL" };
    const narrow = fakeFrame({
      id: "1:1",
      name: "Form group",
      width: 100,
      layoutAlign: "MIN",
      parent,
      fills: [],
    });
    const wide = fakeFrame({
      id: "1:2",
      name: "Content group",
      width: 320,
      layoutAlign: "STRETCH",
      parent,
      fills: [],
    });
    expect(styleWarningsFor(narrow, [narrow, wide]).join(" ")).toContain("STRETCH");
  });
});

describe("subtree hints and a drawn diagram", () => {
  it("still flags a real screen whose radii are all over the place", async () => {
    const { subtreeStyleHints } = await import("../../../src/plugin/handlers/audit.js");
    expect(subtreeStyleHints([], [3, 5, 9, 14, 22], []).join(" ")).toContain("distinct radii");
  });

  it("leaves a diagram's own layers out of the count", async () => {
    // Live finding: a swimlane diagram reported "5 distinct radii (4/6/10/11.5/20)".
    // Those five ARE the notation — fork bar, edge corner, action box, label
    // pill, start pill — so the walker skips generated layers when collecting.
    const { isDiagramLayerName } = await import("../../../src/plugin/diagram-mark.js");
    // Every prefix the five diagram handlers actually emit. A kind that grows
    // a new layer type and forgets this list gets style hints fired at its own
    // notation — which is how "frag-else-label" (a white pill that knocks out
    // the dashed divider under it) was reported as a same-colour wrapper.
    for (const name of [
      "step:s · Start",
      "flow:home · 1.1",
      "lane:ops",
      "lane-head:ops",
      "entity:contract · contract",
      "party:app · App",
      "state:draft · Nháp",
      "ring:closed",
      "life app",
      "bar m2",
      "frag frag0",
      "frag-tab frag0",
      "frag-else frag0",
      "frag-else-label frag0",
      "note m3",
      "row contract:id",
      "edge a->b",
      "arrow a->b",
      "mark a->b:from",
      "mark-o a->b:from",
      "label a->b",
      "text:d1",
      "q 1",
    ]) {
      expect(isDiagramLayerName(name), name).toBe(true);
    }
    for (const name of ["Card", "Button / primary", "1.2 · sign-in", "stateful header"]) {
      expect(isDiagramLayerName(name), name).toBe(false);
    }
  });

  it("knows a diagram FRAME by the name its own builder gives it", async () => {
    // Tied to the real producers rather than a copy of the strings: renaming a
    // frame in one of the builders has to fail here, because the `create`
    // handler uses this to decide the frame is not an unmapped screen and to
    // keep style hints off the notation.
    const { isDiagramFrameName } = await import("../../../src/plugin/diagram-mark.js");
    const { buildUserflow } = await import("../../../src/shared/userflow/index.js");
    const { buildActivity } = await import("../../../src/shared/activity/index.js");
    const { buildErd } = await import("../../../src/shared/erd/index.js");
    const { buildSequence } = await import("../../../src/shared/sequence/index.js");
    const { buildState } = await import("../../../src/shared/state/index.js");

    const names = [
      buildUserflow({ title: "T", nodes: [{ id: "a", label: "A" }] }).draw.name,
      buildActivity({ title: "T", nodes: [{ id: "a", label: "A" }] }).draw.name,
      buildErd({ title: "T", entities: [{ id: "a", name: "A", attributes: [{ name: "id", key: "pk" }] }] }).draw.name,
      buildSequence({
        title: "T",
        participants: [{ id: "a", name: "A" }, { id: "b", name: "B" }],
        messages: [{ id: "m", from: "a", to: "b", label: "x" }],
      }).draw.name,
      buildState({ title: "T", states: [{ id: "a", kind: "initial" }, { id: "b", label: "B", kind: "final" }], transitions: [{ from: "a", to: "b" }] }).draw.name,
    ];
    expect(names).toHaveLength(5);
    for (const name of names) expect(isDiagramFrameName(name), name).toBe(true);

    // A frame the USER named after one of those words is theirs, and must keep
    // getting real findings — which is why the check wants the whole "Kind · ".
    for (const name of ["State machine", "Activity log", "Sequence of events", "ERDs", "Userflow ideas"]) {
      expect(isDiagramFrameName(name), name).toBe(false);
    }
  });
});

describe("the overlay z-index check", () => {
  const rect = (over: Record<string, unknown> = {}): SceneNode =>
    ({
      id: "2:1",
      name: "overlay",
      type: "RECTANGLE",
      x: 0,
      y: 0,
      width: 320,
      height: 640,
      opacity: 0.5,
      visible: true,
      fills: [solid({ r: 0, g: 0, b: 0 })],
      ...over,
    }) as unknown as SceneNode;

  it("flags a scrim that is not on top", () => {
    expect(zIndexWarningsFor(rect(), 2, 6).join(" ")).toContain("Move to top");
  });

  it("says nothing when the scrim IS on top", () => {
    expect(zIndexWarningsFor(rect(), 5, 6)).toEqual([]);
  });

  // The live bug: a journey map's column band is a big translucent rectangle
  // that BELONGS at the bottom, grouping a column behind its cells. Drawn on
  // the real canvas, every phase produced one "move to top" issue — advice
  // that would break a correct drawing, which is how people learn to stop
  // reading the audit.
  it("leaves a diagram tool's own layer alone, whatever its z-index", () => {
    expect(zIndexWarningsFor(rect({ name: "column:pay", opacity: 0.06 }), 1, 57)).toEqual([]);
  });

  it("still flags a real scrim drawn INSIDE a diagram frame", () => {
    // Only the generated layer names are exempt, not the whole frame: a
    // hand-drawn overlay keeps its finding.
    expect(zIndexWarningsFor(rect({ name: "Modal scrim" }), 1, 57).join(" ")).toContain("Move to top");
  });

  it("says nothing about an only child", () => {
    expect(zIndexWarningsFor(rect(), 0, 0)).toEqual([]);
  });
});
