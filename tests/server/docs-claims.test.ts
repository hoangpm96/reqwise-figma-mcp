import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TOOLS } from "../../src/server/index.js";
import { DOC_SECTION_NAMES } from "../../src/server/docs-content/index.js";
import { READ_OPERATIONS } from "../../src/shared/protocol.js";

/**
 * The shipped markdown makes claims about this codebase, and a claim that has
 * drifted is worse than no claim: a reader calls the tool the doc names, it
 * does not exist, and the failure reads as the tool's fault.
 *
 * It drifted exactly that way once. `figma_userflow` became `figma_diagram`
 * type:"userflow", and for nine commits README.md, ARCHITECTURE.md and
 * TOOLS.md went on advertising it as a seventh tool — with anchor links to a
 * section that had been renamed out from under them. Four `figma_read`
 * operations shipped with no row in the reference table at all.
 *
 * `skills/` has had this guard since it shipped (see skills-claims.test.ts);
 * `docs/` did not, which is why `docs/` is what rotted. So the same rule the
 * kit preaches applies here: a sentence that says "call this" has to point at
 * something real, and a test has to say so.
 */

const ROOT = join(import.meta.dirname, "../..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

const TOOL_NAMES = TOOLS.map((t) => t.name).sort();
const tools = read("docs/TOOLS.md");
const readme = read("README.md");
const arch = read("ARCHITECTURE.md");

/** Tool names that once existed. Naming one as callable is the bug. */
const RETIRED = ["figma_userflow", "figma_flowchart"];

/** First column of a `| \`figma_x\` | …` table row. */
function tableRows(body: string): string[] {
  return [...body.matchAll(/^\| `(figma_[a-z_]+)` \|/gm)].map((m) => m[1]!).sort();
}

describe("the shipped docs", () => {
  it("gives every tool — and only the tools that exist — a section in TOOLS.md", () => {
    const headings = [...tools.matchAll(/^## `(figma_[a-z_]+)`$/gm)].map((m) => m[1]!).sort();
    expect(headings).toEqual(TOOL_NAMES);
  });

  it("lists every tool — and only the tools that exist — in the README and ARCHITECTURE tables", () => {
    expect(tableRows(readme)).toEqual(TOOL_NAMES);
    expect(tableRows(arch)).toEqual(TOOL_NAMES);
  });

  it("counts the diagram kinds correctly, in words", () => {
    // Both files say the number in PROSE — "eight diagram kinds", "Eight
    // kinds behind one `type`" — and prose is what rots when a kind lands.
    // Both were a kind behind within an hour of sitemap shipping, and
    // nothing failed: the tables they sit beside were still right.
    const kinds = ((): string[] => {
      const tool = TOOLS.find((t) => t.name === "figma_diagram")!;
      const schema = tool.inputSchema as { properties?: { type?: { enum?: string[] } } };
      return schema.properties?.type?.enum ?? [];
    })();
    const WORD = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
    const n = WORD[kinds.length]!;
    // The claim sites are NAMED, not pattern-matched. A regex for "<word>
    // kinds" also catches "write handlers fall into two kinds", which is
    // true and about something else — a guard that cries wolf gets deleted.
    // The cost is that a NEW sentence claiming a count is not covered until
    // somebody adds it here, which is the honest trade.
    const CLAIMS: Array<[string, string, string]> = [
      ["README.md", readme, `**${n}** diagram kinds`],
      ["ARCHITECTURE.md", arch, `${n[0]!.toUpperCase()}${n.slice(1)} kinds behind one \`type\``],
      [
        "ARCHITECTURE.md",
        arch,
        // "the other" — every kind but the userflow the paragraph describes.
        `The other ${WORD[kinds.length - 1]!} kinds share that split`,
      ],
    ];
    for (const [rel, body, claim] of CLAIMS) {
      expect(body, `${rel} no longer says "${claim}" — there are ${kinds.length} kinds now`).toContain(
        claim,
      );
    }
  });

  it("names every diagram kind where it lists them, and no kind that does not exist", () => {
    const tool = TOOLS.find((t) => t.name === "figma_diagram")!;
    const kinds = (tool.inputSchema as { properties?: { type?: { enum?: string[] } } })
      .properties?.type?.enum ?? [];
    for (const [rel, body] of [
      ["README.md", readme],
      ["ARCHITECTURE.md", arch],
      ["docs/TOOLS.md", tools],
    ] as const) {
      for (const k of kinds) {
        expect(body, `${rel} never mentions the "${k}" kind`).toContain(k);
      }
    }
  });

  it("lists exactly the figma_docs sections that exist, wherever it lists them", () => {
    // Three copies of one list, kept by hand. ARCHITECTURE.md had been
    // missing `demo` since that feature shipped, and both files were missing
    // `sitemap`; a reader following either one asks for a section that is
    // there and never learns about the ones that are.
    for (const [rel, body] of [
      ["README.md", readme],
      ["ARCHITECTURE.md", arch],
    ] as const) {
      for (const name of DOC_SECTION_NAMES) {
        expect(body, `${rel}'s figma_docs list is missing "${name}"`).toContain(`\`${name}\``);
      }
    }
  });

  it("never presents a retired tool as one to call", () => {
    for (const [rel, body] of [
      ["docs/TOOLS.md", tools],
      ["README.md", readme],
      ["ARCHITECTURE.md", arch],
      ["docs/RECIPES.md", read("docs/RECIPES.md")],
      ["docs/SETUP.md", read("docs/SETUP.md")],
      ["docs/INSTALL.md", read("docs/INSTALL.md")],
    ] as const) {
      for (const dead of RETIRED) {
        for (const line of body.split("\n")) {
          if (!line.includes(dead)) continue;
          // The one legitimate mention is a migration note that says so.
          expect(
            /\b0\.1\.0\b|was a separate tool|renamed?\b/.test(line),
            `${rel} names the retired ${dead} without saying it is retired:\n  ${line.trim()}`,
          ).toBe(true);
        }
      }
    }
  });

  it("documents every figma_read operation", () => {
    const table = tools.slice(tools.indexOf("### Read operations"), tools.indexOf("### `layout_audit(nodeId)`"));
    const missing = READ_OPERATIONS.filter((op) => !table.includes(`\`${op}\``));
    expect(missing, "read operations with no row in the reference table").toEqual([]);
  });

  it("documents every figma_docs section and every diagram type", () => {
    for (const section of DOC_SECTION_NAMES) {
      expect(tools, `figma_docs section "${section}" is not listed`).toContain(`\`${section}\``);
    }
    const schema = TOOLS.find((t) => t.name === "figma_diagram")!.inputSchema as {
      properties?: { type?: { enum?: string[] } };
    };
    for (const kind of schema.properties?.type?.enum ?? []) {
      expect(tools, `diagram type "${kind}" has no section`).toContain(`### \`type: "${kind}"\``);
    }
  });

  it("has no intra-page anchor link that points at a heading it does not have", () => {
    for (const [rel, body] of [
      ["docs/TOOLS.md", tools],
      ["README.md", readme],
      ["ARCHITECTURE.md", arch],
      ["docs/RECIPES.md", read("docs/RECIPES.md")],
    ] as const) {
      const slugs = new Set(
        [...body.matchAll(/^#{1,6} (.+)$/gm)].map((m) =>
          // GitHub's rule: lowercase, drop punctuation, then one hyphen per
          // remaining space — runs are NOT collapsed, which is why a heading
          // with an em-dash anchors with a double hyphen.
          m[1]!.trim().toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s/g, "-"),
        ),
      );
      // Only same-file links: `](#…)`, not `](./OTHER.md#…)`.
      for (const m of body.matchAll(/\]\(#([^)]+)\)/g)) {
        expect(slugs, `${rel} links to #${m[1]}, which is not a heading in it`).toContain(m[1]!);
      }
    }
  });
});
