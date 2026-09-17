import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TOOLS } from "../../src/server/index.js";
import { DOC_SECTION_NAMES } from "../../src/server/docs-content/index.js";

/**
 * The skills in `skills/` tell an agent which tools to call, which diagram
 * kinds exist and which docs sections to read. Every one of those is a claim
 * about this codebase, and a claim that drifts is worse than no claim at all:
 * the agent follows it, the call fails, and the failure looks like the tool's
 * fault.
 *
 * So the rule the kit itself preaches applies here — a sentence that says
 * "call this" has to point at something real, and a test has to say so.
 */

const ROOT = join(import.meta.dirname, "../..");
const SKILLS = join(ROOT, ".claude/skills");

const skillDirs = existsSync(SKILLS)
  ? readdirSync(SKILLS, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  : [];

const read = (name: string): string => readFileSync(join(SKILLS, name, "SKILL.md"), "utf8");

/**
 * Skills that are NOT diagram skills. They share the connection gate and the
 * findings-are-the-deliverable rule, but they have no `figma_diagram` type, no
 * compact form and no `checkFirst` — asserting those of them would only teach
 * the next author to write a sentence that is not true.
 */
const NON_DIAGRAM = new Set(["figma-demo", "figma-design-system"]);
const diagramDirs = skillDirs.filter((d) => !NON_DIAGRAM.has(d));

/** The `type:` values `figma_diagram` actually accepts. */
const diagramTypes = ((): string[] => {
  const tool = TOOLS.find((t) => t.name === "figma_diagram")!;
  const schema = tool.inputSchema as { properties?: { type?: { enum?: string[] } } };
  return schema.properties?.type?.enum ?? [];
})();

describe("the diagram skills", () => {
  it("ships one skill per diagram kind, and no orphans", () => {
    expect(skillDirs).toEqual([
      "figma-activity",
      "figma-erd",
      "figma-sequence",
      "figma-sitemap",
      "figma-state",
      "figma-userflow",
    ]);
    // Every `figma_diagram` type has a skill named after it, and the userflow
    // tool has its own. A kind added without a skill is a kind nobody is
    // taught to use correctly.
    for (const type of diagramTypes) {
      expect(skillDirs, `no skill for type:"${type}"`).toContain(`figma-${type}`);
    }
  });

  it("names only tools that exist", () => {
    const real = new Set(TOOLS.map((t) => `mcp__reqwise-figma__${t.name}`));
    for (const dir of skillDirs) {
      const body = read(dir);
      const named = body.match(/mcp__reqwise-figma__[a-z_]+/g) ?? [];
      expect(named.length, `${dir} names no tools`).toBeGreaterThan(0);
      for (const tool of named) {
        expect(real.has(tool), `${dir} names "${tool}", which does not exist`).toBe(true);
      }
    }
  });

  it("passes a `type` that figma_diagram accepts", () => {
    for (const dir of diagramDirs) {
      if (dir === "figma-userflow") continue; // its own tool, no `type`
      const body = read(dir);
      const kind = dir.replace("figma-", "");
      expect(body, `${dir} never says which type to pass`).toContain(`type: "${kind}"`);
      expect(diagramTypes, `figma_diagram has no type "${kind}"`).toContain(kind);
    }
  });

  it("only sends the reader to docs sections that exist", () => {
    for (const dir of skillDirs) {
      for (const hit of read(dir).match(/figma_docs\(section="([a-z]+)"\)/g) ?? []) {
        const section = /"([a-z]+)"/.exec(hit)![1]!;
        expect(DOC_SECTION_NAMES, `${dir} sends the reader to docs "${section}"`).toContain(
          section as never,
        );
      }
    }
  });

  it("gives every skill the frontmatter a skill loader needs", () => {
    for (const dir of skillDirs) {
      const body = read(dir);
      expect(body.startsWith("---\n"), `${dir} has no frontmatter`).toBe(true);
      const front = body.slice(4, body.indexOf("\n---", 4));
      expect(front, dir).toContain(`name: ${dir}`);
      expect(front, `${dir} has no description`).toMatch(/\ndescription: \S/);
      expect(front, `${dir} has no allowed-tools`).toContain("allowed-tools:");
      expect(front, `${dir} is not user-invocable`).toContain("user-invocable: true");
    }
  });

  it("points every skill at the shared rules, which exist", () => {
    expect(existsSync(join(SKILLS, "reqwise-diagram-rules.md"))).toBe(true);
    for (const dir of skillDirs) {
      expect(read(dir), `${dir} does not reference the shared rules`).toContain(
        "../reqwise-diagram-rules.md",
      );
    }
  });

  it("teaches the compact form, and gets right which tool has which", () => {
    // `text` belongs to the five figma_diagram kinds; a userflow's compact
    // form is `mermaid`. A skill that offers the wrong one sends the agent
    // into an INVALID_PARAMS it cannot diagnose.
    for (const dir of diagramDirs) {
      const body = read(dir);
      expect(body, `${dir} does not teach the compact form`).toContain(
        "### Write it in the compact form",
      );
      if (dir === "figma-userflow") {
        expect(body, "the userflow skill must name mermaid").toContain("`mermaid`");
        expect(body, "figma_userflow has no `text` field to offer").toMatch(
          /does not|not its form|`text` is not/i,
        );
      } else {
        expect(body, `${dir} never names the \`text\` field`).toMatch(/`text`/);
      }
    }
  });

  it("keeps the promise that findings must be acted on", () => {
    // The one instruction that makes the difference between a drawing and a
    // piece of analysis. If it ever falls out of a skill, the skill has
    // quietly become "make a picture".
    const shared = readFileSync(join(SKILLS, "reqwise-diagram-rules.md"), "utf8");
    expect(shared).toContain("dryRun");
    expect(shared).toContain("checkFirst");
    expect(shared).toContain("layout_audit");
    expect(shared.toLowerCase()).toContain("tri-state");
    // A dry run never reaches the plugin, so the rules must not sell it as a
    // connection probe — that sentence sent agents to reopen a working plugin.
    expect(shared).toContain("A dry run is NOT a probe");
    for (const dir of diagramDirs) {
      const body = read(dir);
      // The proof-read step is now one call with the draw; the skill has to
      // teach the flag that does it, and the `audit` field it comes back with.
      expect(body, `${dir} never mentions checkFirst`).toContain("checkFirst");
      expect(body, `${dir} never mentions the audit that comes back`).toContain("`audit`");
      expect(body, `${dir} has no "what the machine does not check" section`).toMatch(
        /What the machine does NOT check/,
      );
    }
  });
});
