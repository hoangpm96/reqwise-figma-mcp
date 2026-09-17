import { describe, expect, it } from "vitest";
import { buildUserflow, checkGraph, parseMermaid } from "../../src/shared/userflow/index.js";
import { textWidth, wrapText } from "../../src/shared/diagram/metrics.js";
import type { FlowEdgeSpec, FlowNodeSpec } from "../../src/shared/userflow/types.js";

const spec = (nodes: FlowNodeSpec[], edges: FlowEdgeSpec[]) => ({
  title: "T",
  nodes,
  edges,
});

describe("mermaid parsing", () => {
  it("reads shapes, labels, dashed edges and classes", () => {
    const p = parseMermaid(`
flowchart TD
  a["Cart"] --> q{"Payment ok?"}
  q -->|"yes"| done(["Order placed"])
  q -->|"no"| err["Declined"]
  err -.->|"Try again"| a
  class a,done happy
  class err error
`);
    expect(p.warnings).toEqual([]);
    expect(p.rankdir).toBe("TB");
    expect(p.nodes.map((n) => n.id).sort()).toEqual(["a", "done", "err", "q"]);
    expect(p.nodes.find((n) => n.id === "q")?.kind).toBe("decision");
    expect(p.nodes.find((n) => n.id === "done")?.kind).toBe("terminal");
    expect(p.nodes.find((n) => n.id === "a")?.cls).toBe("happy");
    const back = p.edges.find((e) => e.from === "err");
    expect(back).toMatchObject({ to: "a", label: "Try again", kind: "return" });
  });

  it("handles an edge chain and keeps each label on its own edge", () => {
    const p = parseMermaid(`a["A"] -->|"one"| b["B"] -->|"two"| c["C"]`);
    expect(p.edges).toEqual([
      { from: "a", to: "b", kind: "forward", label: "one" },
      { from: "b", to: "c", kind: "forward", label: "two" },
    ]);
  });

  it("keeps an inline declaration when the node is mentioned again bare", () => {
    const p = parseMermaid(`x["Real label"] --> y["Y"]\ny --> x`);
    expect(p.nodes.find((n) => n.id === "x")?.label).toBe("Real label");
  });

  it("reports a subgraph instead of silently dropping its content", () => {
    const p = parseMermaid(`flowchart TD\n  subgraph Auth\n  a["A"] --> b["B"]\n  end`);
    expect(p.warnings.join(" ")).toContain("subgraph");
    expect(p.edges).toHaveLength(1);
  });

  it("reads LR as the rank direction", () => {
    expect(parseMermaid(`flowchart LR\n a --> b`).rankdir).toBe("LR");
  });
});

describe("graph checks", () => {
  it("flags a decision with only one way out", () => {
    const r = checkGraph(
      [
        { id: "a", label: "A" },
        { id: "q", label: "Ok?", kind: "decision" },
        { id: "z", label: "Z", kind: "terminal" },
      ],
      [
        { from: "a", to: "q" },
        { from: "q", to: "z" },
      ],
    );
    expect(r.warnings.join(" ")).toContain('Decision "q"');
  });

  it("flags a dead end but accepts terminal and external ones", () => {
    const r = checkGraph(
      [
        { id: "a", label: "A" },
        { id: "stop", label: "Stops" },
        { id: "done", label: "Done", kind: "terminal" },
        { id: "out", label: "App Store", kind: "external" },
      ],
      [
        { from: "a", to: "stop" },
        { from: "a", to: "done" },
        { from: "a", to: "out" },
      ],
    );
    const deadEnd = r.warnings.find((w) => w.startsWith("Dead end"));
    expect(deadEnd).toContain('"stop"');
    expect(deadEnd).not.toContain('"done"');
    expect(deadEnd).not.toContain('"out"');
  });

  it("drops an edge pointing at an undeclared node and says so", () => {
    const r = checkGraph([{ id: "a", label: "A" }], [{ from: "a", to: "ghost" }]);
    expect(r.edges).toHaveLength(0);
    expect(r.warnings.join(" ")).toContain('"ghost"');
  });

  it("flags a detached island the start can never reach", () => {
    const r = checkGraph(
      [
        { id: "a", label: "A" },
        { id: "b", label: "B", kind: "terminal" },
        { id: "x", label: "X" },
        { id: "y", label: "Y" },
      ],
      [
        { from: "a", to: "b" },
        { from: "x", to: "y" },
        { from: "y", to: "x" },
      ],
    );
    const unreachable = r.warnings.find((w) => w.startsWith("Unreachable"));
    expect(unreachable).toContain('"x"');
    expect(unreachable).toContain('"y"');
  });

  it("reports several entry points rather than calling them unreachable", () => {
    const r = checkGraph(
      [
        { id: "a", label: "A" },
        { id: "b", label: "B", kind: "terminal" },
        { id: "alt", label: "Deep link" },
      ],
      [
        { from: "a", to: "b" },
        { from: "alt", to: "b" },
      ],
    );
    expect(r.warnings.some((w) => w.startsWith("Unreachable"))).toBe(false);
    expect(r.warnings.join(" ")).toContain("separate entry points");
  });

  it("aggregates missing screenIds into one finding, not one per screen", () => {
    const nodes: FlowNodeSpec[] = [];
    const edges: FlowEdgeSpec[] = [];
    for (let i = 0; i < 12; i++) nodes.push({ id: `n${i}`, label: `N${i}` });
    for (let i = 0; i < 11; i++) edges.push({ from: `n${i}`, to: `n${i + 1}` });
    nodes[11]!.kind = "terminal";
    const r = checkGraph(nodes, edges);
    expect(r.warnings.filter((w) => w.includes("screenId"))).toHaveLength(1);
  });

  it("stays quiet on a well-formed flow", () => {
    const r = checkGraph(
      [
        { id: "a", label: "A", screenId: "1.1" },
        { id: "q", label: "Ok?", kind: "decision" },
        { id: "ok", label: "Ok", kind: "terminal" },
        { id: "no", label: "No", kind: "terminal" },
      ],
      [
        { from: "a", to: "q" },
        { from: "q", to: "ok", label: "yes" },
        { from: "q", to: "no", label: "no" },
      ],
    );
    expect(r.warnings).toEqual([]);
  });
});

describe("layout", () => {
  const sample = spec(
    [
      { id: "a", label: "Start", screenId: "1.1" },
      { id: "q", label: "Valid?", kind: "decision" },
      { id: "err", label: "Error", cls: "error", kind: "terminal" },
      { id: "ok", label: "Done", cls: "happy", kind: "terminal" },
    ],
    [
      { from: "a", to: "q", label: "submit" },
      { from: "q", to: "ok", label: "yes" },
      { from: "q", to: "err", label: "no" },
      { from: "err", to: "a", label: "retry", kind: "return" },
    ],
  );

  it("emits one drawable per node and edge", () => {
    const b = buildUserflow(sample);
    expect(b.draw.boxes).toHaveLength(3);
    expect(b.draw.diamonds).toHaveLength(1);
    expect(b.draw.edges).toHaveLength(4);
    expect(b.stats).toMatchObject({ nodes: 4, edges: 4 });
  });

  it("keeps every drawn node inside the frame", () => {
    const b = buildUserflow(sample);
    for (const n of [...b.draw.boxes, ...b.draw.diamonds]) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.x + n.w).toBeLessThanOrEqual(b.draw.w);
      expect(n.y + n.h).toBeLessThanOrEqual(b.draw.h);
    }
  });

  it("never overlaps two boxes", () => {
    const b = buildUserflow(sample);
    const all = [...b.draw.boxes, ...b.draw.diamonds];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const p = all[i]!;
        const q = all[j]!;
        const overlap =
          p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;
        expect(overlap).toBe(false);
      }
    }
  });

  it("gives every edge one orthogonal polyline, head included", () => {
    const b = buildUserflow(sample);
    for (const e of b.draw.edges) {
      expect(e.points.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < e.points.length; i++) {
        const [x0, y0] = e.points[i - 1]!;
        const [x1, y1] = e.points[i]!;
        const straight = Math.abs(x1 - x0) < 0.3 || Math.abs(y1 - y0) < 0.3;
        expect(straight).toBe(true);
      }
    }
  });

  it("routes the return edge dashed and outside the node band", () => {
    const b = buildUserflow(sample);
    const ret = b.draw.edges.find((e) => e.id === "err->a")!;
    expect(ret.dashed).toBe(true);
    const left = Math.min(...b.draw.boxes.map((n) => n.x));
    const right = Math.max(...b.draw.boxes.map((n) => n.x + n.w));
    const xs = ret.points.map((p) => p[0]);
    expect(Math.min(...xs) < left || Math.max(...xs) > right).toBe(true);
  });

  it("colours an arrow into an error node red", () => {
    const b = buildUserflow(sample);
    expect(b.draw.edges.find((e) => e.id === "q->err")!.color).toBe("#c0392b");
  });

  it("prints screenId and slug on the box, and both in its layer name", () => {
    const b = buildUserflow(
      spec([{ id: "signin", label: "Sign in", screenId: "1.2", slug: "sign-in", kind: "terminal" }], []),
    );
    const box = b.draw.boxes[0]!;
    expect(box.ref).toBe("1.2 · sign-in");
    expect(box.name).toBe("flow:signin · 1.2 · sign-in");
  });

  it("falls back to whichever reference the caller gave", () => {
    const only = buildUserflow(spec([{ id: "a", label: "A", slug: "welcome", kind: "terminal" }], []));
    expect(only.draw.boxes[0]!.ref).toBe("welcome");
    const none = buildUserflow(spec([{ id: "a", label: "A", kind: "terminal" }], []));
    expect(none.draw.boxes[0]!.ref).toBeUndefined();
  });

  it("accepts mermaid instead of nodes/edges", () => {
    const b = buildUserflow({
      title: "M",
      mermaid: `flowchart TD\n a["A"] --> b(["B"])`,
    });
    expect(b.draw.boxes.map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("says so when both mermaid and nodes are passed", () => {
    const b = buildUserflow({
      ...spec([{ id: "a", label: "A", kind: "terminal" }], []),
      mermaid: `a["A"] --> b(["B"])`,
    });
    expect(b.warnings.join(" ")).toContain("mermaid source won");
  });

  it("lays LR out wider than tall for a chain", () => {
    const chain = spec(
      [
        { id: "a", label: "A", kind: "state" },
        { id: "b", label: "B", kind: "state" },
        { id: "c", label: "C", kind: "terminal" },
      ],
      [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
      ],
    );
    const tb = buildUserflow({ ...chain, options: { rankdir: "TB" } });
    const lr = buildUserflow({ ...chain, options: { rankdir: "LR" } });
    expect(tb.draw.h).toBeGreaterThan(tb.draw.w - 200);
    expect(lr.draw.w).toBeGreaterThan(lr.draw.h);
  });

  it("survives a single node with no edges", () => {
    const b = buildUserflow(spec([{ id: "only", label: "Only", kind: "terminal" }], []));
    expect(b.draw.boxes).toHaveLength(1);
    expect(b.draw.w).toBeGreaterThan(0);
  });
});

describe("text metrics", () => {
  it("measures CJK and hangul as full-width, not as Latin letters", () => {
    // 7 ideographs at 13px render ~97px wide; the Latin table alone said 59px,
    // which sized the box ~40% too narrow and spilled the label.
    expect(textWidth("注文を確認する", 13)).toBeGreaterThan(90);
    expect(textWidth("주문 확인", 13)).toBeGreaterThan(55);
  });

  it("keeps Vietnamese diacritics on the Latin scale", () => {
    const withMarks = textWidth("Xác nhận đơn hàng", 13);
    const without = textWidth("Xac nhan don hang", 13);
    expect(Math.abs(withMarks - without)).toBeLessThan(4);
  });

  it("hard-splits a word longer than the wrap limit", () => {
    const lines = wrapText("x".repeat(90), 40);
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(40);
  });

  it("keeps a pathological label from blowing up the box", () => {
    const b = buildUserflow({
      title: "Long",
      nodes: [{ id: "a", label: "Supercalifragilisticexpialidocious".repeat(6), kind: "terminal" }],
      edges: [],
    });
    expect(b.draw.boxes[0]!.w).toBeLessThan(500);
  });
});

describe("font coverage", () => {
  it("warns that Inter draws CJK labels blank, and names the nodes", () => {
    const b = buildUserflow(
      spec(
        [
          { id: "a", label: "注文を確認する", kind: "screen", screenId: "1" },
          { id: "z", label: "End", kind: "terminal" },
        ],
        [{ from: "a", to: "z", label: "次へ" }],
      ),
    );
    const w = b.warnings.find((x) => x.includes("BLANK")) ?? "";
    expect(w).toContain("a→z"); // the edge label counts too, not just nodes
    expect(w).toContain("options.font");
    expect(b.draw.font).toBe("Inter");
  });

  it("stays quiet once a covering font is chosen, and passes it to the plugin", () => {
    const b = buildUserflow({
      ...spec([{ id: "a", label: "注文を確認する", kind: "terminal" }], []),
      options: { font: "Noto Sans JP" },
    });
    expect(b.warnings.some((x) => x.includes("BLANK"))).toBe(false);
    expect(b.draw.font).toBe("Noto Sans JP");
  });

  it("says nothing for Latin or Vietnamese labels", () => {
    const b = buildUserflow(
      spec([{ id: "a", label: "Xác nhận đơn hàng", kind: "terminal" }], []),
    );
    expect(b.warnings.some((x) => x.includes("BLANK"))).toBe(false);
  });
});

describe("review follow-ups", () => {
  it("routes a declared return edge in the gutter even when it points forward", () => {
    // `kind:"return"` used to reach the gutter only when the geometry happened
    // to agree, so a forward-pointing "skip" cut straight through the diagram
    // AND still counted in the rank maths.
    const b = buildUserflow(
      spec(
        [
          { id: "a", label: "A", kind: "state" },
          { id: "b", label: "B", kind: "state" },
          { id: "c", label: "C", kind: "terminal" },
        ],
        [
          { from: "a", to: "b" },
          { from: "b", to: "c" },
          { from: "a", to: "c", label: "skip", kind: "return" },
        ],
      ),
    );
    const ret = b.draw.edges.find((e) => e.id === "a->c")!;
    const left = Math.min(...b.draw.boxes.map((n) => n.x));
    const right = Math.max(...b.draw.boxes.map((n) => n.x + n.w));
    const xs = ret.points.map((p) => p[0]);
    expect(ret.dashed).toBe(true);
    expect(Math.min(...xs) < left || Math.max(...xs) > right).toBe(true);
  });

  it("flags a flow with no entry point at all", () => {
    const r = checkGraph(
      [
        { id: "a", label: "A", screenId: "1" },
        { id: "b", label: "B", screenId: "2" },
      ],
      [
        { from: "a", to: "b", label: "next" },
        { from: "b", to: "a", label: "back" },
      ],
    );
    expect(r.warnings.join(" ")).toContain("no entry point");
  });

  it("flags unlabelled and duplicate decision branches", () => {
    const unlabelled = checkGraph(
      [
        { id: "q", label: "Ok?", kind: "decision" },
        { id: "y", label: "Y", kind: "terminal" },
        { id: "n", label: "N", kind: "terminal" },
      ],
      [
        { from: "q", to: "y" },
        { from: "q", to: "n" },
      ],
    );
    expect(unlabelled.warnings.join(" ")).toContain("no label");

    const duped = checkGraph(
      [
        { id: "q", label: "Ok?", kind: "decision" },
        { id: "y", label: "Y", kind: "terminal" },
        { id: "n", label: "N", kind: "terminal" },
      ],
      [
        { from: "q", to: "y", label: "yes" },
        { from: "q", to: "n", label: "Yes" },
      ],
    );
    expect(duped.warnings.join(" ")).toContain("labelled the same");
  });

  it("reads a mermaid class statement whose ids contain dots", () => {
    const p = parseMermaid('a.b["A"] --> c["C"]\nclass a.b happy');
    expect(p.nodes.map((n) => n.id).sort()).toEqual(["a.b", "c"]);
    expect(p.nodes.find((n) => n.id === "a.b")?.cls).toBe("happy");
    expect(p.warnings).toEqual([]);
  });

  it("reports a class statement it cannot read instead of inventing a node", () => {
    const p = parseMermaid('a["A"] --> b["B"]\nclass');
    expect(p.nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
    expect(p.warnings.join(" ")).toContain("class statement");
  });
});
