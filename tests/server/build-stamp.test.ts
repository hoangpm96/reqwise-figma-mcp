import { describe, expect, it } from "vitest";
import {
  handleStatus,
  staleBundleHints,
  type ChannelDiagnostics,
  type Diagnostics,
  type ToolContext,
} from "../../src/server/tools.js";
import { SessionRegistry } from "../../src/server/session.js";
import { BUILD } from "../../src/server/version.js";

/**
 * The question that has cost this project more hours than any bug in it:
 * "I rebuilt and nothing changed — which half is stale?"
 *
 * Three causes look identical from the outside. The server process holds the
 * dist it loaded at startup. Figma holds the bundle the plugin was launched
 * with. Or the change genuinely did nothing. People then reload the wrong
 * half — and a reconnect ROTATES THE CHANNEL ID, which looks exactly like the
 * plugin restarting, so the wrong half feels confirmed.
 *
 * Both bundles now carry the same stamp from one build run, so the answer is
 * a comparison rather than a deduction.
 */
const ctx = (channels: Array<{ file: string; build?: string }>): ToolContext =>
  ({
    sessions: new SessionRegistry(),
    diagnostics: async (): Promise<Diagnostics> => ({
      pluginConnected: true,
      statusSource: "local",
      mode: "leader",
      port: 38470,
      bridgeAuth: "ok",
      lastHeartbeatMs: 10,
      queueLength: 0,
      pendingCount: 0,
      channels: channels.map((c, i) => ({
        channel: `ch-${i}`,
        plugin: {
          version: "0.2.0",
          ...(c.build ? { build: c.build } : {}),
          protocolVersion: 4,
          fileKey: null,
          fileName: c.file,
          pageName: "Page 1",
          editorType: "figma",
          connectedAt: Date.now(),
        },
        queueLength: 0,
        pendingCount: 0,
        lastHeartbeatMs: 10,
      })),
    }),
  }) as unknown as ToolContext;

describe("which half is stale", () => {
  const channel = (file: string, build?: string): ChannelDiagnostics =>
    ({
      channel: "ch",
      plugin: { version: "0.2.0", ...(build ? { build } : {}), protocolVersion: 4, fileKey: null, fileName: file, pageName: "P", editorType: "figma", connectedAt: 0 },
      queueLength: 0,
      pendingCount: 0,
      lastHeartbeatMs: 1,
    }) as ChannelDiagnostics;

  it("says so when the plugin is running an older bundle than the server", () => {
    const hint = staleBundleHints([channel("AI4BA", "2026-09-13T11:35")], "2026-09-13T12:40").join("\n");
    expect(hint).toContain("AI4BA");
    expect(hint).toContain("Plugins → Development");
    // And it names the thing that makes this confusing in the first place.
    expect(hint).toContain("rotates the channel id");
  });

  it("blames the SERVER when the server is the older half", async () => {
    // The direction that used to be reported backwards. Re-running the plugin
    // is a no-op when the plugin is already the new half, and the hint saying
    // so is the difference between one restart and a confused half hour — it
    // cost exactly that before anyone compared the two timestamps by hand.
    const hint = staleBundleHints([channel("Klopop official", "2026-09-18T11:15")], "2026-09-18T11:07").join("\n");
    expect(hint).toMatch(/SERVER is the stale half/i);
    expect(hint).toContain("2026-09-18T11:07");
    expect(hint).toContain("2026-09-18T11:15");
    // It must NOT send the reader to reload the plugin in this direction.
    expect(hint).not.toContain("Plugins → Development");
    expect(hint).toMatch(/change nothing/i);
    // And it names the follower trap: a fresh follower still forwards to
    // whatever old leader holds the port.
    expect(hint).toMatch(/follower/i);
  });

  it("stays quiet when the two halves agree", () => {
    expect(staleBundleHints([channel("AI4BA", "2026-09-13T12:40")], "2026-09-13T12:40")).toEqual([]);
  });

  it("stays quiet for a plugin too old to report a stamp", () => {
    // An absent stamp is not evidence of anything, and a hint that fires on
    // "unknown" is a hint people learn to scroll past.
    expect(staleBundleHints([channel("AI4BA")], "2026-09-13T12:40")).toEqual([]);
  });

  it("stays quiet when the SERVER is the one running unbundled", () => {
    // vitest and tsx have no build of their own to compare against.
    expect(staleBundleHints([channel("AI4BA", "2026-09-13T11:35")], "dev")).toEqual([]);
  });

  it("reports both stamps, so a person can compare them without a hint", async () => {
    const s = await handleStatus(ctx([{ file: "AI4BA", build: "2026-09-13T11:35" }]));
    expect(s.serverBuild).toBe(BUILD);
    expect((s.channels as Array<Record<string, unknown>>)[0]!.pluginBuild).toBe("2026-09-13T11:35");
  });

  it("the iframe hello actually forwards the stamp the main thread already has", async () => {
    // sendHello reconstructs the payload field-by-field. Dropping pluginBuild
    // here made every reload look like a plugin older than the stamp itself.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const ui = readFileSync(join(import.meta.dirname, "../../plugin/ui.html"), "utf8");
    const send = ui.match(/function sendHello\(\)[\s\S]*?^\s{2}\}/m);
    expect(send?.[0]).toMatch(/pluginBuild:\s*h\.pluginBuild/);
  });
});
