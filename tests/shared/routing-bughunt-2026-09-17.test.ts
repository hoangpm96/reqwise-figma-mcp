import { describe, expect, it } from "vitest";
import { buildActivity, checkActivity } from "../../src/shared/activity/index.js";
import { routeActivity, type StepPlace } from "../../src/shared/activity/route.js";
import { connectPorts, routeThroughPorts, SIDES, type Side } from "../../src/shared/diagram/connector.js";
import { Axis, simplify, type Pt } from "../../src/shared/diagram/geometry.js";
import type { Placement } from "../../src/shared/diagram/types.js";
import { checkConsistency } from "../../src/shared/model/check.js";
import { collectFacts, type StoredDiagram } from "../../src/shared/model/facts.js";
import { checkState } from "../../src/shared/state/check.js";
import { parseStateText } from "../../src/shared/state/text.js";
import { markBackEdges, route, type RouteEdge, type RouteNode } from "../../src/shared/userflow/route.js";

/**
 * Regressions from the 2026-09-17 routing/checker bug hunt. Each block names
 * the bug it pins; every one of them failed before its fix.
 */

/** Does any segment pass through the inside of the box (grazing a face is fine)? */
function cuts(points: Pt[], b: Placement): boolean {
  for (let i = 1; i < points.length; i++) {
    const p = points[i - 1]!;
    const q = points[i]!;
    const x0 = Math.min(p[0], q[0]);
    const x1 = Math.max(p[0], q[0]);
    const y0 = Math.min(p[1], q[1]);
    const y1 = Math.max(p[1], q[1]);
    if (x0 < b.x + b.w - 1 && x1 > b.x + 1 && y0 < b.y + b.h - 1 && y1 > b.y + 1) return true;
  }
  return false;
}

describe("#47 a labelled fork/join bar", () => {
  const spec = (rankdir: "TB" | "LR") =>
    buildActivity({
      title: "Parallel",
      lanes: [{ id: "ops", label: "Ops" }],
      nodes: [
        { id: "s", label: "Paid", kind: "start", lane: "ops" },
        { id: "f", label: "Split the order", kind: "fork", lane: "ops" },
        { id: "a", label: "Pick", lane: "ops" },
        { id: "b", label: "Pack", lane: "ops" },
        { id: "j", label: "", kind: "join", lane: "ops" },
        { id: "e", label: "Shipped", kind: "end", lane: "ops" },
      ],
      edges: [
        { from: "s", to: "f" },
        { from: "f", to: "a" },
        { from: "f", to: "b" },
        { from: "a", to: "j" },
        { from: "b", to: "j" },
        { from: "j", to: "e" },
      ],
      options: { rankdir },
    });

  it("gets a label box as wide as its text in both rank directions", () => {
    const lr = spec("LR").draw.steps.find((s) => s.id === "f")!.outside!.at;
    const tb = spec("TB").draw.steps.find((s) => s.id === "f")!.outside!.at;
    // One line of text: wider than tall, whichever way the flow runs.
    expect(lr.w).toBeGreaterThan(lr.h);
    expect(tb.w).toBeGreaterThan(tb.h);
    expect({ w: lr.w, h: lr.h }).toEqual({ w: tb.w, h: tb.h });
  });
});

describe("#48 routeThroughPorts with the unset end off the perimeter", () => {
  it("keeps the explicit toPort when the route starts inside the source box", () => {
    const from = { x: 0, y: 0, w: 124, h: 40 };
    const to = { x: 450, y: -100, w: 100, h: 40 };
    const pts = routeThroughPorts([[112, 20], [500, 20]], { from, to }, { toPort: { side: "top", at: 0.5 } });
    expect(pts).not.toBeNull();
    expect(pts![pts!.length - 1]).toEqual([500, -100]);
    // Read back as the nearest face — the right one, 12px away.
    expect(pts![0]).toEqual([124, 20]);
  });
});

describe("#49 a policy referenced at the very start of a label", () => {
  it("counts as used", () => {
    const d: StoredDiagram = {
      nodeId: "1:1",
      kind: "activity",
      title: "Hold",
      spec: {
        title: "Hold",
        nodes: [{ id: "h", label: "@hold-minutes phut" }],
        options: { policies: { "hold-minutes": 10 } },
      },
    };
    expect(collectFacts([d]).policies).toEqual([
      expect.objectContaining({ name: "hold-minutes", used: true }),
    ]);
  });
});

describe("#50 a state machine written with [*]", () => {
  it("does not report the synthetic start/end ids as lifecycle drift", () => {
    const parsed = parseStateText("[*] -> held: Reserve\nheld -> paid: Pay\npaid -> [*]");
    const erd: StoredDiagram = {
      nodeId: "1:1",
      kind: "erd",
      title: "ERD",
      spec: {
        entities: [{ id: "bookings", name: "bookings", attributes: [{ name: "status", type: "enum(held|paid)" }] }],
      },
    };
    const state: StoredDiagram = {
      nodeId: "2:2",
      kind: "state",
      title: "Booking lifecycle",
      spec: { title: "Booking lifecycle", entity: "bookings", states: parsed.states, transitions: parsed.transitions },
    };
    expect(parsed.states.map((s) => s.id)).toContain("__end");
    expect(checkConsistency([erd, state]).filter((f) => f.rule === "lifecycle-drift")).toEqual([]);
    expect(collectFacts([state]).lifecycles[0]!.states).toEqual(["held", "paid"]);
  });
});

describe("#51 activity terminals that are not terminal", () => {
  it("warns about an end with a way out and a start something points into", () => {
    const { warnings } = checkActivity(
      [{ id: "ops", label: "Ops" }],
      [
        { id: "s", label: "Go", kind: "start", lane: "ops" },
        { id: "a", label: "Work", lane: "ops" },
        { id: "e", label: "Done", kind: "end", lane: "ops" },
      ],
      [
        { from: "s", to: "a" },
        { from: "a", to: "e" },
        { from: "e", to: "a" },
        { from: "a", to: "s" },
      ],
    );
    const all = warnings.join(" ");
    expect(all).toContain('End step with a way out: "e"');
    expect(all).toContain('Arrow INTO a start step: "s"');
  });

  it("stays quiet on a clean process", () => {
    const { warnings } = checkActivity(
      [{ id: "ops", label: "Ops" }],
      [
        { id: "s", label: "Go", kind: "start", lane: "ops" },
        { id: "e", label: "Done", kind: "end", lane: "ops" },
      ],
      [{ from: "s", to: "e" }],
    );
    expect(warnings.join(" ")).not.toMatch(/End step with a way out|Arrow INTO a start step/);
  });
});

describe("#52 connector U-turns clear the boxes", () => {
  it("does not route the reported case through the target", () => {
    const from = { x: 300, y: 0, w: 100, h: 40 };
    const to = { x: 410, y: 10, w: 200, h: 300 };
    const pts = connectPorts({ box: from, port: { side: "right", at: 0.5 } }, { box: to, port: { side: "left", at: 0.0667 } });
    expect(cuts(pts, to)).toBe(false);
    expect(cuts(pts, from)).toBe(false);
  });

  // Tall and wide targets on every side of the source, every face pair: the
  // shapes that step aside by a fixed amount cut through all of these.
  const A = { x: 0, y: 0, w: 120, h: 60 };
  const targets: Placement[] = [
    { x: 150, y: -100, w: 100, h: 300 },
    { x: -130, y: -100, w: 100, h: 300 },
    { x: -100, y: 90, w: 320, h: 80 },
    { x: -100, y: -110, w: 320, h: 80 },
    { x: 140, y: 30, w: 200, h: 300 },
  ];
  for (const [ti, to] of targets.entries()) {
    it(`never cuts through either box (target ${ti})`, () => {
      const bad: string[] = [];
      for (const fs of SIDES) {
        for (const ts of SIDES) {
          for (const at of [0.1, 0.5, 0.9]) {
            const pts = connectPorts({ box: A, port: { side: fs as Side, at } }, { box: to, port: { side: ts as Side, at } });
            if (cuts(pts, A) || cuts(pts, to)) bad.push(`${fs}→${ts}@${at}`);
          }
        }
      }
      expect(bad).toEqual([]);
    });
  }
});

describe("#53 userflow gutter labels", () => {
  const node = (id: string, x: number, y: number): RouteNode => ({ id, kind: "screen", cls: "plain", x, y, w: 100, h: 40 });
  const edge = (from: string, to: string, lw: number): RouteEdge => ({
    from,
    to,
    kind: "return",
    labelLines: ["x"],
    lw,
    lh: 20,
    name: `${from}-${to}`,
    back: false,
    side: 1,
    lane: 0,
    points: [],
    labelAt: null,
    dagrePoints: null,
    dagreLabel: null,
    portOut: 0,
    portIn: 0,
  });
  const run = (nodes: RouteNode[], edges: RouteEdge[], ax: Axis) => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    markBackEdges(edges, byId, ax);
    route(nodes, edges, byId, ax);
  };

  it("stacks two wide LR gutter labels apart by their widths", () => {
    const ax = new Axis(false);
    const nodes = [node("n0", 0, 0), node("n1", 200, 0), node("n2", 400, 0), node("n3", 600, 0)];
    const edges = [edge("n3", "n0", 120), edge("n2", "n1", 120)];
    run(nodes, edges, ax);
    const [a, b] = edges.map((e) => e.labelAt!);
    // The same 6px breathing room the stacking itself asks for.
    const apartX = Math.abs(a![0] - b![0]) >= 120 + 6;
    const apartY = Math.abs(a![1] - b![1]) >= 20 + 6;
    expect(apartX || apartY).toBe(true);
  });

  it("does not let a same-rank return take a gutter lane", () => {
    const ax = new Axis(false);
    const nodes = [node("n0", 0, 0), node("n1", 300, 0), node("m", 300, -200)];
    const gutter = edge("n1", "n0", 40);
    const across = edge("n1", "m", 40);
    run(nodes, [across, gutter], ax);
    expect(gutter.lane).toBe(0);
    // Lane 0: the gutter line runs at the innermost lane, not one step out.
    const alone = edge("n1", "n0", 40);
    run(nodes, [alone], ax);
    expect(gutter.points).toEqual(alone.points);
  });
});

describe("#54 state fork/join is checked per fork", () => {
  it("reports a fork that never rejoins even when another fork has a join", () => {
    const { warnings } = checkState(
      [
        { id: "i", kind: "initial" },
        { id: "f1", kind: "fork", label: "Split A" },
        { id: "a", kind: "final" },
        { id: "b", kind: "final" },
        { id: "f2", kind: "fork", label: "Split B" },
        { id: "c" },
        { id: "d" },
        { id: "j", kind: "join" },
        { id: "z", kind: "final" },
      ],
      [
        { from: "i", to: "f1" },
        { from: "f1", to: "a" },
        { from: "f1", to: "b" },
        { from: "i", to: "f2", event: "go" },
        { from: "f2", to: "c" },
        { from: "f2", to: "d" },
        { from: "c", to: "j", event: "done" },
        { from: "d", to: "j", event: "done" },
        { from: "j", to: "z" },
      ],
    );
    const found = warnings.find((w) => w.includes("fork(s) and no join"));
    expect(found).toBeDefined();
    expect(found).toContain('"Split A"');
    expect(found).not.toContain('"Split B"');
  });
});

describe("#55/#56 activity router", () => {
  const step = (id: string, at: Placement, kind: StepPlace["kind"] = "action"): StepPlace => ({
    id,
    kind,
    cls: "plain",
    lane: "",
    at,
  });
  const edge = (from: string, to: string, extra: object = {}) => ({
    from,
    to,
    kind: "forward" as const,
    labelLines: [],
    lw: 0,
    lh: 0,
    ...extra,
  });

  it("#55 with gutter:false and no gap to cross in, crosses directly and says so", () => {
    const steps = [step("a", { x: 0, y: 0, w: 100, h: 60 }), step("b", { x: 300, y: 40, w: 100, h: 60 })];
    const res = routeActivity({ rankdir: "TB", colorByTarget: false, lanes: [], steps, edges: [edge("a", "b")], gutter: false });
    const pts = res.edges[0]!.points;
    // Nothing outside the two boxes' cross extent: no walk around the picture.
    for (const p of pts) {
      expect(p[0]).toBeGreaterThanOrEqual(0);
      expect(p[0]).toBeLessThanOrEqual(400);
    }
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain("a → b");
  });

  it("#56 a port chosen for one sibling does not shift the others on a side face", () => {
    const a = { x: 0, y: 0, w: 100, h: 60 };
    const steps = [step("a", a), step("b", { x: 300, y: 0, w: 100, h: 60 }), step("c", { x: 600, y: 0, w: 100, h: 60 })];
    const res = routeActivity({
      rankdir: "TB",
      colorByTarget: false,
      lanes: [],
      steps,
      edges: [edge("a", "b"), edge("a", "c", { fromPort: { side: "bottom", at: 0.5 } })],
    });
    const ab = res.edges.find((e) => e.id === "a->b")!;
    expect(ab.points[0]).toEqual([100, 30]);
  });
});

describe("#57 simplify", () => {
  it("keeps a turnaround on one line", () => {
    expect(simplify([[0, 0], [0, 10], [0, 5]])).toEqual([[0, 0], [0, 10], [0, 5]]);
    expect(simplify([[0, 0], [10, 0], [4, 0]])).toEqual([[0, 0], [10, 0], [4, 0]]);
  });

  it("still drops a point that lies between its neighbours", () => {
    expect(simplify([[0, 0], [0, 5], [0, 10]])).toEqual([[0, 0], [0, 10]]);
  });
});

describe("#58 a decision's self-loop touches the diamond at both ends", () => {
  const onDiamond = (p: Pt, b: Placement): boolean => {
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    return Math.abs(Math.abs(p[0] - cx) / (b.w / 2) + Math.abs(p[1] - cy) / (b.h / 2) - 1) < 0.02;
  };

  for (const vertical of [true, false]) {
    it(`userflow, ${vertical ? "TB" : "LR"}`, () => {
      const ax = new Axis(vertical);
      const d: RouteNode = { id: "d", kind: "decision", cls: "plain", x: 0, y: 0, w: 120, h: 80 };
      const e: RouteEdge = {
        from: "d",
        to: "d",
        kind: "forward",
        labelLines: [],
        lw: 0,
        lh: 0,
        name: "loop",
        back: false,
        side: 1,
        lane: 0,
        points: [],
        labelAt: null,
        dagrePoints: null,
        dagreLabel: null,
        portOut: 0,
        portIn: 0,
      };
      route([d], [e], new Map([["d", d]]), ax);
      expect(onDiamond(e.points[0]!, d)).toBe(true);
      expect(onDiamond(e.points[e.points.length - 1]!, d)).toBe(true);
    });

    it(`activity, ${vertical ? "TB" : "LR"}`, () => {
      const at = { x: 0, y: 0, w: 120, h: 80 };
      const res = routeActivity({
        rankdir: vertical ? "TB" : "LR",
        colorByTarget: false,
        lanes: [],
        steps: [{ id: "d", kind: "decision", cls: "plain", lane: "", at }],
        edges: [{ from: "d", to: "d", kind: "forward", labelLines: [], lw: 0, lh: 0 }],
      });
      const pts = res.edges[0]!.points;
      expect(onDiamond(pts[0]!, at)).toBe(true);
      expect(onDiamond(pts[pts.length - 1]!, at)).toBe(true);
    });
  }
});
