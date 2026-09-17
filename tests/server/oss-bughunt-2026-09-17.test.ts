import { describe, expect, it, vi } from "vitest";
import { applyPatch } from "../../src/server/patch.js";
import { handleDiagram, type ToolContext } from "../../src/server/tools.js";
import { loadIconSvg } from "../../src/server/icons.js";
import { validateOperation } from "../../src/server/validate.js";
import { parseErdText } from "../../src/shared/erd/index.js";
import { parseSequenceText } from "../../src/shared/sequence/index.js";
import { parseSitemapText } from "../../src/shared/sitemap/text.js";

/**
 * Silent-wrong answers a bug hunt on the open-source export found. Each one
 * returned ok (or a plausible model) while doing something other than what
 * was asked.
 */

describe("patch: a dotted key ending on a list index", () => {
  const s = { title: "T", attributes: ["a", "b", "c"] };

  it("null removes the member instead of leaving a hole that reads as null", () => {
    const { spec } = applyPatch(s, [{ set: { "attributes.1": null } }]);
    expect(spec.attributes).toEqual(["a", "c"]);
    expect(JSON.stringify(spec.attributes)).not.toContain("null");
  });

  it("refuses an index past the end instead of padding the list with holes", () => {
    expect(() => applyPatch(s, [{ set: { "attributes.9": "x" } }])).toThrow(/no index 9/);
  });

  it("several removals in one set all mean the list as it was", () => {
    const four = { title: "T", attributes: ["a", "b", "c", "d"] };
    expect(applyPatch(four, [{ set: { "attributes.1": null, "attributes.2": null } }]).spec.attributes).toEqual(["a", "d"]);
    expect(applyPatch(four, [{ set: { "attributes.1": null, "attributes.3": null } }]).spec.attributes).toEqual(["a", "c"]);
  });

  it("a removal and an edit in one set touch the members they name", () => {
    const s2 = { title: "T", attributes: [{ name: "x" }, { name: "y" }] };
    const { spec } = applyPatch(s2, [{ set: { "attributes.0": null, "attributes.1.type": "int" } }]);
    expect(spec.attributes).toEqual([{ name: "y", type: "int" }]);
  });

  it("still replaces an existing member", () => {
    expect(applyPatch(s, [{ set: { "attributes.0": "z" } }]).spec.attributes).toEqual(["z", "b", "c"]);
  });
});

describe("patch: options beside the patch apply to that draw", () => {
  const MODEL = {
    title: "Pay",
    participants: [{ id: "a", name: "App" }, { id: "b", name: "API" }],
    messages: [{ id: "m1", from: "a", to: "b", label: "POST /pay" }],
  };

  it("verify:false skips the audit instead of being dropped", async () => {
    const ops: string[] = [];
    const ctx = {
      runValidated: vi.fn(async (op: string) => {
        ops.push(op);
        if (op === "get_diagram_spec") return { kind: "sequence", spec: MODEL };
        if (op === "layout_audit") return { nodeCount: 1, summary: { issues: [], styleHints: [] } };
        return { frameId: "1:2" };
      }),
    } as unknown as ToolContext;
    await handleDiagram(ctx, undefined, {
      update: "1:2",
      patch: [{ collection: "messages", id: "m1", set: { label: "x" } }],
      options: { verify: false },
    });
    expect(ops).not.toContain("layout_audit");
  });
});

describe("erd text: a key-only column", () => {
  it("`id pk!` is a primary key, not a column of type pk", () => {
    const { entities } = parseErdText("users\n  id pk!\n  email text");
    const id = entities[0]!.attributes!.find((a) => a.name === "id")!;
    expect(id.key).toBe("pk");
    expect(id.type).toBeUndefined();
    expect(id.required).toBe(true);
  });
});

describe("sequence text: a participant whose name starts with note", () => {
  it("keeps the message instead of folding it into a note", () => {
    const p = parseSequenceText(`participant notifier "Notifier"\nparticipant api "API"\napi ->> notifier: send\nnotifier ->> api: ping`);
    expect(p.messages.map((m) => m.label)).toEqual(["send", "ping"]);
    expect(p.messages[0]!.note).toBeUndefined();
  });

  it("`note: …` still annotates the message above", () => {
    const p = parseSequenceText(`participant a "A"\nparticipant b "B"\na ->> b: hi\nnote: first contact`);
    expect(p.messages[0]!.note).toBe("first contact");
  });
});

describe("sitemap text: screen: inside prose", () => {
  it("a detail mentioning screen: claims no artboard and keeps its words", () => {
    const { pages } = parseSitemapText(`app "App"\n  intro "Intro" / See screen:admin docs`);
    const intro = pages.find((p) => p.id === "intro")!;
    expect(intro.screenId).toBeUndefined();
    expect(intro.detail).toBe("See screen:admin docs");
  });

  it("a quoted label mentioning screen: is left whole", () => {
    const { pages } = parseSitemapText(`app "App"\n  intro "Open screen:admin"`);
    const intro = pages.find((p) => p.id === "intro")!;
    expect(intro.label).toBe("Open screen:admin");
    expect(intro.screenId).toBeUndefined();
  });

  it("screen: among the words still works, before a detail", () => {
    const { pages } = parseSitemapText(`app "App"\n  detail "Chi tiết" screen:a,b / only owners`);
    const d = pages.find((p) => p.id === "detail")!;
    expect(d.screenId).toEqual(["a", "b"]);
    expect(d.detail).toBe("only owners");
  });
});

describe("load_icon contract", () => {
  it("the schema requires what the plugin draws — svg — and not name", () => {
    expect(() => validateOperation("load_icon", { svg: "<svg/>" })).not.toThrow();
    expect(() => validateOperation("load_icon", { name: "home" })).toThrow();
  });

  it("an unknown library is INVALID_PARAMS, not a bare TypeError", async () => {
    await expect(
      loadIconSvg("home", { library: "nope" as any, fetcher: async () => ({ ok: true, status: 200, text: async () => "<svg/>" }) as any }),
    ).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  });
});
