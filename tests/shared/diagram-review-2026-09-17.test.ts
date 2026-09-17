import { describe, expect, it } from "vitest";
import { buildErd } from "../../src/shared/erd/index.js";
import { layoutSequence } from "../../src/shared/sequence/layout.js";
import { pairCalls } from "../../src/shared/sequence/pairing.js";
import type { SeqFragmentSpec, SeqMessageSpec } from "../../src/shared/sequence/types.js";
import { routeActivity } from "../../src/shared/activity/route.js";
import { buildUserflow, parseMermaid } from "../../src/shared/userflow/index.js";
import type { Pt } from "../../src/shared/diagram/geometry.js";

/**
 * Follow-ups from the review of the 2026-09-17 bug hunt. Each case failed
 * against the code before its fix.
 */

describe("erd: a relationship with one column named", () => {
  const text = (rel: string) => `a\n  id uuid pk!\nb\n  id uuid pk!\n  a_id uuid fk!\n${rel}`;
  const columnFindings = (rel: string) =>
    buildErd({ title: "t", text: text(rel) } as any).warnings.filter((w) => /column/i.test(w) && /a → b|a\.|b\./.test(w));

  it("is reported once, naming the end that lacks its column (to side missing)", () => {
    const found = columnFindings(`a.id 1-* b "has"`);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('names a.id but no column on "b"');
    expect(found[0]).toContain("Give toField");
  });

  it("is reported once, naming the end that lacks its column (from side missing)", () => {
    const found = columnFindings(`a 1-* b.a_id "has"`);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('names b.a_id but no column on "a"');
    expect(found[0]).toContain("Give fromField");
  });
});

const msg = (id: string, from: string, to: string, kind?: SeqMessageSpec["kind"]): SeqMessageSpec => ({
  id,
  from,
  to,
  label: id,
  ...(kind ? { kind } : {}),
});

describe("sequence: rows and boxes agree on a fragment's span", () => {
  const parts = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
  ];
  const messages = [msg("m1", "a", "b"), msg("m2", "a", "b"), msg("m3", "a", "b")];
  const lay = (fragments: SeqFragmentSpec[]) => layoutSequence(parts, messages, fragments, {});

  it("a fragment opening on an unknown message id reserves its band at the first message it draws", () => {
    const clean = lay([{ kind: "opt", label: "x", messages: ["m2"] }]);
    const ghost = lay([{ kind: "opt", label: "x", messages: ["ghost", "m2"] }]);
    expect(ghost.messages).toEqual(clean.messages);
    expect(ghost.fragments).toEqual(clean.fragments);
    expect(ghost.h).toBe(clean.h);
  });

  it("a fragment closing on an unknown message id reserves its band below the last message it draws", () => {
    const clean = lay([{ kind: "opt", label: "x", messages: ["m2"] }]);
    const ghost = lay([{ kind: "opt", label: "x", messages: ["m2", "ghost"] }]);
    expect(ghost.messages).toEqual(clean.messages);
    expect(ghost.fragments).toEqual(clean.fragments);
    expect(ghost.h).toBe(clean.h);
  });
});

describe("sequence: pairing reads nested fragments in either list shape", () => {
  // c0; alt { c1; opt { c2 } } else { r }. The reply in the else branch can
  // only answer c0 — c1 and c2 never happened on that path.
  const messages = [
    msg("c0", "a", "b"),
    msg("c1", "a", "b"),
    msg("c2", "a", "b"),
    msg("r", "b", "a", "return"),
  ];
  const full: SeqFragmentSpec[] = [
    { kind: "alt", label: "ok", messages: ["c1", "c2"], else: { label: "no", messages: ["r"] } },
    { kind: "opt", label: "extra", messages: ["c2"] },
  ];
  const direct: SeqFragmentSpec[] = [
    { kind: "alt", label: "ok", messages: ["c1"], else: { label: "no", messages: ["r"] } },
    { kind: "opt", label: "extra", messages: ["c2"] },
  ];
  const summary = (fragments: SeqFragmentSpec[]) => {
    const p = pairCalls(messages, fragments);
    return {
      replies: [...p.callOfReply].map(([r, c]) => [r, c.id]),
      unanswered: p.unanswered.map((c) => c.id),
      orphans: p.orphanReplies.map((o) => o.id),
    };
  };

  it("gives the same pairing when a fragment lists only its own messages", () => {
    expect(summary(full).replies).toEqual([["r", "c0"]]);
    expect(summary(direct)).toEqual(summary(full));
  });

  it("a call made in a fragment nested inside a break is not what a reply after the break answers", () => {
    // c1; break { x1; opt { c2 }; x2 }; r — the break ends the enclosing run,
    // so r answers c1. Listing only the break's own messages hid c2 from the
    // break rule and r was paired with c2.
    const ms = [msg("c1", "a", "b"), msg("x1", "a", "a"), msg("c2", "a", "b"), msg("x2", "a", "a"), msg("r", "b", "a", "return")];
    const listed: SeqFragmentSpec[] = [
      { kind: "break", label: "stop", messages: ["x1", "c2", "x2"] },
      { kind: "opt", label: "maybe", messages: ["c2"] },
    ];
    const own: SeqFragmentSpec[] = [
      { kind: "break", label: "stop", messages: ["x1", "x2"] },
      { kind: "opt", label: "maybe", messages: ["c2"] },
    ];
    expect(pairCalls(ms, listed).callOfReply.get("r")?.id).toBe("c1");
    expect(pairCalls(ms, own).callOfReply.get("r")?.id).toBe("c1");
  });
});

describe("a self-loop on a round shape touches the outline at both ends", () => {
  for (const rankdir of ["TB", "LR"] as const) {
    for (const size of [20, 26]) {
      it(`${rankdir}, ${size}px circle`, () => {
        const at = { x: 0, y: 0, w: size, h: size };
        const res = routeActivity({
          rankdir,
          colorByTarget: false,
          lanes: [],
          steps: [{ id: "s", kind: "start", cls: "plain", lane: "", at, singlePort: true }],
          edges: [{ from: "s", to: "s", kind: "forward", labelLines: [], lw: 0, lh: 0 }],
        });
        const pts = res.edges[0]!.points;
        const r = (p: Pt) => Math.hypot(p[0] - size / 2, p[1] - size / 2);
        // Within half a pixel: the router rounds its points.
        expect(Math.abs(r(pts[0]!) - size / 2)).toBeLessThan(0.5);
        expect(Math.abs(r(pts[pts.length - 1]!) - size / 2)).toBeLessThan(0.5);
        // Still two ends, not one point drawn twice.
        expect(Math.hypot(pts[0]![0] - pts[pts.length - 1]![0], pts[0]![1] - pts[pts.length - 1]![1])).toBeGreaterThan(5);
      });
    }
  }
});

describe("mermaid: `End` and the RL/BT note", () => {
  it("a bare `End` or `END` is a node; only lowercase `end` closes a subgraph", () => {
    const p = parseMermaid(`flowchart TD\n  a --> b\n  End\n  END\n  subgraph S\n  c\n  end`);
    expect(p.nodes.map((n) => n.id).sort()).toEqual(["END", "End", "a", "b", "c"]);
  });

  it("does not say RL is drawn as LR when options.rankdir decided the direction", () => {
    const told = buildUserflow({ title: "t", mermaid: `graph RL\n  a --> b`, options: { rankdir: "TB" } });
    expect(told.warnings.join(" ")).not.toMatch(/drawn as/);
    expect(told.model.options?.rankdir).toBe("TB");
    const header = buildUserflow({ title: "t", mermaid: `graph BT\n  a --> b` });
    expect(header.warnings.join(" ")).toMatch(/BT is drawn as TB/);
    expect(header.warnings.join(" ")).not.toMatch(/Reverse the arrows/);
  });
});
