import { describe, expect, it } from "vitest";
import { buildUserflow } from "../../src/shared/userflow/index.js";
import { reflowUserflow, type RouteGraph } from "../../src/shared/userflow/route.js";
import { edgeIds } from "../../src/shared/diagram/graph.js";

/**
 * Routing without dagre — the pass that runs in the PLUGIN every time a box is
 * dragged. Figma Design has no connector node, so this is the whole mechanism
 * behind "the arrow follows the box": same graph, new positions, new geometry.
 */

const graph = (over: Partial<RouteGraph> = {}): RouteGraph => ({
  rankdir: "TB",
  colorByTarget: true,
  liveRoute: true,
  nodes: [
    { id: "a", kind: "screen", cls: "plain" },
    { id: "b", kind: "screen", cls: "plain" },
  ],
  edges: [{ from: "a", to: "b", kind: "forward", labelLines: ["ok"], lw: 40, lh: 20 }],
  ...over,
});

const at = (x: number, y: number, w = 140, h = 60) => ({ x, y, w, h });

describe("reflowUserflow", () => {
  it("starts on the source's bottom edge and ends on the target's top edge", () => {
    const { edges, dropped } = reflowUserflow(
      graph(),
      new Map([
        ["a", at(0, 0)],
        ["b", at(0, 200)],
      ]),
    );

    expect(dropped).toEqual([]);
    expect(edges).toHaveLength(1);
    const e = edges[0]!;
    expect(e.id).toBe("a->b");
    expect(e.points[0]![1]).toBe(60); // a.y + a.h
    // The head is a cap on the last point, so the line runs to b's top edge.
    expect(e.points[e.points.length - 1]).toEqual([70, 200]);
  });

  it("follows the box: moving the target moves the arrow's end", () => {
    const placed = new Map([
      ["a", at(0, 0)],
      ["b", at(0, 200)],
    ]);
    const before = reflowUserflow(graph(), placed).edges[0]!;

    placed.set("b", at(400, 500));
    const after = reflowUserflow(graph(), placed).edges[0]!;

    expect(after.points[after.points.length - 1]).toEqual([470, 500]);
    expect(after.points[after.points.length - 1]).not.toEqual(before.points[before.points.length - 1]);
    // Still an orthogonal path: every segment runs on one axis.
    for (let i = 1; i < after.points.length; i++) {
      const p = after.points[i - 1]!;
      const q = after.points[i]!;
      expect(p[0] === q[0] || p[1] === q[1]).toBe(true);
    }
  });

  it("re-decides the gutter when a drag turns an edge backwards", () => {
    const down = reflowUserflow(
      graph(),
      new Map([
        ["a", at(0, 0)],
        ["b", at(0, 200)],
      ]),
    ).edges[0]!;
    expect(down.dashed).toBe(false);

    // b dragged ABOVE a: the same forward edge now runs against the ranks, so
    // it is routed out into a side gutter and dashed, exactly as the layout
    // pass would have done.
    const up = reflowUserflow(
      graph(),
      new Map([
        ["a", at(0, 300)],
        ["b", at(0, 0)],
      ]),
    ).edges[0]!;
    expect(up.dashed).toBe(true);
    const maxX = Math.max(...up.points.map((p) => p[0]));
    expect(maxX).toBeGreaterThan(140); // outside both boxes
  });

  it("moves the label with the arrow", () => {
    const near = reflowUserflow(
      graph(),
      new Map([
        ["a", at(0, 0)],
        ["b", at(0, 200)],
      ]),
    ).edges[0]!;
    const far = reflowUserflow(
      graph(),
      new Map([
        ["a", at(0, 0)],
        ["b", at(0, 600)],
      ]),
    ).edges[0]!;

    expect(near.label?.text).toBe("ok");
    expect(far.label!.y).toBeGreaterThan(near.label!.y);
  });

  it("reports an edge whose box is gone instead of routing it", () => {
    const { edges, dropped } = reflowUserflow(graph(), new Map([["a", at(0, 0)]]));
    expect(edges).toEqual([]);
    expect(dropped).toEqual(["a->b"]);
  });

  it("colours by the class of the box it points at", () => {
    const g = graph({
      nodes: [
        { id: "a", kind: "screen", cls: "plain" },
        { id: "b", kind: "screen", cls: "error" },
      ],
    });
    const placed = new Map([
      ["a", at(0, 0)],
      ["b", at(0, 200)],
    ]);
    expect(reflowUserflow(g, placed).edges[0]!.color).toBe("#c0392b");
    expect(reflowUserflow({ ...g, colorByTarget: false }, placed).edges[0]!.color).toBe("#000f22");
  });

  it("keeps a self-loop attached to its own box", () => {
    const g = graph({
      nodes: [{ id: "a", kind: "screen", cls: "plain" }],
      edges: [{ from: "a", to: "a", kind: "forward", labelLines: [], lw: 0, lh: 0 }],
    });
    const e = reflowUserflow(g, new Map([["a", at(50, 50)]])).edges[0]!;
    expect(e.id).toBe("a->a");
    const maxX = Math.max(...e.points.map((p) => p[0]));
    expect(maxX).toBeGreaterThan(190); // loops out past the box's right edge
  });
});

describe("edgeIds", () => {
  it("names an edge after its endpoints", () => {
    expect(edgeIds([{ from: "a", to: "b" }])).toEqual(["a->b"]);
  });

  it("keeps two edges between the same pair apart", () => {
    // Both would otherwise be drawn as `edge a->b`, and a reflow would then
    // move one line twice and leave the other behind.
    expect(edgeIds([{ from: "a", to: "b" }, { from: "a", to: "b" }])).toEqual(["a->b#1", "a->b#2"]);
  });
});

describe("the stored graph", () => {
  it("is emitted with the draw data, so the frame can re-route itself", () => {
    const built = buildUserflow({
      title: "Checkout",
      nodes: [
        { id: "cart", label: "Cart" },
        { id: "pay", label: "Pay", cls: "happy" },
      ],
      edges: [{ from: "cart", to: "pay", label: "checkout" }],
    });

    const g = built.draw.graph!;
    expect(g.rankdir).toBe("TB");
    expect(g.liveRoute).toBe(true);
    expect(g.nodes.map((n) => [n.id, n.kind, n.cls])).toEqual([
      ["cart", "screen", "plain"],
      ["pay", "screen", "happy"],
    ]);
    // Where the layout PUT each box: the reference a reflow compares against.
    const cart = g.nodes[0]!.at!;
    const drawn = built.draw.boxes.find((b) => b.id === "cart")!;
    expect([cart.x, cart.y, cart.w, cart.h]).toEqual([drawn.x, drawn.y, drawn.w, drawn.h]);
    expect(g.edges[0]).toMatchObject({ from: "cart", to: "pay", kind: "forward" });
    expect(g.edges[0]!.labelLines).toEqual(["checkout"]);
    // The ids the reflow computes must be the ids the draw pass used.
    expect(edgeIds(g.edges)).toEqual(built.draw.edges.map((e) => e.id));
  });

  it("records the opt-out so a frame can keep its arrows as drawn", () => {
    const built = buildUserflow({
      title: "Frozen",
      nodes: [{ id: "a", label: "A" }],
      edges: [],
      options: { liveRoute: false },
    });
    expect(built.draw.graph!.liveRoute).toBe(false);
  });
});

/**
 * The bug a live run found: the DRAW pass's own document changes reached the
 * live listener, which re-routed a diagram dagre had just laid out — arrows
 * lost their waypoints and two labels landed on top of each other. The frame
 * therefore remembers where the layout put each box, and a reflow is a no-op
 * until something actually moves.
 */
describe("a reflow of an untouched flow", () => {
  const built = buildUserflow({
    title: "Auth",
    nodes: [
      { id: "signin", label: "Sign in" },
      { id: "check", label: "Password correct?", kind: "decision" },
      { id: "ok", label: "Home", cls: "happy" },
      { id: "bad", label: "Wrong password", cls: "error" },
    ],
    edges: [
      { from: "signin", to: "check" },
      { from: "check", to: "ok", label: "yes" },
      { from: "check", to: "bad", label: "no" },
      { from: "bad", to: "signin", label: "Try again", kind: "return" },
    ],
  });
  const graph = built.draw.graph!;
  const asDrawn = () => new Map(graph.nodes.map((n) => [n.id, { ...n.at! }]));
  const drawn = (id: string) => built.draw.edges.find((e) => e.id === id)!;

  it("reports nothing moved", () => {
    expect(reflowUserflow(graph, asDrawn()).moved).toEqual([]);
  });

  it("reproduces the drawn geometry instead of coarsening it", () => {
    const { edges } = reflowUserflow(graph, asDrawn());
    for (const e of edges) {
      expect({ id: e.id, points: e.points }).toEqual({
        id: e.id,
        points: drawn(e.id).points,
      });
      expect(e.label?.x).toBe(drawn(e.id).label?.x);
      expect(e.label?.y).toBe(drawn(e.id).label?.y);
    }
  });

  it("leaves an arrow between two untouched boxes exactly as drawn", () => {
    const placed = asDrawn();
    placed.set("ok", { ...placed.get("ok")!, y: placed.get("ok")!.y + 200 });

    const { edges, moved } = reflowUserflow(graph, placed);
    expect(moved).toEqual(["ok"]);
    const byId = new Map(edges.map((e) => [e.id, e]));
    expect(byId.get("check->bad")!.points).toEqual(drawn("check->bad").points);
    expect(byId.get("check->ok")!.points).not.toEqual(drawn("check->ok").points);
  });
});

/**
 * Steering a connection point from the spec — the declarative version of what
 * a designer would otherwise do by dragging the arrow's end, and the version
 * that keeps following the boxes afterwards.
 */
describe("fromAt / toAt", () => {
  const pair = (over: Record<string, unknown> = {}) =>
    buildUserflow({
      title: "Ports",
      nodes: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
      edges: [{ from: "a", to: "b", ...over }],
    });

  it("slides the arrow along the face it leaves from", () => {
    const middle = pair().draw.edges[0]!;
    const left = pair({ fromAt: 0 }).draw.edges[0]!;
    const right = pair({ fromAt: 1 }).draw.edges[0]!;
    expect(left.points[0]![0]).toBeLessThan(middle.points[0]![0]);
    expect(right.points[0]![0]).toBeGreaterThan(middle.points[0]![0]);
  });

  it("slides the arrow along the face it arrives at", () => {
    const middle = pair().draw.edges[0]!;
    const right = pair({ toAt: 1 }).draw.edges[0]!;
    const tip = (e: { points: Array<[number, number]> }) => e.points[e.points.length - 1]!;
    expect(tip(right)[0]).toBeGreaterThan(tip(middle)[0]);
  });

  it("keeps the wish through a reflow", () => {
    const built = pair({ fromAt: 0, toAt: 1 });
    const graph = built.draw.graph!;
    const placed = new Map(graph.nodes.map((n) => [n.id, { ...n.at! }]));
    expect(reflowUserflow(graph, placed).edges).toEqual(built.draw.edges);

    const b = placed.get("b")!;
    placed.set("b", { ...b, y: b.y + 200 });
    const after = reflowUserflow(graph, placed).edges[0]!;
    expect(after.points[0]![0]).toBe(built.draw.edges[0]!.points[0]![0]);
  });

  it("keeps a decision on its tip whatever it is asked", () => {
    const withDiamond = (over: Record<string, unknown>) =>
      buildUserflow({
        title: "Diamond",
        nodes: [
          { id: "q", label: "Sure?", kind: "decision" },
          { id: "y", label: "Yes", kind: "terminal" },
          { id: "n", label: "No", kind: "terminal" },
        ],
        edges: [
          { from: "q", to: "y", label: "yes", ...over },
          { from: "q", to: "n", label: "no" },
        ],
      }).draw.edges.find((e) => e.id === "q->y")!;
    expect(withDiamond({ fromAt: 0 }).points[0]).toEqual(withDiamond({}).points[0]);
  });
});

describe("a decision's branches in a userflow", () => {
  const built = buildUserflow({
    title: "Branches",
    nodes: [
      { id: "screen", label: "Nhập OTP" },
      { id: "q", label: "OTP đúng?", kind: "decision" },
      { id: "ok", label: "Thành công", cls: "happy", kind: "terminal" },
      { id: "bad", label: "Sai OTP", cls: "error", kind: "terminal" },
    ],
    edges: [
      { from: "screen", to: "q" },
      { from: "q", to: "ok", label: "đúng" },
      { from: "q", to: "bad", label: "sai" },
    ],
  });

  it("leaves the diamond by different tips", () => {
    const yes = built.draw.edges.find((e) => e.id === "q->ok")!;
    const no = built.draw.edges.find((e) => e.id === "q->bad")!;
    expect(yes.points[0]).not.toEqual(no.points[0]);
  });

  it("keeps both labels off the other branch", () => {
    for (const e of built.draw.edges) {
      if (!e.label) continue;
      const r = e.label;
      for (const other of built.draw.edges) {
        if (other.id === e.id) continue;
        for (let i = 1; i < other.points.length; i++) {
          const p = other.points[i - 1]!;
          const q = other.points[i]!;
          const bx = Math.min(p[0], q[0]);
          const by = Math.min(p[1], q[1]);
          const bw = Math.abs(p[0] - q[0]);
          const bh = Math.abs(p[1] - q[1]);
          const hit = bx < r.x + r.w && bx + bw > r.x && by < r.y + r.h && by + bh > r.y;
          expect(hit, `${e.id} label over ${other.id}`).toBe(false);
        }
      }
    }
  });
});

describe("labels and the boxes", () => {
  it("never sits on a box", () => {
    const built = buildUserflow({
      title: "Boxes",
      nodes: [
        { id: "a", label: "Nhập OTP" },
        { id: "q", label: "OTP đúng?", kind: "decision" },
        { id: "ok", label: "Thành công", kind: "terminal", cls: "happy" },
        { id: "bad", label: "Sai OTP", kind: "terminal", cls: "error" },
      ],
      edges: [
        { from: "a", to: "q", label: "gửi mã" },
        { from: "q", to: "ok", label: "đúng" },
        { from: "q", to: "bad", label: "sai" },
      ],
    });
    const boxes = built.draw.boxes
      .map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h }))
      .concat(built.draw.diamonds.map((d) => ({ x: d.x, y: d.y, w: d.w, h: d.h })));
    for (const e of built.draw.edges) {
      if (!e.label) continue;
      const r = e.label;
      for (const b of boxes) {
        const hit = r.x < b.x + b.w && r.x + r.w > b.x && r.y < b.y + b.h && r.y + r.h > b.y;
        expect(hit, `${e.id} label over a box`).toBe(false);
      }
    }
  });
});
