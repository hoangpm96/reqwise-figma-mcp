/**
 * Two lines running together is a drawing defect, not a routing detail: the
 * reader cannot tell which branch goes where, and one arrow hides the other.
 * A diamond is where it happens, because it has ONE tip per side and every
 * edge the router sends out of the same face leaves from that one point.
 *
 * The measure here is the only one that can catch it: the LENGTH of the run
 * two different edges share on the same axis. Asserting "the exits differ"
 * would pass on two lines that leave 1px apart and then converge.
 */
import { describe, expect, it } from "vitest";
import { buildUserflow } from "../../src/shared/userflow/index.js";
import { buildActivity } from "../../src/shared/activity/index.js";
import type { ActivitySpec } from "../../src/shared/activity/types.js";

type Pt = [number, number];

/** The longest run any two different edges share, per pair. */
function sharedRuns(edges: Array<{ id: string; points: Pt[] }>, tolerance = 4): string[] {
  const EPS = 1.5;
  const segs: Array<{ a: Pt; b: Pt; id: string }> = [];
  for (const e of edges) {
    for (let i = 0; i + 1 < e.points.length; i++) {
      segs.push({ a: e.points[i]!, b: e.points[i + 1]!, id: e.id });
    }
  }
  const span = (lo: number, hi: number, lo2: number, hi2: number): number =>
    Math.min(hi, hi2) - Math.max(lo, lo2);
  const hits: string[] = [];
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const p = segs[i]!;
      const q = segs[j]!;
      if (p.id === q.id) continue;
      const vertical = Math.abs(p.a[0] - p.b[0]) < EPS && Math.abs(q.a[0] - q.b[0]) < EPS;
      const horizontal = Math.abs(p.a[1] - p.b[1]) < EPS && Math.abs(q.a[1] - q.b[1]) < EPS;
      let run = -1;
      if (vertical && Math.abs(p.a[0] - q.a[0]) < EPS) {
        run = span(
          Math.min(p.a[1], p.b[1]),
          Math.max(p.a[1], p.b[1]),
          Math.min(q.a[1], q.b[1]),
          Math.max(q.a[1], q.b[1]),
        );
      } else if (horizontal && Math.abs(p.a[1] - q.a[1]) < EPS) {
        run = span(
          Math.min(p.a[0], p.b[0]),
          Math.max(p.a[0], p.b[0]),
          Math.min(q.a[0], q.b[0]),
          Math.max(q.a[0], q.b[0]),
        );
      }
      if (run > tolerance) {
        hits.push(`${p.id} and ${q.id} run together for ${run.toFixed(1)}px`);
      }
    }
  }
  return hits;
}

const build = (mermaid: string): Array<{ id: string; points: Pt[] }> =>
  buildUserflow({ title: "T", mermaid }).draw.edges as Array<{ id: string; points: Pt[] }>;

describe("no two lines run together", () => {
  const cases: Record<string, string> = {
    "two branches to opposite sides": `flowchart TD
      a["Start"] --> q{"Ok?"}
      q -->|"yes"| ok["Done"]
      q -->|"no"| err["Error"]`,
    "three branches": `flowchart TD
      a["Start"] --> q{"State?"}
      q -->|"one"| n1["One"]
      q -->|"two"| n2["Two"]
      q -->|"three"| n3["Three"]`,
    // Only three tips exist, so the fourth branch has to be offset along the
    // diamond's edge instead of stacking on a tip.
    "four branches": `flowchart TD
      a["Start"] --> q{"State?"}
      q -->|"one"| n1["One"]
      q -->|"two"| n2["Two"]
      q -->|"three"| n3["Three"]
      q -->|"four"| n4["Four"]`,
    // A return path leaves the same face as the branch that carries on, which
    // is how the defect shows on nearly every real flow.
    "a branch and a return": `flowchart TD
      a["Start"] --> q{"Ok?"}
      q -->|"yes"| ok["Done"]
      q -.->|"retry"| a`,
    "two branches and a return": `flowchart TD
      a["Start"] --> q{"Ok?"}
      q -->|"yes"| ok["Done"]
      q -->|"no"| err["Error"]
      q -.->|"retry"| a`,
    "two returns from one decision": `flowchart TD
      a["Start"] --> b["Second"]
      b --> q{"Ok?"}
      q -->|"yes"| ok["Done"]
      q -.->|"retry a"| a
      q -.->|"retry b"| b`,
    // Arrivals share a tip the same way departures do.
    "two edges arriving at one decision": `flowchart TD
      a["Start"] --> q{"Ok?"}
      b["Other"] --> q
      a --> b
      q -->|"yes"| ok["Done"]
      q -->|"no"| err["Error"]`,
    "three edges arriving at one decision": `flowchart TD
      a["Start"] --> q{"Ok?"}
      b["Other"] --> q
      c["Third"] --> q
      a --> b
      b --> c
      q -->|"yes"| ok["Done"]`,
    "neighbours on the decision's own rank": `flowchart TD
      a["Start"] --> q{"Ok?"}
      q --> l["Left"]
      q --> r["Right"]
      l --> r
      q -->|"yes"| ok["Done"]`,
  };

  for (const [name, mermaid] of Object.entries(cases)) {
    it(name, () => {
      expect(sharedRuns(build(mermaid))).toEqual([]);
    });
  }

  // The flow that found the defect: a sign-in with five decisions, three of
  // which carry both a branch onwards and a return path.
  it("a real sign-in flow", () => {
    const edges = build(`flowchart TD
      n1["Login"]
      d1{"Is this network address temporarily blocked?"}
      x1["E-004 Too many attempts from this device"]
      d2{"Do the email and password match?"}
      x2["E-001 Incorrect email or password"]
      d3{"Five failures already?"}
      x3["E-002 Locked for 24h"]
      d4{"Account status?"}
      x4["E-003 Account disabled"]
      d5{"Password change due?"}
      n5["Force change password"]
      s1["Open the session"]
      h1["Landing screen for the role"]

      n1 -->|"Sign in"| d1
      d1 -->|"yes"| x1
      d1 -->|"no"| d2
      x1 -.->|"after 15 minutes"| n1
      d2 -->|"no"| x2
      d2 -->|"yes"| d4
      x2 --> d3
      d3 -->|"yes"| x3
      d3 -->|"no"| n1
      x3 -.->|"unlocked after 24h"| n1
      d4 -->|"disabled"| x4
      d4 -->|"locked_failed"| x3
      d4 -->|"active"| d5
      x4 -.->|"Admin re-enables"| n1
      d5 -->|"yes"| n5
      d5 -->|"no"| s1
      n5 -->|"Save"| s1
      s1 --> h1`);
    expect(sharedRuns(edges)).toEqual([]);
  });
});

/**
 * The swimlane router is a second implementation of the same idea, and it had
 * the same hole: its `spreadDecisions` also skips return paths and anything
 * heading back up the ranks, so those kept the tip ahead.
 */
describe("no two lines run together — swimlanes", () => {
  const activity = (spec: ActivitySpec): Array<{ id: string; points: Pt[] }> =>
    buildActivity(spec).draw.edges as Array<{ id: string; points: Pt[] }>;

  it("a branch and a return out of one decision", () => {
    expect(
      sharedRuns(
        activity({
          title: "T",
          nodes: [
            { id: "s", label: "Start", kind: "start" },
            { id: "a", label: "Enter details" },
            { id: "q", label: "Valid?", kind: "decision" },
            { id: "ok", label: "Save", cls: "happy" },
            { id: "e", label: "Error", cls: "error" },
            { id: "q2", label: "Retry left?", kind: "decision" },
            { id: "done", label: "Done", kind: "end" },
          ],
          edges: [
            { from: "s", to: "a" },
            { from: "a", to: "q" },
            { from: "q", to: "ok", label: "yes" },
            { from: "q", to: "e", label: "no" },
            { from: "e", to: "q2" },
            { from: "q2", to: "a", label: "yes", kind: "return" },
            { from: "q2", to: "done", label: "no" },
            { from: "ok", to: "done" },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("a rework path across three lanes", () => {
    expect(
      sharedRuns(
        activity({
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
            { from: "ok", to: "draft", label: "needs rework", kind: "return" },
            { from: "pay", to: "done" },
            { from: "reject", to: "draft", label: "rework", kind: "return" },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("two edges arriving at one decision", () => {
    expect(
      sharedRuns(
        activity({
          title: "T",
          nodes: [
            { id: "s", label: "Start", kind: "start" },
            { id: "a", label: "First" },
            { id: "b", label: "Second" },
            { id: "q", label: "Ready?", kind: "decision" },
            { id: "ok", label: "Ship", cls: "happy" },
            { id: "no", label: "Hold", cls: "error" },
          ],
          edges: [
            { from: "s", to: "a" },
            { from: "a", to: "b" },
            { from: "a", to: "q" },
            { from: "b", to: "q" },
            { from: "q", to: "ok", label: "yes" },
            { from: "q", to: "no", label: "no" },
          ],
        }),
      ),
    ).toEqual([]);
  });
});
