import { describe, it, expect } from "vitest";
import { resolveStartPort } from "../../src/server/index.js";
import { DEFAULT_PORT, PORT_RANGE } from "../../src/shared/protocol.js";

/**
 * FIGMA_MCP_PORT was named in a leader.ts error hint ("Set FIGMA_MCP_PORT to a
 * free port") while nothing in the codebase actually read it — users following
 * that advice saw no effect. These tests pin the contract now that it works.
 */

const LAST_SCANNED = DEFAULT_PORT + PORT_RANGE - 1;

/** Collects stderr warnings instead of writing them. */
function withWarnings(env: NodeJS.ProcessEnv): { port: number; warnings: string[] } {
  const warnings: string[] = [];
  const port = resolveStartPort(env, (m) => warnings.push(m));
  return { port, warnings };
}

describe("resolveStartPort", () => {
  it("defaults to DEFAULT_PORT when unset or blank", () => {
    expect(withWarnings({}).port).toBe(DEFAULT_PORT);
    expect(withWarnings({ FIGMA_MCP_PORT: "" }).port).toBe(DEFAULT_PORT);
    expect(withWarnings({ FIGMA_MCP_PORT: "   " }).port).toBe(DEFAULT_PORT);
  });

  it("honours a valid port inside the plugin's scan range, with no warning", () => {
    const { port, warnings } = withWarnings({ FIGMA_MCP_PORT: String(DEFAULT_PORT + 3) });
    expect(port).toBe(DEFAULT_PORT + 3);
    expect(warnings).toEqual([]);
  });

  it("accepts the range boundaries without warning", () => {
    expect(withWarnings({ FIGMA_MCP_PORT: String(DEFAULT_PORT) }).warnings).toEqual([]);
    expect(withWarnings({ FIGMA_MCP_PORT: String(LAST_SCANNED) }).warnings).toEqual([]);
  });

  it("warns (but still binds) for a port the Figma plugin cannot discover", () => {
    // plugin/ui.html scans a hardcoded DEFAULT_PORT..LAST_SCANNED window, so a
    // port outside it binds fine yet never receives a plugin connection. Silent
    // success here would look exactly like "the plugin is broken".
    const { port, warnings } = withWarnings({ FIGMA_MCP_PORT: "50000" });
    expect(port).toBe(50000);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("outside the range");
    expect(warnings[0]).toContain(`${DEFAULT_PORT}-${LAST_SCANNED}`);
  });

  it("warns for a port just below the scan range", () => {
    expect(withWarnings({ FIGMA_MCP_PORT: String(DEFAULT_PORT - 1) }).warnings).toHaveLength(1);
    expect(withWarnings({ FIGMA_MCP_PORT: String(LAST_SCANNED + 1) }).warnings).toHaveLength(1);
  });

  it("rejects malformed values loudly instead of silently defaulting", () => {
    // Silently falling back would make a typo indistinguishable from success.
    for (const bad of ["abc", "38470abc", "3.5", "NaN", "-1", "0"]) {
      expect(() => withWarnings({ FIGMA_MCP_PORT: bad })).toThrow(/FIGMA_MCP_PORT/);
    }
  });

  it("rejects out-of-range and privileged ports", () => {
    expect(() => withWarnings({ FIGMA_MCP_PORT: "70000" })).toThrow(/between 1 and 65535/);
    expect(() => withWarnings({ FIGMA_MCP_PORT: "80" })).toThrow(/privileged port/);
    expect(() => withWarnings({ FIGMA_MCP_PORT: "1023" })).toThrow(/privileged port/);
    expect(withWarnings({ FIGMA_MCP_PORT: "1024" }).port).toBe(1024);
  });
});
