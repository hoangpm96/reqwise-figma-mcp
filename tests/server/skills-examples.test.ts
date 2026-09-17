import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildActivity } from "../../src/shared/activity/index.js";
import { buildErd } from "../../src/shared/erd/index.js";
import { buildSequence } from "../../src/shared/sequence/index.js";
import { buildSitemap } from "../../src/shared/sitemap/index.js";
import { buildState } from "../../src/shared/state/index.js";
import { buildUserflow } from "../../src/shared/userflow/index.js";

/**
 * The compact-form example in each skill is the thing an agent copies and
 * adapts, so it has to PARSE — and it has to parse into the diagram the prose
 * around it claims. A worked example that has drifted from the parser is worse
 * than none: it teaches a syntax the tool rejects, and the failure reads as
 * the tool's fault.
 *
 * So the examples are executable here, not decorative.
 */

const SKILLS = join(import.meta.dirname, "../../.claude/skills");

/** The first fenced block under "Write it in the compact form". */
function example(skill: string): string {
  const body = readFileSync(join(SKILLS, skill, "SKILL.md"), "utf8");
  const at = body.indexOf("### Write it in the compact form");
  expect(at, `${skill} has no compact-form section`).toBeGreaterThan(-1);
  const open = body.indexOf("\n```", at);
  const start = body.indexOf("\n", open + 1) + 1;
  const end = body.indexOf("\n```", start);
  expect(end, `${skill}'s example block is not closed`).toBeGreaterThan(start);
  return body.slice(start, end);
}

/** Lines the parser could not place — the parsers report these, never throw. */
const unreadable = (warnings: string[]): string[] =>
  warnings.filter((w) => /line|unrecognised|unknown line|could not/i.test(w));

describe("the compact-form example in each skill", () => {
  it("parses, for every kind that takes `text`", () => {
    const built = {
      "figma-activity": (text: string) => buildActivity({ title: "T", text }),
      "figma-erd": (text: string) => buildErd({ title: "T", text }),
      "figma-sequence": (text: string) => buildSequence({ title: "T", text }),
      "figma-state": (text: string) => buildState({ title: "T", text }),
      "figma-sitemap": (text: string) => buildSitemap({ title: "T", text }),
    };
    for (const [skill, build] of Object.entries(built)) {
      const src = example(skill);
      const result = build(src);
      expect(unreadable(result.warnings), `${skill}: the parser could not read a line`).toEqual([]);
      // It has to be a real diagram, not two lines that happen to parse.
      const drawn = Object.values(result.stats).filter((v) => typeof v === "number");
      expect(Math.max(...drawn), `${skill}: the example draws almost nothing`).toBeGreaterThan(3);
    }
  });

  it("uses mermaid for the userflow, because `text` is not its form", () => {
    const src = example("figma-userflow");
    expect(src, "the userflow example is not a flowchart").toContain("flowchart");
    const built = buildUserflow({ title: "T", mermaid: src });
    expect(unreadable(built.warnings)).toEqual([]);
    expect(built.stats.nodes).toBeGreaterThan(3);
    expect(built.stats.edges).toBeGreaterThan(3);
  });

  it("shows a clean model, so the reader is not copying a warning", () => {
    // The example is what gets adapted. If it demonstrates a diagram the
    // checker complains about, every copy of it inherits the complaint.
    for (const [skill, build] of [
      ["figma-state", (t: string) => buildState({ title: "T", text: t })],
      ["figma-erd", (t: string) => buildErd({ title: "T", text: t })],
      ["figma-activity", (t: string) => buildActivity({ title: "T", text: t })],
      ["figma-sequence", (t: string) => buildSequence({ title: "T", text: t })],
      ["figma-sitemap", (t: string) => buildSitemap({ title: "T", text: t })],
    ] as const) {
      const result = build(example(skill));
      expect(result.warnings, `${skill}'s example is not a clean model`).toEqual([]);
    }
  });
});
