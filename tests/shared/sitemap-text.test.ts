import { describe, expect, it } from "vitest";
import { parseSitemapText } from "../../src/shared/sitemap/text.js";

/**
 * The compact form of a sitemap is indentation, so these tests are mostly
 * about counting spaces — which is exactly the thing a parser is allowed to be
 * silently wrong about. The rule the whole grammar rests on: a line that
 * cannot be placed is REPORTED, never filed under the nearest guess.
 */
describe("the compact sitemap form", () => {
  it("reads indentation as containment", () => {
    const { pages, warnings } = parseSitemapText(`
crm "CRM"
  dash "Dashboard"
  contacts "Liên hệ" section
    list "Danh sách"
    detail "Chi tiết liên hệ"
  settings "Cài đặt"
`);
    expect(warnings).toEqual([]);
    expect(pages).toEqual([
      { id: "crm", label: "CRM" },
      { id: "dash", label: "Dashboard", parent: "crm" },
      { id: "contacts", label: "Liên hệ", parent: "crm", kind: "section" },
      { id: "list", label: "Danh sách", parent: "contacts" },
      { id: "detail", label: "Chi tiết liên hệ", parent: "contacts" },
      { id: "settings", label: "Cài đặt", parent: "crm" },
    ]);
  });

  it("does not care whether you indent by two spaces, four, or a tab", () => {
    const two = parseSitemapText("a \"A\"\n  b \"B\"\n    c \"C\"");
    const four = parseSitemapText("a \"A\"\n    b \"B\"\n        c \"C\"");
    const tabs = parseSitemapText("a \"A\"\n\tb \"B\"\n\t\tc \"C\"");
    for (const out of [two, four, tabs]) {
      expect(out.warnings).toEqual([]);
      expect(out.pages.map((p) => [p.id, p.parent])).toEqual([
        ["a", undefined],
        ["b", "a"],
        ["c", "b"],
      ]);
    }
  });

  it("reads kind, class, the artboard id and a trailing detail", () => {
    const { pages, warnings } = parseSitemapText(`
crm "CRM"
  detail "Chi tiết" screen:contact-detail / chỉ sales xem được
  psp "Cổng thanh toán" external err
  confirm "Xác nhận xoá" modal
`);
    expect(warnings).toEqual([]);
    expect(pages[1]).toEqual({
      id: "detail",
      label: "Chi tiết",
      parent: "crm",
      screenId: "contact-detail",
      detail: "chỉ sales xem được",
    });
    expect(pages[2]).toEqual({
      id: "psp",
      label: "Cổng thanh toán",
      parent: "crm",
      kind: "external",
      cls: "error",
    });
    expect(pages[3]!.kind).toBe("modal");
  });

  it("reads a list of artboards, because one page is usually several", () => {
    const { pages, warnings } = parseSitemapText(`
crm "CRM"
  leads "Danh sách lead" screen:01,02
  create "Tạo lead" modal screen:03,04,05,06,07
  edit "Sửa lead" modal screen:08
`);
    expect(warnings).toEqual([]);
    expect(pages[1]!.screenId).toEqual(["01", "02"]);
    expect(pages[2]!.screenId).toEqual(["03", "04", "05", "06", "07"]);
    // One artboard stays a bare string, so every model written before this
    // existed round-trips unchanged.
    expect(pages[3]!.screenId).toBe("08");
  });

  it("drops a stray comma rather than claiming an artboard called \"\"", () => {
    const { pages, warnings } = parseSitemapText('crm "CRM"\n  a "A" screen:01,,02,');
    expect(warnings).toEqual([]);
    expect(pages[1]!.screenId).toEqual(["01", "02"]);
  });

  it("reports an indent that lines up with no level instead of guessing", () => {
    // The dangerous case: `stray` dedents from column 4 to column 2, which
    // nothing was ever written at. Filing it under the nearest candidate is
    // how a page ends up in the wrong branch with nothing said.
    const { pages, warnings } = parseSitemapText(
      "a \"A\"\n    b \"B\"\n        c \"C\"\n  stray \"Stray\"",
    );
    expect(warnings.join("\n")).toContain("lines up with no level in use");
    expect(warnings.join("\n")).toContain('filed under "a"');
    expect(pages[3]).toEqual({ id: "stray", label: "Stray", parent: "a" });
  });

  it("stays quiet when a first child invents a deeper column", () => {
    // A column deeper than every one so far is simply the next level down,
    // and the first child of a level has to be allowed to establish it —
    // otherwise every well-formed tree warns on its second line.
    expect(parseSitemapText("a \"A\"\n   b \"B\"\n      c \"C\"").warnings).toEqual([]);
  });

  it("drops a page declared twice and says WHY a tree cannot hold it", () => {
    const { pages, warnings } = parseSitemapText(`
crm "CRM"
  a "A"
  b "B"
    a "A lần hai"
`);
    expect(pages.map((p) => p.id)).toEqual(["crm", "a", "b"]);
    expect(warnings.join("\n")).toContain("already declared");
    // The finding has to say where the second one belongs, or the reader just
    // renames the id and loses the fact they were modelling navigation.
    expect(warnings.join("\n")).toContain("belongs in a userflow");
  });

  it("skips a `sitemap \"…\"` header line rather than drawing it as the root", () => {
    const { pages, warnings } = parseSitemapText("sitemap \"CRM\"\ncrm \"CRM\"\n  a \"A\"");
    expect(warnings.join("\n")).toContain("not part of the model");
    expect(pages.map((p) => p.id)).toEqual(["crm", "a"]);
  });

  it("takes `#` comments and blank lines", () => {
    const { pages, warnings } = parseSitemapText(`
# the front door
crm "CRM"

  a "A"   # nav order matters
`);
    expect(warnings).toEqual([]);
    expect(pages.map((p) => p.id)).toEqual(["crm", "a"]);
  });

  it("reports a word it does not recognise instead of eating it", () => {
    const { pages, warnings } = parseSitemapText("crm \"CRM\"\n  a \"A\" sektion");
    expect(warnings.join("\n")).toContain('"sektion" is not a kind or a class');
    expect(pages[1]!.kind).toBeUndefined();
  });

  it("reports a line with no id at all", () => {
    const { warnings } = parseSitemapText('crm "CRM"\n  "Nhãn không có id"');
    expect(warnings.join("\n")).toContain("not understood, skipped");
  });

  it("falls back to the id when a page has no quoted label", () => {
    const { pages, warnings } = parseSitemapText("crm\n  dashboard");
    expect(warnings).toEqual([]);
    expect(pages).toEqual([{ id: "crm" }, { id: "dashboard", parent: "crm" }]);
  });

  it("has no arrow token, and says why rather than reporting junk words", () => {
    // `a -> b` is what somebody who has just drawn a userflow will type, and
    // read as words it would declare a page called `a` with two bits of junk
    // after it. The finding has to name the actual mistake — containment is
    // not navigation — or the reader fixes the symptom.
    for (const line of ["a -> b", "a ->> b", "a ~> b", "a => b", "a :> b", "b <- a"]) {
      const { pages, warnings } = parseSitemapText(`crm "CRM"\n  ${line}`);
      expect(pages.map((p) => p.id), line).toEqual(["crm"]);
      expect(warnings.join("\n"), line).toContain("A sitemap line has no arrow");
      expect(warnings.join("\n"), line).toContain('type:"userflow"');
    }
  });
});
