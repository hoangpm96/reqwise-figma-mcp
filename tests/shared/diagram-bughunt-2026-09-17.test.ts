import { describe, expect, it } from "vitest";
import { buildSequence, checkSequence } from "../../src/shared/sequence/index.js";
import { reflowSequence } from "../../src/shared/sequence/layout.js";
import { pairCalls } from "../../src/shared/sequence/pairing.js";
import { parseSequenceText } from "../../src/shared/sequence/text.js";
import type { SeqFragmentSpec, SeqMessageSpec } from "../../src/shared/sequence/types.js";
import { buildErd, checkErd } from "../../src/shared/erd/index.js";
import type { ErdSpec } from "../../src/shared/erd/types.js";
import { parseSitemapText } from "../../src/shared/sitemap/text.js";
import { checkSitemap } from "../../src/shared/sitemap/check.js";
import { checkCoverage } from "../../src/shared/model/coverage.js";
import { splitDetail } from "../../src/shared/diagram/text-util.js";
import { parseErdText } from "../../src/shared/erd/text.js";
import type { Placement } from "../../src/shared/diagram/types.js";

/**
 * A bug hunt over the sequence, ERD and sitemap kinds. Each case here was
 * reproduced against the code before its fix and failed there; the comment on
 * each says what the reader of the diagram saw.
 */

const parts = [
  { id: "a", name: "A" },
  { id: "b", name: "B" },
];
const msg = (id: string, from: string, to: string, kind?: SeqMessageSpec["kind"]): SeqMessageSpec => ({
  id,
  from,
  to,
  label: id,
  ...(kind ? { kind } : {}),
});

describe("sequence: which reply answers which call", () => {
  it("a reply in the else branch never answers a call made in the if branch, even inside a loop", () => {
    // c0; loop { alt { c1 } else { r1 } } — r1 shared the loop with c1 and
    // was paired with it, so c0 read as "nothing comes back".
    const messages = [msg("c0", "a", "b"), msg("c1", "a", "b"), msg("r1", "b", "a", "return")];
    const fragments: SeqFragmentSpec[] = [
      { kind: "loop", label: "retry", messages: ["c1", "r1"] },
      { kind: "alt", label: "fresh", messages: ["c1"], else: { label: "cached", messages: ["r1"] } },
    ];
    const paired = pairCalls(messages, fragments);
    expect(paired.callOfReply.get("r1")?.id).toBe("c0");
  });

  it("an else-branch reply does not merge into a call answered inside the if branch", () => {
    // c1; alt { c2; r2 } else { r3 } — r3 was filed as a second outcome of
    // c2, which never happened on the else path, and c1 went unanswered.
    const messages = [
      msg("c1", "a", "b"),
      msg("c2", "a", "b"),
      msg("r2", "b", "a", "return"),
      msg("r3", "b", "a", "return"),
    ];
    const fragments: SeqFragmentSpec[] = [
      { kind: "alt", label: "ok", messages: ["c2", "r2"], else: { label: "no", messages: ["r3"] } },
    ];
    const paired = pairCalls(messages, fragments);
    expect(paired.callOfReply.get("r3")?.id).toBe("c1");
    expect(paired.unanswered).toEqual([]);
  });

  it("a call before a break is still answered from inside the break", () => {
    // The guard above must not refuse this: a break body is often exactly the
    // error reply to the call just made.
    const messages = [msg("c1", "a", "b"), msg("r1", "b", "a", "return")];
    const fragments: SeqFragmentSpec[] = [{ kind: "break", label: "timeout", messages: ["r1"] }];
    expect(pairCalls(messages, fragments).callOfReply.get("r1")?.id).toBe("c1");
  });

  it("the checker pairs on the fragments that survive validation, like the layout does", () => {
    // A break naming a message that does not exist is dropped — but the
    // checker still paired on it, merged r1 into c2 and warned "c1 no reply".
    const messages = [
      msg("c1", "a", "b"),
      msg("c2", "a", "b"),
      msg("r2", "b", "a", "return"),
      msg("r1", "b", "a", "return"),
    ];
    const res = checkSequence(parts, messages, [{ kind: "break", label: "x", messages: ["r2", "bogus"] }]);
    expect(res.fragments).toEqual([]);
    expect(res.warnings.join(" ")).not.toContain("Call with no reply");
  });
});

describe("sequence: nested fragment boxes", () => {
  const spec = {
    title: "Nested",
    participants: parts,
    messages: [msg("m1", "a", "b"), msg("m2", "b", "a", "return")],
    fragments: [
      { kind: "loop" as const, label: "each", messages: ["m1", "m2"] },
      { kind: "opt" as const, label: "if any", messages: ["m1", "m2"] },
    ],
  };

  it("two fragments over the same messages are two distinct boxes, the second inside the first", () => {
    const built = buildSequence(spec);
    const [outer, inner] = built.draw.fragments as [(typeof built.draw.fragments)[0], (typeof built.draw.fragments)[0]];
    expect(outer.at).not.toEqual(inner.at);
    expect(inner.at.x).toBeGreaterThan(outer.at.x);
    expect(inner.at.y).toBeGreaterThan(outer.at.y);
    expect(inner.at.x + inner.at.w).toBeLessThan(outer.at.x + outer.at.w);
    expect(inner.at.y + inner.at.h).toBeLessThan(outer.at.y + outer.at.h);
  });

  it("a reflow in place keeps the inset", () => {
    const built = buildSequence(spec);
    const placed = new Map<string, Placement>(built.draw.participants.map((p) => [p.id, p.at]));
    expect(reflowSequence(built.draw.graph!, placed).fragments).toEqual(built.draw.fragments);
  });
});

describe("sequence text: a participant called `note`", () => {
  it("keeps its messages as messages", () => {
    const parsed = parseSequenceText("a ->> note: first\nnote ->> a: second\nnote: a real note");
    expect(parsed.messages.map((m) => [m.from, m.to, m.label])).toEqual([
      ["a", "note", "first"],
      ["note", "a", "second"],
    ]);
    expect(parsed.messages[1]!.note).toBe("a real note");
  });
});

// ---------------------------------------------------------------- erd ----

const erd = (over: Partial<ErdSpec> = {}): ErdSpec => ({
  title: "Users",
  entities: [
    { id: "user", name: "users", attributes: [{ name: "id", type: "uuid", key: "pk" }, { name: "a", type: "text" }, { name: "b", type: "text" }, { name: "c", type: "text" }] },
    {
      id: "post",
      name: "posts",
      attributes: [
        { name: "id", type: "uuid", key: "pk" },
        { name: "title", type: "text" },
        { name: "body", type: "text" },
        { name: "user_id", type: "uuid", key: "fk" },
      ],
    },
  ],
  relations: [{ from: "user", to: "post", fromField: "id", toField: "user_id", fromSide: "right", toSide: "left" }],
  ...over,
});

/** Where along its face (0..1) a pinned port attaches. */
const portAt = (built: ReturnType<typeof buildErd>, end: "fromPort" | "toPort") =>
  built.draw.graph!.relations[0]![end]!.at;

describe("erd: lines attach to the column", () => {
  it("a pinned side still attaches at the column row, not mid-box", () => {
    const built = buildErd(erd());
    const post = built.draw.entities.find((e) => e.id === "post")!;
    const row = post.headerH + 3 * 24 + 12;
    expect(portAt(built, "toPort")).toBeCloseTo(row / post.at.h, 2);
    expect(portAt(built, "toPort")).not.toBe(0.5);
  });

  it("the column is matched like the checker matches it: trimmed, any case", () => {
    const spec = erd({
      relations: [{ from: "user", to: "post", fromField: "id", toField: " USER_ID ", fromSide: "right", toSide: "left" }],
    });
    expect(checkErd(spec.entities!, spec.relations!).warnings.join(" ")).not.toContain("does not exist");
    const built = buildErd(spec);
    const exact = buildErd(erd());
    expect(portAt(built, "toPort")).toBe(portAt(exact, "toPort"));
    // And unpinned, where the router picks the face itself.
    const free = buildErd(erd({ relations: [{ from: "user", to: "post", fromField: "id", toField: "USER_ID" }] }));
    const exactFree = buildErd(erd({ relations: [{ from: "user", to: "post", fromField: "id", toField: "user_id" }] }));
    expect(free.draw.edges[0]!.points).toEqual(exactFree.draw.edges[0]!.points);
  });

  it("warns when text and a relations list are both given", () => {
    const built = buildErd({ title: "t", text: "user\n  id pk\n", relations: erd().relations });
    expect(built.warnings.join(" ")).toContain("the text won");
  });

  it("warns when only one end names its column", () => {
    const spec = erd({ relations: [{ from: "user", to: "post", fromField: "id" }] });
    // Worded for the end that is actually missing: user.id IS named.
    const all = checkErd(spec.entities!, spec.relations!).warnings.join(" ");
    expect(all).toContain('names user.id but no column on "post"');
    expect(all).toContain("Give toField");
    expect(all).not.toContain("No column named");
  });
});

// ------------------------------------------------------------ sitemap ----

describe("sitemap text", () => {
  it("an arrow inside the quoted label is part of the label", () => {
    // The line was skipped as an "arrow", the page vanished, and its child
    // was silently re-filed under the page above.
    const parsed = parseSitemapText('home "Home"\n  p "Tap -> to continue"\n    kid "Kid"');
    expect(parsed.pages.map((p) => [p.id, p.label, p.parent])).toEqual([
      ["home", "Home", undefined],
      ["p", "Tap -> to continue", "home"],
      ["kid", "Kid", "p"],
    ]);
    expect(parsed.warnings).toEqual([]);
  });

  it("an arrow in the detail is prose too — but a real arrow is still refused", () => {
    const ok = parseSitemapText('home "Home" / tap -> next');
    expect(ok.pages[0]).toMatchObject({ id: "home", detail: "tap -> next" });
    const bad = parseSitemapText("a -> b");
    expect(bad.pages).toEqual([]);
    expect(bad.warnings.join(" ")).toContain("A sitemap line has no arrow");
  });

  it("a ` / ` inside the quoted label does not start the detail", () => {
    const parsed = parseSitemapText('auth "Đăng nhập / Đăng ký" screen:login / public');
    expect(parsed.pages[0]).toMatchObject({
      id: "auth",
      label: "Đăng nhập / Đăng ký",
      screenId: "login",
      detail: "public",
    });
    expect(parsed.warnings).toEqual([]);
  });
});

describe("splitDetail and its callers", () => {
  it("skips separators inside quotes, escaped quotes included", () => {
    expect(splitDetail('x "a \\" / b" / d')).toEqual({ head: 'x "a \\" / b"', detail: "d" });
    expect(splitDetail("x / d")).toEqual({ head: "x", detail: "d" });
    // A stray quote does not swallow the detail.
    expect(splitDetail('x 5" / d')).toEqual({ head: 'x 5"', detail: "d" });
  });

  it("sequence, erd and usecase labels keep a slash", () => {
    const seq = parseSequenceText('participant api "Read / write API" / svc\na ->> api: x');
    expect(seq.participants[0]).toMatchObject({ id: "api", name: "Read / write API", detail: "svc" });
    const e = parseErdText('user "Users / accounts" / core\n  id pk');
    expect(e.entities[0]).toMatchObject({ id: "user", name: "Users / accounts", detail: "core" });
  });
});

describe("sitemap check", () => {
  it("a modal on the way down does not count as a level", () => {
    const pages = [
      { id: "home" },
      { id: "a", parent: "home" },
      { id: "b", parent: "a" },
      { id: "dlg", parent: "b", kind: "modal" as const },
      { id: "leaf", parent: "dlg" },
    ];
    const res = checkSitemap(pages, 4);
    expect(res.warnings.join(" ")).not.toContain("levels deep");
    // The layout still gets a row per tree level.
    expect(res.depth.get("leaf")).toBe(5);
  });

  it("one page listing an artboard twice is not a clash with itself", () => {
    const res = checkSitemap([{ id: "list", screenId: ["01", "01"] }]);
    expect(res.warnings.join(" ")).not.toContain("claimed by");
  });
});

describe("coverage", () => {
  it("a page whose own artboard is missing is not designed, even if a state of it is", () => {
    const c = checkCoverage(
      [{ nodeId: "1:1", kind: "sitemap", title: "IA", spec: { pages: [{ id: "list", screenId: ["01", "02"] }] } }],
      [{ nodeId: "a2", name: "02 · list-empty" }],
    )!;
    expect(c.stats.designed).toBe(0);
    expect(c.undesigned.map((u) => u.page)).toEqual(["list"]);
    // The state is still this page's, not an orphan.
    expect(c.orphans).toEqual([]);
  });
});

describe("sequence text: two blocks over the same messages", () => {
  it("lists the block opened first as the outer one, so it is drawn outside", () => {
    const p = parseSequenceText("participant a\nparticipant b\nloop retry\nopt token\na ->> b: x\nb -->> a: y\nend\nend");
    expect(p.fragments.map((f) => f.kind)).toEqual(["loop", "opt"]);
  });
});
