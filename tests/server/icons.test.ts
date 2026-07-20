import { describe, it, expect, beforeEach } from "vitest";
import { rm } from "node:fs/promises";
import { resolveAlias, searchIcons, loadIconSvg, type Fetcher } from "../../src/server/icons.js";
import { cacheDir } from "../../src/server/paths.js";

// The icon cache persists on disk under $TMPDIR — clear it so fetch behavior
// is deterministic regardless of prior runs.
beforeEach(async () => {
  await rm(cacheDir(), { recursive: true, force: true });
});

describe("icon alias resolution", () => {
  it("resolves common cross-library synonyms", () => {
    expect(resolveAlias("visibility")).toBe("eye");
    expect(resolveAlias("delete")).toBe("trash");
    expect(resolveAlias("done")).toBe("check");
    expect(resolveAlias("checkmark")).toBe("check");
    expect(resolveAlias("close")).toBe("x");
    expect(resolveAlias("settings")).toBe("settings");
    expect(resolveAlias("logout")).toBe("log-out");
  });

  it("normalizes whitespace/case and passes through unknown names", () => {
    expect(resolveAlias("  Visibility  ")).toBe("eye");
    expect(resolveAlias("Arrow Left")).toBe("arrow-left");
    expect(resolveAlias("totally-custom-icon")).toBe("totally-custom-icon");
  });

  it("searchIcons returns candidate canonical names without fetching", () => {
    const results = searchIcons("visibility");
    expect(results[0]?.name).toBe("eye");
    expect(results[0]?.alias).toBe("visibility");
    expect(results.every((r) => r.libraries.length > 0)).toBe(true);
  });
});

describe("loadIconSvg (injected fetcher, no network)", () => {
  it("resolves alias, fetches the SVG server-side, and returns it", async () => {
    let fetchedUrl = "";
    const fetcher: Fetcher = async (url) => {
      fetchedUrl = url;
      return { ok: true, status: 200, text: async () => "<svg data-icon='eye'></svg>" };
    };
    const out = await loadIconSvg("visibility", { library: "lucide", fetcher });
    expect(out.canonical).toBe("eye");
    expect(out.library).toBe("lucide");
    expect(out.svg).toContain("data-icon='eye'");
    expect(fetchedUrl).toContain("/eye.svg");
  });

  it("throws NODE_NOT_FOUND with a helpful hint on a 404", async () => {
    const fetcher: Fetcher = async () => ({ ok: false, status: 404, text: async () => "" });
    await expect(loadIconSvg("no-such-icon-xyz", { library: "lucide", fetcher })).rejects.toMatchObject({
      code: "NODE_NOT_FOUND",
    });
  });

  it("serves a repeated load from disk cache without re-fetching", async () => {
    let calls = 0;
    const fetcher: Fetcher = async () => {
      calls++;
      return { ok: true, status: 200, text: async () => `<svg id='trash-${calls}'></svg>` };
    };
    const name = "delete"; // → canonical "trash"
    const first = await loadIconSvg(name, { library: "tabler", fetcher });
    const second = await loadIconSvg(name, { library: "tabler", fetcher });
    expect(first.canonical).toBe("trash");
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.svg).toBe(first.svg);
    expect(calls).toBe(1); // only the initial miss hit the network
  });
});
