import { describe, expect, it } from "vitest";
import { buildState } from "../../src/shared/state/index.js";
import type { Placement } from "../../src/shared/diagram/types.js";

/**
 * Stacked final states: their names are drawn OUTSIDE the ring, where neither
 * dagre nor the label router could see them.
 *
 * Found drawing a real demo — one state branching to three terminal outcomes.
 * In LR every transition label landed on a caption of the ring below it; in TB
 * each caption, drawn beside its ring, ran over the next ring along. layout_audit
 * called both clean, because a caption is a loose text layer, not a box. So the
 * claim is checked here on the draw data itself: no label on a state or a
 * caption, and no caption on another state or caption.
 */

const TEXT = [
  "[*] -> pending",
  "pending -> approved: Approve",
  "pending -> rejected: Reject",
  "pending -> cancelled: Cancel",
  'approved "Approved" final',
  'rejected "Rejected" final',
  'cancelled "Cancelled" final',
].join("\n");

function hit(a: Placement, b: Placement): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

for (const rankdir of ["TB", "LR"] as const) {
  describe(`stacked final states, ${rankdir}`, () => {
    const built = buildState({ title: "Request", text: TEXT, options: { rankdir } });
    const { states, edges } = built.draw;
    const boxes = states.flatMap((s) => [
      { name: `state ${s.id}`, owner: s.id, at: s.at },
      ...(s.outside ? [{ name: `caption of ${s.id}`, owner: s.id, at: s.outside.at }] : []),
    ]);

    it("draws the three finals with their names outside the ring", () => {
      const finals = states.filter((s) => s.kind === "final");
      expect(finals).toHaveLength(3);
      for (const f of finals) expect(f.outside).toBeDefined();
      expect(edges.filter((e) => e.label)).toHaveLength(3);
    });

    it("puts no label pill on a state or on a caption", () => {
      const clashes: string[] = [];
      for (const e of edges) {
        if (!e.label) continue;
        for (const b of boxes) if (hit(e.label, b.at)) clashes.push(`"${e.label.text}" on ${b.name}`);
      }
      expect(clashes).toEqual([]);
    });

    it("puts no caption on another state or another caption", () => {
      const clashes: string[] = [];
      for (const c of boxes.filter((b) => b.name.startsWith("caption"))) {
        for (const b of boxes) {
          if (b.owner === c.owner) continue;
          if (hit(c.at, b.at)) clashes.push(`${c.name} on ${b.name}`);
        }
      }
      expect(clashes).toEqual([]);
    });
  });
}
