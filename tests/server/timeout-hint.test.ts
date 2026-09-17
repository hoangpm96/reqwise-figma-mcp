import { describe, expect, it } from "vitest";
import { WRITE_OPERATIONS } from "../../src/shared/protocol.js";

/**
 * A timeout does NOT cancel the plugin. It keeps working and usually finishes,
 * so a draw that "timed out" is often already on the canvas — twice in one
 * session of testing, it was. An agent told only "timed out" retries, and the
 * retry draws a second copy of a diagram that was already there.
 *
 * The hint has to say that, and it has to say it only for operations that
 * change the document: on a read, a timeout really is just a missing answer.
 */
describe("what a timed-out operation tells the caller", () => {
  it("warns that a write may have landed, and says what to do instead of retrying", async () => {
    const mod = await import("../../src/server/bridge.js");
    const Bridge = (mod as Record<string, unknown>).Bridge as
      | (new (...args: never[]) => unknown)
      | undefined;
    expect(Bridge, "Bridge is exported").toBeTruthy();

    // The hint text lives in the source; assert on it there rather than
    // standing up a websocket server to provoke a real timeout.
    const src = (await import("node:fs")).readFileSync("src/server/bridge.ts", "utf8");
    const hint = src.slice(src.indexOf("mutates(op)"), src.indexOf("The Figma plugin did not respond in time"));
    expect(hint).toContain("NOT cancelled");
    expect(hint).toContain("Do NOT simply retry");
    expect(hint).toContain("get_page_model");
    expect(hint).toContain("update");
  });

  it("treats every write operation as one that may have landed", async () => {
    const src = (await import("node:fs")).readFileSync("src/server/bridge.ts", "utf8");
    // Driven off WRITE_OPERATIONS, so a new write op is covered the day it is
    // added rather than the day somebody remembers this file.
    expect(src).toContain("new Set<string>(WRITE_OPERATIONS as readonly string[])");
    for (const op of ["create_sequence", "create_userflow", "delete", "modify"]) {
      expect(WRITE_OPERATIONS as readonly string[]).toContain(op);
    }
  });
});
