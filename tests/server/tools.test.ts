import { describe, it, expect } from "vitest";
import { handleRules, type ToolContext, type Diagnostics } from "../../src/server/tools.js";
import { SessionRegistry } from "../../src/server/session.js";

function ctxWith(
  impl: (op: string) => unknown,
): ToolContext {
  return {
    runValidated: async (op) => impl(op),
    runWrite: async () => ({}),
    sessions: new SessionRegistry(),
    diagnostics: async () => ({}) as Diagnostics,
  };
}

describe("figma_rules empty-design-system guidance", () => {
  it("tells the agent to propose a palette + setupTokens when the file has no styles/variables/components", async () => {
    const ctx = ctxWith((op) => {
      if (op === "get_styles") return { paint: [], text: [], effect: [], grid: [] };
      if (op === "get_variables") return { collections: [] };
      return { components: [] };
    });
    const md = await handleRules(ctx);
    expect(md).toContain("No design system in this file");
    expect(md).toContain("PROPOSE a small palette to the user");
    expect(md).toContain("setupTokens");
    expect(md).toContain("design.md");
  });

  it("does NOT nag when the file has a design system to reuse", async () => {
    const ctx = ctxWith((op) => {
      if (op === "get_styles") return { paint: [{ name: "Brand/Primary" }], text: [], effect: [] };
      if (op === "get_variables")
        return { collections: [{ name: "colors", modes: [{ name: "light" }], variables: [{ name: "primary" }] }] };
      return { components: [{ name: "Button" }] };
    });
    const md = await handleRules(ctx);
    expect(md).not.toContain("No design system in this file");
    expect(md).toContain("Brand/Primary");
  });

  it("prints each variable's default-mode value so the agent needn't re-fetch get_variables", async () => {
    const ctx = ctxWith((op) => {
      if (op === "get_styles") return { paint: [], text: [], effect: [] };
      if (op === "get_variables")
        return {
          collections: [
            {
              name: "colors",
              modes: [{ name: "light" }, { name: "dark" }],
              variables: [
                { name: "primary", type: "COLOR", values: { light: "#2563EB", dark: "#3B82F6" } },
                { name: "radius", type: "FLOAT", values: { light: 8 } },
              ],
            },
          ],
        };
      return { components: [] };
    });
    const md = await handleRules(ctx);
    // Default (first) mode value is inlined next to the token name.
    expect(md).toContain("primary: #2563EB");
    expect(md).toContain("radius: 8");
    // Not the non-default mode.
    expect(md).not.toContain("#3B82F6");
  });
});
