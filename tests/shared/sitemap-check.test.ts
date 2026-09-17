import { describe, expect, it } from "vitest";
import { checkSitemap } from "../../src/shared/sitemap/check.js";
import type { PageSpec } from "../../src/shared/sitemap/types.js";

/**
 * Half of these tests are about what the checker says. The other half — the
 * `stays quiet` block — are about what it must NOT say, and they are the ones
 * worth having: a proof-reader that fires on a correct tree teaches its reader
 * to stop reading it, and every rule here was written with the case it has to
 * be silent about.
 */
const warn = (pages: PageSpec[], maxDepth?: number): string[] =>
  checkSitemap(pages, maxDepth).warnings;

const GOOD: PageSpec[] = [
  { id: "app", label: "CRM" },
  { id: "dash", label: "Dashboard", parent: "app" },
  { id: "contacts", label: "Liên hệ", parent: "app" },
  { id: "list", label: "Danh sách", parent: "contacts" },
  { id: "detail", label: "Chi tiết liên hệ", parent: "contacts" },
];

describe("what the sitemap checker reports", () => {
  it("names the page whose parent does not exist, and how much went with it", () => {
    const w = warn([
      { id: "app", label: "CRM" },
      { id: "detail", label: "Chi tiết", parent: "contatcs" },
      { id: "tab", label: "Hoạt động", parent: "detail" },
    ]);
    expect(w.join("\n")).toContain('no page called "contatcs"');
    expect(w.join("\n")).toContain("1 page(s) under it");
  });

  it("drops a page that is its own parent instead of walking forever", () => {
    const out = checkSitemap([
      { id: "app", label: "CRM" },
      { id: "loop", label: "Loop", parent: "loop" },
    ]);
    expect(out.warnings.join("\n")).toContain("its own parent");
    expect(out.pages.map((p) => p.id)).toEqual(["app"]);
  });

  it("breaks a containment cycle and says which pages it dropped", () => {
    const out = checkSitemap([
      { id: "app", label: "CRM" },
      { id: "a", label: "A", parent: "b" },
      { id: "b", label: "B", parent: "a" },
    ]);
    expect(out.warnings.join("\n")).toContain("Containment cycle");
    expect(out.pages.map((p) => p.id)).toEqual(["app"]);
  });

  it("reports more than one front door but still draws them", () => {
    const out = checkSitemap([
      { id: "app", label: "CRM" },
      { id: "admin", label: "Admin" },
      { id: "x", label: "X", parent: "admin" },
    ]);
    expect(out.warnings.join("\n")).toContain("2 pages with no parent");
    expect(out.pages.length).toBe(3);
    expect(out.roots).toEqual(["app", "admin"]);
  });

  it("counts the clicks, not the levels, when it complains about depth", () => {
    const deep: PageSpec[] = [
      { id: "l1", label: "1" },
      { id: "l2", label: "2", parent: "l1" },
      { id: "l3", label: "3", parent: "l2" },
      { id: "l4", label: "4", parent: "l3" },
      { id: "l5", label: "5", parent: "l4" },
    ];
    const w = warn(deep).join("\n");
    expect(w).toContain("5+ levels deep");
    expect(w).toContain("4 clicks from the front door");
    // And the way out is named, so the finding is actionable rather than a
    // rule the caller has to argue with.
    expect(w).toContain("options.maxDepth");
    expect(warn(deep, 5)).toEqual([]);
  });

  it("calls out a section that groups one thing, and one that groups none", () => {
    const w = warn([
      { id: "app", label: "CRM" },
      { id: "group", label: "Báo cáo", kind: "section", parent: "app" },
      { id: "only", label: "Doanh thu", parent: "group" },
      { id: "empty", label: "Tích hợp", kind: "section", parent: "app" },
    ]).join("\n");
    expect(w).toContain('"Báo cáo" (1)');
    expect(w).toContain('"Tích hợp" (0)');
  });

  it("catches two pages with one word in the same menu", () => {
    const w = warn([
      { id: "app", label: "CRM" },
      { id: "s1", label: "Cài đặt", parent: "app" },
      { id: "s2", label: "cài  đặt", parent: "app" },
    ]).join("\n");
    expect(w).toContain('both called "Cài đặt"');
    expect(w).toContain("`s1`, `s2`");
  });

  it("catches two front doors with the same name too", () => {
    const w = warn([
      { id: "a", label: "CRM" },
      { id: "b", label: "CRM" },
    ]).join("\n");
    expect(w).toContain("at the top level");
  });

  it("says a flat list is not an architecture", () => {
    const w = warn([
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ]).join("\n");
    expect(w).toContain("not an information architecture");
  });

  it("does not let us design pages inside somebody else's product", () => {
    const w = warn([
      { id: "app", label: "CRM" },
      { id: "psp", label: "Cổng thanh toán", kind: "external", parent: "app" },
      { id: "psp2", label: "Nhập thẻ", parent: "psp" },
    ]).join("\n");
    expect(w).toContain("External page with pages inside");
  });

  it("drops a duplicate id and says so", () => {
    const out = checkSitemap([
      { id: "app", label: "CRM" },
      { id: "x", label: "X", parent: "app" },
      { id: "x", label: "X lần hai", parent: "app" },
    ]);
    expect(out.warnings.join("\n")).toContain('Duplicate page id "x"');
    expect(out.pages.length).toBe(2);
  });

  it("has something to say about an empty tree", () => {
    expect(warn([]).join("\n")).toContain("No pages");
  });
});

describe("what the sitemap checker stays quiet about", () => {
  it("says nothing at all about a correct tree", () => {
    expect(warn(GOOD)).toEqual([]);
  });

  it("a PAGE with a single child is correct IA, not a category of one", () => {
    // "Liên hệ → Chi tiết liên hệ" is the commonest shape in any real product.
    // Reporting it would teach people to flatten a tree that is already right,
    // so only `kind:"section"` — which exists solely to group — is checked.
    expect(
      warn([
        { id: "app", label: "CRM" },
        { id: "contacts", label: "Liên hệ", parent: "app" },
        { id: "detail", label: "Chi tiết liên hệ", parent: "contacts" },
      ]),
    ).toEqual([]);
  });

  it("the same label under two different parents is two menus, not a clash", () => {
    expect(
      warn([
        { id: "app", label: "CRM" },
        { id: "admin", label: "Quản trị", parent: "app" },
        { id: "profile", label: "Hồ sơ", parent: "app" },
        { id: "as", label: "Cài đặt", parent: "admin" },
        { id: "ps", label: "Cài đặt", parent: "profile" },
      ]),
    ).toEqual([]);
  });

  it("a modal does not count as a level, because it opens on top of a page", () => {
    const w = warn([
      { id: "l1", label: "1" },
      { id: "l2", label: "2", parent: "l1" },
      { id: "l3", label: "3", parent: "l2" },
      { id: "l4", label: "4", parent: "l3" },
      { id: "confirm", label: "Xác nhận xoá", kind: "modal", parent: "l4" },
    ]);
    expect(w).toEqual([]);
  });

  it("an external LEAF is fine — that is what external is for", () => {
    expect(
      warn([
        { id: "app", label: "CRM" },
        { id: "psp", label: "Cổng thanh toán", kind: "external", parent: "app" },
        { id: "x", label: "Khác", parent: "app" },
      ]),
    ).toEqual([]);
  });

  it("a single page with no children is a sitemap of one, and legal", () => {
    expect(warn([{ id: "app", label: "CRM" }])).toEqual([]);
  });
});

describe("the shape the checker hands to the layout", () => {
  it("returns parents before children, with depths counted from 1", () => {
    const out = checkSitemap(GOOD);
    expect(out.depth.get("app")).toBe(1);
    expect(out.depth.get("contacts")).toBe(2);
    expect(out.depth.get("detail")).toBe(3);
    expect(out.children.get("contacts")).toEqual(["list", "detail"]);
    expect(out.children.has("detail")).toBe(false);
  });
});
