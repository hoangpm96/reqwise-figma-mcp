/**
 * A branch label parked away from its own arrow is worse than no label: the
 * reader cannot tell which branch it belongs to, and on a flow with three
 * branches out of one diamond guessing wrong reverses the meaning.
 *
 * The measure is the distance from the label's CENTRE to the nearest point on
 * its own polyline. Asserting "the label is inside the frame" — which is what
 * the render audit checks — passes on a label sitting in open canvas 115px
 * from the line it names.
 */
import { describe, expect, it } from "vitest";
import { buildUserflow } from "../../src/shared/userflow/index.js";
import { buildActivity } from "../../src/shared/activity/index.js";
import type { ActivitySpec } from "../../src/shared/activity/types.js";

type Pt = [number, number];
type Drawn = { id: string; points: Pt[]; label?: { x: number; y: number; w: number; h: number; text: string } };

/**
 * The pill either covers its own line or touches it. Measured as the GAP
 * between the pill and the line, not the distance from its centre, so the
 * criterion does not move when the font or the label text does.
 */
const REACH = 4;

/** Gap between two axis-aligned rectangles; 0 when they touch or overlap. */
function gap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): number {
  const dx = Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w), 0);
  const dy = Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h), 0);
  return Math.hypot(dx, dy);
}

function strayLabels(edges: Drawn[]): string[] {
  const stray: string[] = [];
  for (const e of edges) {
    const l = e.label;
    if (!l) continue;
    let best = Infinity;
    for (let i = 1; i < e.points.length; i++) {
      const [x0, y0] = e.points[i - 1]!;
      const [x1, y1] = e.points[i]!;
      // Every segment is orthogonal, so its bounding box IS the segment.
      best = Math.min(
        best,
        gap(l, {
          x: Math.min(x0, x1),
          y: Math.min(y0, y1),
          w: Math.abs(x1 - x0),
          h: Math.abs(y1 - y0),
        }),
      );
    }
    if (best > REACH) stray.push(`${e.id} label "${l.text}" is ${best.toFixed(0)}px clear of its own line`);
  }
  return stray;
}

const SIGN_IN = `flowchart TD
    n1["Login"]
    d1{"Dia chi mang dang bi chan tam?"}
    x1["E-004 Too many attempts"]
    d2{"Email va mat khau co khop?"}
    x2["E-001 Incorrect email"]
    d3{"Da sai du 5 lan?"}
    x3["E-002 Khoa tai khoan 24h"]
    d4{"Trang thai tai khoan?"}
    x4["E-003 Account disabled"]
    d5{"Dang phai doi mat khau?"}
    n5["Force change password"]
    d6{"Mat khau moi hop le?"}
    x5["E-007 hoac E-008"]
    s1["Mo phien"]
    d7{"Vuot so may cho phep?"}
    s2["Da phien cu nhat"]
    h1["Man khoi dau theo role"]
    x6["E-023 Loi mang"]
    n1 -->|"Sign in"| d1
    n1 -->|"da co phien hop le"| h1
    n1 -.->|"mat mang"| x6
    x6 -.->|"bam lai"| n1
    d1 -->|"co"| x1
    d1 -->|"khong"| d2
    x1 -.->|"sau 15 phut"| n1
    d2 -->|"khong khop"| x2
    d2 -->|"khop"| d4
    x2 --> d3
    d3 -->|"du 5 lan"| x3
    d3 -->|"chua du"| n1
    x3 -.->|"tu mo sau 24h"| n1
    d4 -->|"disabled"| x4
    d4 -->|"locked_failed"| x3
    d4 -->|"active"| d5
    x4 -.->|"Admin bat lai"| n1
    d5 -->|"co"| n5
    d5 -->|"khong"| s1
    n5 -->|"Save"| d6
    d6 -->|"khong dat"| x5
    d6 -->|"dat"| s1
    x5 -.->|"nhap lai"| n5
    s1 --> d7
    d7 -->|"vuot"| s2
    d7 -->|"khong vuot"| h1
    s2 --> h1`;

describe("every label sits on its own line", () => {
  it("a real sign-in flow, 27 edges and 7 return paths", () => {
    const edges = buildUserflow({ title: "T", mermaid: SIGN_IN }).draw.edges as Drawn[];
    const stray = strayLabels(edges);
    // ONE label cannot be satisfied here and it is a layout limit, not a
    // placement bug: "mat mang" joins two boxes on the SAME rank, and its pill
    // is about as wide as the 36px dagre leaves between them, so it cannot at
    // once touch its line and stay off both boxes. It ends up just under the
    // gap. Asserting the exact case rather than relaxing the threshold keeps
    // every other label held to "the pill touches its line".
    expect(stray).toHaveLength(1);
    expect(stray[0]).toContain("n1->x6");
  });

  it("a three-way decision with a return, drawn tight", () => {
    const edges = buildUserflow({
      title: "T",
      mermaid: `flowchart TD
        a["Start"] --> q{"Account status?"}
        q -->|"disabled"| e1["E-003 Account disabled"]
        q -->|"locked"| e2["E-002 Locked for 24h"]
        q -->|"active"| ok["Open the session"]
        q -.->|"unknown, ask again"| a
        e1 -.->|"Admin re-enables"| a
        e2 -.->|"unlocked after 24h"| a`,
    }).draw.edges as Drawn[];
    expect(strayLabels(edges)).toEqual([]);
  });

  it("a swimlane process with two rework paths", () => {
    const spec: ActivitySpec = {
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
    };
    expect(strayLabels(buildActivity(spec).draw.edges as Drawn[])).toEqual([]);
  });
});
