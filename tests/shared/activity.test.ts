import { describe, expect, it } from "vitest";
import { buildActivity, checkActivity, reflowActivity, UNASSIGNED_LANE } from "../../src/shared/activity/index.js";
import type { ActivitySpec } from "../../src/shared/activity/types.js";
import type { Placement } from "../../src/shared/diagram/types.js";

/**
 * A swimlane activity diagram. The two things that can go wrong here and
 * nowhere else: a step drawn outside the lane that performs it, and an arrow
 * that crosses lanes by cutting straight through somebody else's step.
 */

const po = (over: Partial<ActivitySpec> = {}): ActivitySpec => ({
  title: "Purchase order approval",
  lanes: [
    { id: "req", label: "Requester" },
    { id: "mgr", label: "Manager" },
    { id: "fin", label: "Finance" },
  ],
  nodes: [
    { id: "s", label: "PO needed", kind: "start", lane: "req" },
    { id: "draft", label: "Draft PO", lane: "req" },
    { id: "review", label: "Review PO", lane: "mgr" },
    { id: "ok", label: "Within budget?", kind: "decision", lane: "mgr" },
    { id: "pay", label: "Release payment", lane: "fin", cls: "happy" },
    { id: "reject", label: "Reject with reason", lane: "mgr", cls: "error" },
    { id: "done", label: "PO closed", kind: "end", lane: "fin", cls: "happy" },
  ],
  edges: [
    { from: "s", to: "draft" },
    { from: "draft", to: "review", label: "submitted PO" },
    { from: "review", to: "ok" },
    { from: "ok", to: "pay", label: "yes" },
    { from: "ok", to: "reject", label: "no" },
    { from: "pay", to: "done" },
    { from: "reject", to: "draft", label: "rework", kind: "return" },
  ],
  ...over,
});

const inside = (outer: Placement, inner: Placement, axis: "x" | "y"): boolean =>
  axis === "y"
    ? inner.y >= outer.y - 0.5 && inner.y + inner.h <= outer.y + outer.h + 0.5
    : inner.x >= outer.x - 0.5 && inner.x + inner.w <= outer.x + outer.w + 0.5;

/** Does any segment of any arrow pass through the inside of a step it does not belong to? */
function crossings(built: ReturnType<typeof buildActivity>): string[] {
  const steps = built.draw.steps;
  const hits: string[] = [];
  for (const e of built.draw.edges) {
    const [from, to] = e.id.split("->");
    const pts = e.points;
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1]!;
      const q = pts[i]!;
      const x0 = Math.min(p[0], q[0]);
      const x1 = Math.max(p[0], q[0]);
      const y0 = Math.min(p[1], q[1]);
      const y1 = Math.max(p[1], q[1]);
      for (const s of steps) {
        if (s.id === from || s.id === to) continue;
        // 2px inside the box: a line grazing a face is fine, going through is not.
        const b = { x: s.at.x + 2, y: s.at.y + 2, w: s.at.w - 4, h: s.at.h - 4 };
        if (x0 < b.x + b.w && x1 > b.x && y0 < b.y + b.h && y1 > b.y) {
          hits.push(`${e.id} through ${s.id}`);
        }
      }
    }
  }
  return hits;
}

describe("swimlane layout", () => {
  const built = buildActivity(po());

  it("draws one band per lane, in the order they were declared", () => {
    expect(built.draw.lanes.map((l) => l.id)).toEqual(["req", "mgr", "fin"]);
    const ys = built.draw.lanes.map((l) => l.at.y);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
    // Bands touch, so the diagram reads as one table rather than three boxes.
    for (let i = 1; i < built.draw.lanes.length; i++) {
      const prev = built.draw.lanes[i - 1]!.at;
      expect(built.draw.lanes[i]!.at.y).toBeCloseTo(prev.y + prev.h, 1);
    }
    // The name strip is a slice of the band, not the whole thing.
    expect(built.draw.lanes[0]!.header.w).toBeLessThan(built.draw.lanes[0]!.at.w);
    expect(built.draw.lanes[0]!.header.h).toBe(built.draw.lanes[0]!.at.h);
  });

  it("keeps every step inside the band of the lane that performs it", () => {
    const bands = new Map(built.draw.lanes.map((l) => [l.id, l.at]));
    const laneOf = new Map(po().nodes!.map((n) => [n.id, n.lane]));
    for (const step of built.draw.steps) {
      const band = bands.get(laneOf.get(step.id)!)!;
      expect(inside(band, step.at, "y"), `${step.id} outside its lane`).toBe(true);
    }
  });

  it("runs the process left to right", () => {
    const at = new Map(built.draw.steps.map((s) => [s.id, s.at]));
    expect(at.get("s")!.x).toBeLessThan(at.get("draft")!.x);
    expect(at.get("draft")!.x).toBeLessThan(at.get("review")!.x);
    expect(at.get("review")!.x).toBeLessThan(at.get("ok")!.x);
    expect(at.get("ok")!.x).toBeLessThan(at.get("pay")!.x);
  });

  it("never routes an arrow through a step it does not belong to", () => {
    expect(crossings(built)).toEqual([]);
  });

  it("crosses lanes in the corridor between two ranks, not through a box", () => {
    const handoff = built.draw.edges.find((e) => e.id === "draft->review")!;
    const xs = handoff.points.map((p) => p[0]);
    const draft = built.draw.steps.find((s) => s.id === "draft")!.at;
    const review = built.draw.steps.find((s) => s.id === "review")!.at;
    // The sideways travel happens between the two, in the gap the layout left.
    const corridor = xs.find((x, i) => i > 0 && x === xs[i - 1])!;
    expect(corridor).toBeGreaterThan(draft.x + draft.w);
    expect(corridor).toBeLessThan(review.x);
  });

  it("sends a return path around the outside of every lane", () => {
    const rework = built.draw.edges.find((e) => e.id === "reject->draft")!;
    expect(rework.dashed).toBe(true);
    const bandTop = Math.min(...built.draw.lanes.map((l) => l.at.y));
    expect(Math.min(...rework.points.map((p) => p[1]))).toBeLessThan(bandTop);
  });

  it("draws one straight arrow when the two steps line up", () => {
    const straight = built.draw.edges.find((e) => e.id === "review->ok")!;
    expect(straight.points).toHaveLength(2);
    expect(straight.points[0]![1]).toBe(straight.points[1]![1]);
  });

  it("reports the handoffs it drew", () => {
    expect(built.stats).toMatchObject({ lanes: 3, nodes: 7, edges: 7, handoffs: 3, returnEdges: 1 });
  });
});

describe("vertical lanes (rankdir TB)", () => {
  const built = buildActivity(po({ options: { rankdir: "TB" } }));

  it("stacks the bands across the page and runs the process downwards", () => {
    const xs = built.draw.lanes.map((l) => l.at.x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(built.draw.lanes[0]!.header.h).toBeLessThan(built.draw.lanes[0]!.at.h);
    const at = new Map(built.draw.steps.map((s) => [s.id, s.at]));
    expect(at.get("s")!.y).toBeLessThan(at.get("draft")!.y);
    expect(at.get("draft")!.y).toBeLessThan(at.get("review")!.y);
  });

  it("keeps every step inside its own column", () => {
    const bands = new Map(built.draw.lanes.map((l) => [l.id, l.at]));
    const laneOf = new Map(po().nodes!.map((n) => [n.id, n.lane]));
    for (const step of built.draw.steps) {
      expect(inside(bands.get(laneOf.get(step.id)!)!, step.at, "x"), step.id).toBe(true);
    }
  });

  it("still routes around every step", () => {
    expect(crossings(built)).toEqual([]);
  });
});

describe("a skip that cannot go straight", () => {
  // a → b → c → d in ONE lane, plus a → d. The straight run and the corridor
  // run both pass through b and c, so the only honest route is around the
  // outside — the case the outer gutter exists for.
  const built = buildActivity({
    title: "Skip",
    lanes: [{ id: "one", label: "One" }],
    nodes: [
      { id: "a", label: "A", kind: "start", lane: "one" },
      { id: "b", label: "B", lane: "one" },
      { id: "c", label: "C", lane: "one" },
      { id: "d", label: "D", kind: "end", lane: "one" },
    ],
    edges: [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "c", to: "d" },
      { from: "a", to: "d", label: "skip" },
    ],
  });

  it("routes it outside the lanes instead of through the steps", () => {
    expect(crossings(built)).toEqual([]);
    const skip = built.draw.edges.find((e) => e.id === "a->d")!;
    const band = built.draw.lanes[0]!.at;
    const outside = skip.points.some((p) => p[1] > band.y + band.h || p[1] < band.y);
    expect(outside).toBe(true);
  });
});

describe("fork and join", () => {
  const built = buildActivity({
    title: "Parallel",
    lanes: [
      { id: "ops", label: "Ops" },
      { id: "qa", label: "QA" },
    ],
    nodes: [
      { id: "s", label: "Order paid", kind: "start", lane: "ops" },
      { id: "f", label: "", kind: "fork", lane: "ops" },
      { id: "pick", label: "Pick items", lane: "ops" },
      { id: "check", label: "Quality check", lane: "qa" },
      { id: "j", label: "", kind: "join", lane: "ops" },
      { id: "ship", label: "Ship", kind: "end", lane: "ops" },
    ],
    edges: [
      { from: "s", to: "f" },
      { from: "f", to: "pick" },
      { from: "f", to: "check" },
      { from: "pick", to: "j" },
      { from: "check", to: "j" },
      { from: "j", to: "ship" },
    ],
  });

  it("draws the fork as a bar across the flow", () => {
    const bar = built.draw.steps.find((s) => s.id === "f")!;
    expect(bar.at.w).toBeLessThan(bar.at.h); // thin along the flow, long across it
    expect(bar.title).toBe("");
  });

  it("spreads the parallel branches across the bar", () => {
    const out = built.draw.edges.filter((e) => e.id.startsWith("f->"));
    expect(out).toHaveLength(2);
    expect(out[0]!.points[0]![1]).not.toBe(out[1]!.points[0]![1]);
  });

  it("warns about a fork whose branches never rejoin", () => {
    const { warnings } = checkActivity(
      [{ id: "ops", label: "Ops" }],
      [
        { id: "f", label: "", kind: "fork", lane: "ops" },
        { id: "x", label: "X", kind: "end", lane: "ops" },
        { id: "y", label: "Y", kind: "end", lane: "ops" },
      ],
      [
        { from: "f", to: "x" },
        { from: "f", to: "y" },
      ],
    );
    expect(warnings.join(" ")).toContain("no join downstream");
  });
});

describe("the proof-read", () => {
  it("puts a step whose lane does not exist in a visible (no lane) band", () => {
    const res = checkActivity(
      [{ id: "req", label: "Requester" }],
      [{ id: "x", label: "Do a thing", lane: "nope" }],
      [],
    );
    expect(res.nodes[0]!.lane).toBe(UNASSIGNED_LANE);
    expect(res.lanes.map((l) => l.id)).toContain(UNASSIGNED_LANE);
    expect(res.warnings.join(" ")).toContain("No owning lane");
  });

  it("names an unlabelled handoff between lanes", () => {
    const res = checkActivity(
      [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
      [
        { id: "one", label: "One", kind: "start", lane: "a" },
        { id: "two", label: "Two", kind: "end", lane: "b" },
      ],
      [{ from: "one", to: "two" }],
    );
    expect(res.warnings.join(" ")).toContain("Unlabelled handoff");
  });

  it("says nothing about a handoff that names what crosses", () => {
    const res = checkActivity(
      [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
      [
        { id: "one", label: "One", kind: "start", lane: "a" },
        { id: "two", label: "Two", kind: "end", lane: "b" },
      ],
      [{ from: "one", to: "two", label: "signed contract" }],
    );
    expect(res.warnings.join(" ")).not.toContain("Unlabelled handoff");
  });

  it("asks for a trigger and an outcome", () => {
    const res = checkActivity(
      [{ id: "a", label: "A" }],
      [{ id: "one", label: "One", lane: "a" }],
      [],
    );
    const all = res.warnings.join(" ");
    expect(all).toContain('No kind:"start"');
    expect(all).toContain('No kind:"end"');
    expect(all).toContain("Dead end");
  });

  it("names a lane nobody works in", () => {
    const res = checkActivity(
      [
        { id: "a", label: "A" },
        { id: "idle", label: "Legal" },
      ],
      [{ id: "one", label: "One", kind: "start", lane: "a" }],
      [],
    );
    expect(res.warnings.join(" ")).toContain('Lane with no steps: "idle"');
  });

  it("keeps a clean process quiet", () => {
    expect(buildActivity(po()).warnings).toEqual([]);
  });
});

describe("reflowActivity", () => {
  const built = buildActivity(po());
  const graph = built.draw.graph!;
  const asDrawn = () => new Map(graph.nodes.map((n) => [n.id, { ...n.at }]));

  it("reproduces the drawn geometry when nothing has moved", () => {
    const res = reflowActivity(graph, asDrawn());
    expect(res.moved).toEqual([]);
    expect(res.relaned).toEqual([]);
    expect(res.edges).toEqual(built.draw.edges);
  });

  it("follows a step that was dragged", () => {
    const placed = asDrawn();
    const draft = placed.get("draft")!;
    placed.set("draft", { ...draft, x: draft.x + 40, y: draft.y + 20 });

    const res = reflowActivity(graph, placed);
    expect(res.moved).toEqual(["draft"]);
    const before = built.draw.edges.find((e) => e.id === "s->draft")!;
    const after = res.edges.find((e) => e.id === "s->draft")!;
    expect(after.points).not.toEqual(before.points);
    expect(after.points[after.points.length - 1]![0]).toBeCloseTo(draft.x + 40, 0);
  });

  it("reports a step dragged into another lane instead of rewriting the process", () => {
    const placed = asDrawn();
    const draft = placed.get("draft")!;
    const finance = graph.lanes.find((l) => l.id === "fin")!.at;
    placed.set("draft", { ...draft, y: finance.y + 20 });

    const res = reflowActivity(graph, placed);
    expect(res.relaned).toEqual([{ id: "draft", from: "req", to: "fin" }]);
    // The graph still says "req": the tool reports the move, it does not decide
    // that the process changed hands.
    expect(graph.nodes.find((n) => n.id === "draft")!.lane).toBe("req");
  });

  it("drops an arrow whose step is gone", () => {
    const placed = asDrawn();
    placed.delete("pay");
    const res = reflowActivity(graph, placed);
    expect(res.dropped).toEqual(expect.arrayContaining(["ok->pay", "pay->done"]));
  });
});

/**
 * The same notation without swimlanes: a plain activity diagram. Nothing is
 * constraining the cross axis any more, so dagre's own positions are kept —
 * but the corridors between ranks (and therefore the router) are unchanged.
 */
describe("a plain activity diagram (no lanes)", () => {
  const built = buildActivity({
    title: "Refund request",
    nodes: [
      { id: "s", label: "Refund requested", kind: "start" },
      { id: "check", label: "Check order", detail: "amount, date, payment" },
      { id: "ok", label: "Eligible?", kind: "decision" },
      { id: "refund", label: "Issue refund", cls: "happy" },
      { id: "deny", label: "Explain why not", cls: "error" },
      { id: "done", label: "Ticket closed", kind: "end", cls: "happy" },
    ],
    edges: [
      { from: "s", to: "check" },
      { from: "check", to: "ok" },
      { from: "ok", to: "refund", label: "yes" },
      { from: "ok", to: "deny", label: "no" },
      { from: "refund", to: "done" },
      { from: "deny", to: "done" },
      { from: "deny", to: "check", label: "more evidence", kind: "return" },
    ],
  });

  it("draws no bands at all", () => {
    expect(built.draw.lanes).toEqual([]);
    expect(built.stats.lanes).toBe(0);
    expect(built.stats.handoffs).toBe(0);
  });

  it("says nothing about handoffs or idle lanes, because there are none", () => {
    const all = built.warnings.join(" ");
    expect(all).not.toContain("handoff");
    expect(all).not.toContain("Lane with no steps");
    expect(built.warnings).toEqual([]);
  });

  it("still keeps the process running one way and the arrows off the boxes", () => {
    const at = new Map(built.draw.steps.map((s) => [s.id, s.at]));
    expect(at.get("s")!.x).toBeLessThan(at.get("check")!.x);
    expect(at.get("ok")!.x).toBeLessThan(at.get("refund")!.x);
    expect(crossings(built)).toEqual([]);
  });

  it("starts at the frame's padding, with no lane name strip to leave room for", () => {
    const leftmost = Math.min(...built.draw.steps.map((s) => s.at.x));
    expect(leftmost).toBe(40);
  });

  it("still sends the rework path around the outside", () => {
    const rework = built.draw.edges.find((e) => e.id === "deny->check")!;
    expect(rework.dashed).toBe(true);
    const top = Math.min(...built.draw.steps.map((s) => s.at.y));
    const bottom = Math.max(...built.draw.steps.map((s) => s.at.y + s.at.h));
    const ys = rework.points.map((p) => p[1]);
    expect(Math.min(...ys) < top || Math.max(...ys) > bottom).toBe(true);
  });

  it("re-routes on a drag without claiming the step changed lane", () => {
    const graph = built.draw.graph!;
    const placed = new Map(graph.nodes.map((n) => [n.id, { ...n.at }]));
    const check = placed.get("check")!;
    placed.set("check", { ...check, y: check.y + 120 });

    const res = reflowActivity(graph, placed);
    expect(res.moved).toEqual(["check"]);
    expect(res.relaned).toEqual([]);
  });

  it("reproduces the drawn geometry when nothing has moved", () => {
    const graph = built.draw.graph!;
    const placed = new Map(graph.nodes.map((n) => [n.id, { ...n.at }]));
    expect(reflowActivity(graph, placed).edges).toEqual(built.draw.edges);
  });
});

/**
 * Steering a connection point from the spec. The router spreads ports evenly
 * and cannot know which one reads best; this is how an agent (or a person
 * asking one) says so, and unlike a hand edit it keeps following the boxes.
 */
describe("fromAt / toAt", () => {
  const twoWays = (over: Record<string, unknown> = {}) =>
    buildActivity({
      title: "Ports",
      lanes: [{ id: "one", label: "One" }],
      nodes: [
        { id: "a", label: "Start here", kind: "start", lane: "one" },
        { id: "b", label: "Then this", kind: "end", lane: "one" },
      ],
      edges: [{ from: "a", to: "b", ...over }],
    });

  it("moves the arrow's start along the source's face", () => {
    const middle = twoWays().draw.edges[0]!;
    const low = twoWays({ fromAt: 0 }).draw.edges[0]!;
    const high = twoWays({ fromAt: 1 }).draw.edges[0]!;

    expect(low.points[0]![1]).toBeLessThan(middle.points[0]![1]);
    expect(high.points[0]![1]).toBeGreaterThan(middle.points[0]![1]);
    // Still on the box's own face, not floating next to it.
    const a = twoWays().draw.steps.find((s) => s.id === "a")!.at;
    expect(low.points[0]![0]).toBeCloseTo(a.x + a.w, 0);
    expect(low.points[0]![1]).toBeGreaterThanOrEqual(a.y);
  });

  it("moves the arrow's end along the target's face", () => {
    const middle = twoWays().draw.edges[0]!;
    const high = twoWays({ toAt: 1 }).draw.edges[0]!;
    const tip = (e: { points: Array<[number, number]> }) => e.points[e.points.length - 1]!;
    expect(tip(high)[1]).toBeGreaterThan(tip(middle)[1]);
  });

  it("survives a reflow, so the arrow still follows its boxes", () => {
    const built = twoWays({ fromAt: 0, toAt: 1 });
    const graph = built.draw.graph!;
    const placed = new Map(graph.nodes.map((n) => [n.id, { ...n.at }]));

    expect(reflowActivity(graph, placed).edges).toEqual(built.draw.edges);

    const b = placed.get("b")!;
    placed.set("b", { ...b, x: b.x + 200 });
    const after = reflowActivity(graph, placed).edges[0]!;
    // Same port on the source, new position for the target.
    expect(after.points[0]![1]).toBe(built.draw.edges[0]!.points[0]![1]);
    const tipOf = (e: { points: Array<[number, number]> }) => e.points[e.points.length - 1]!;
    expect(tipOf(after)[0]).toBeGreaterThan(tipOf(built.draw.edges[0]!)[0]);
  });

  it("leaves a diamond attached to its tip whatever it is asked", () => {
    const withDiamond = (over: Record<string, unknown>) =>
      buildActivity({
        title: "Diamond",
        lanes: [{ id: "one", label: "One" }],
        nodes: [
          { id: "q", label: "Sure?", kind: "decision", lane: "one" },
          { id: "y", label: "Yes", kind: "end", lane: "one" },
          { id: "n", label: "No", kind: "end", lane: "one" },
        ],
        edges: [
          { from: "q", to: "y", label: "yes", ...over },
          { from: "q", to: "n", label: "no" },
        ],
      }).draw.edges.find((e) => e.id === "q->y")!;

    expect(withDiamond({ fromAt: 0 }).points[0]).toEqual(withDiamond({}).points[0]);
  });
});

/**
 * The two things a live drawing kept getting wrong, from the screenshots that
 * reported them: a decision whose branches all left the same tip (two arrows
 * drawn on top of each other), and a label sitting on somebody else's line.
 */
describe("a decision with two ways out", () => {
  const built = buildActivity({
    title: "Branches",
    lanes: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ],
    nodes: [
      { id: "s", label: "Start", kind: "start", lane: "a" },
      { id: "q", label: "Đủ chứng từ?", kind: "decision", lane: "a" },
      { id: "more", label: "Yêu cầu bổ sung", lane: "a", cls: "edge" },
      { id: "go", label: "Tiếp tục", lane: "b" },
      { id: "end", label: "Xong", kind: "end", lane: "b", cls: "happy" },
    ],
    edges: [
      { from: "s", to: "q" },
      { from: "q", to: "more", label: "thiếu" },
      { from: "q", to: "go", label: "đủ" },
      { from: "more", to: "go", label: "đã bổ sung" },
      { from: "go", to: "end" },
    ],
  });

  it("sends the branches out of DIFFERENT tips", () => {
    const a = built.draw.edges.find((e) => e.id === "q->more")!;
    const b = built.draw.edges.find((e) => e.id === "q->go")!;
    expect(a.points[0]).not.toEqual(b.points[0]);
  });

  it("does not draw the two branches on top of each other", () => {
    const a = built.draw.edges.find((e) => e.id === "q->more")!;
    const b = built.draw.edges.find((e) => e.id === "q->go")!;
    // No shared segment: the first hop of each leaves on its own line.
    const seg = (e: typeof a) => `${e.points[0]![0]},${e.points[0]![1]}-${e.points[1]![0]},${e.points[1]![1]}`;
    expect(seg(a)).not.toBe(seg(b));
  });
});

describe("labels and other people's lines", () => {
  /** Does any label sit on an arrow that is not its own? */
  function labelOnForeignLine(built: ReturnType<typeof buildActivity>): string[] {
    const hits: string[] = [];
    for (const e of built.draw.edges) {
      if (!e.label) continue;
      const r = { x: e.label.x, y: e.label.y, w: e.label.w, h: e.label.h };
      for (const other of built.draw.edges) {
        if (other.id === e.id) continue;
        for (let i = 1; i < other.points.length; i++) {
          const p = other.points[i - 1]!;
          const q = other.points[i]!;
          const bx = Math.min(p[0], q[0]);
          const by = Math.min(p[1], q[1]);
          const bw = Math.abs(p[0] - q[0]);
          const bh = Math.abs(p[1] - q[1]);
          if (bx < r.x + r.w && bx + bw > r.x && by < r.y + r.h && by + bh > r.y) {
            hits.push(`${e.id} over ${other.id}`);
          }
        }
      }
    }
    return hits;
  }

  it("keeps every label clear of arrows it does not belong to", () => {
    expect(labelOnForeignLine(buildActivity(po()))).toEqual([]);
  });

  it("keeps them clear in a process with parallel work and rework too", () => {
    const built = buildActivity({
      title: "Busy",
      lanes: [
        { id: "kh", label: "Khách" },
        { id: "los", label: "LOS" },
        { id: "ext", label: "Đối tác" },
      ],
      nodes: [
        { id: "s", label: "Gửi hồ sơ", kind: "start", lane: "kh" },
        { id: "v", label: "Kiểm tra", lane: "los" },
        { id: "d", label: "Đủ?", kind: "decision", lane: "los" },
        { id: "ask", label: "Yêu cầu bổ sung", lane: "los", cls: "edge" },
        { id: "f", label: "", kind: "fork", lane: "los" },
        { id: "e1", label: "eKYC", kind: "external", lane: "ext" },
        { id: "e2", label: "CIC", kind: "external", lane: "ext" },
        { id: "j", label: "", kind: "join", lane: "los" },
        { id: "ok", label: "Duyệt", kind: "end", lane: "los", cls: "happy" },
      ],
      edges: [
        { from: "s", to: "v", label: "hồ sơ" },
        { from: "v", to: "d" },
        { from: "d", to: "ask", label: "thiếu" },
        { from: "d", to: "f", label: "đủ" },
        { from: "ask", to: "v", label: "chứng từ bổ sung", kind: "return" },
        { from: "f", to: "e1" },
        { from: "f", to: "e2" },
        { from: "e1", to: "j", label: "kết quả eKYC" },
        { from: "e2", to: "j", label: "điểm CIC" },
        { from: "j", to: "ok", label: "đạt" },
      ],
    });
    expect(labelOnForeignLine(built)).toEqual([]);
  });
});

describe("labels and the boxes", () => {
  it("never sits on a step", () => {
    // The first cut of the label-clearing pass moved a label off somebody
    // else's line and straight onto the start pill.
    const built = buildActivity(po());
    for (const e of built.draw.edges) {
      if (!e.label) continue;
      const r = e.label;
      for (const s of built.draw.steps) {
        const hit =
          r.x < s.at.x + s.at.w && r.x + r.w > s.at.x && r.y < s.at.y + s.at.h && r.y + r.h > s.at.y;
        expect(hit, `${e.id} label over ${s.id}`).toBe(false);
      }
    }
  });
});
