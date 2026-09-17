import { describe, expect, it } from "vitest";
import { checkCoverage, coverageSummary } from "../../src/shared/model/coverage.js";
import type { StoredDiagram } from "../../src/shared/model/facts.js";

/**
 * IA against the designs that actually exist.
 *
 * The direction that needs care is `canvas → IA` — "this artboard belongs to
 * no page". It is only sane because a page names ALL its artboards, itself and
 * its states; without that it would report every empty state and every
 * loading frame as an orphan, which is the same false positive `ia-drift` had
 * to be shaped around. So half of this file is about staying quiet.
 */
const sitemap = (pages: unknown[]): StoredDiagram => ({
  nodeId: "1:1",
  kind: "sitemap",
  title: "CRM IA",
  spec: { title: "CRM IA", pages },
});

const art = (nodeId: string, name: string) => ({ nodeId, name });

/** The user's real page: 12 artboards, of which 6 are states. */
const CANVAS = [
  art("a1", "01 · leads-list"),
  art("a2", "02 · leads-list-empty"),
  art("a3", "03 · create-lead-default"),
  art("a4", "04 · create-lead-ref-referrer"),
  art("a5", "05 · create-lead-ref-student"),
  art("a6", "06 · create-lead-errors"),
  art("a7", "07 · create-lead-submitting"),
  art("a8", "08 · edit-lead"),
  art("a9", "09 · delete-lead-confirm"),
  art("a10", "10 · lead-detail-profile"),
  art("a11", "11 · lead-detail-converted"),
  art("a12", "12 · convert-to-student"),
];

const FULL = [
  { id: "admin", label: "Quản trị" },
  { id: "leads", label: "Danh sách lead", parent: "admin", screenId: ["01", "02"] },
  { id: "create", label: "Tạo lead", parent: "leads", screenId: ["03", "04", "05", "06", "07"] },
  { id: "edit", label: "Sửa lead", parent: "leads", screenId: "08" },
  { id: "del", label: "Xoá lead", parent: "leads", screenId: "09" },
  { id: "detail", label: "Chi tiết lead", parent: "leads", screenId: ["10", "11"] },
  { id: "convert", label: "Chuyển thành học viên", parent: "detail", screenId: "12" },
];

describe("IA against the canvas", () => {
  it("accounts for every artboard once the states are named", () => {
    // THE point of letting a page name several artboards: the six state
    // frames stop looking like screens with no home.
    const c = checkCoverage([sitemap(FULL)], CANVAS)!;
    expect(c.orphans).toEqual([]);
    expect(c.undesigned).toEqual([]);
    expect(c.stats).toEqual({ pages: 7, designed: 6, artboards: 12, claimed: 12 });
  });

  it("without the states, the six of them ARE reported as orphans", () => {
    // The same IA with only the primary artboard on each page — which is what
    // it looked like before this feature, and why the feature exists.
    const thin = FULL.map((p) =>
      Array.isArray(p.screenId) ? { ...p, screenId: p.screenId[0]! } : p,
    );
    const c = checkCoverage([sitemap(thin)], CANVAS)!;
    expect(c.orphans.map((o) => o.nodeId).sort()).toEqual(
      ["a11", "a2", "a4", "a5", "a6", "a7"].sort(),
    );
  });

  it("names a page whose artboard is not on the canvas", () => {
    const c = checkCoverage(
      [sitemap([...FULL, { id: "reports", label: "Báo cáo", parent: "admin", screenId: "13" }])],
      CANVAS,
    )!;
    expect(c.undesigned).toHaveLength(1);
    expect(c.undesigned[0]!.page).toBe("Báo cáo");
    expect(c.undesigned[0]!.wanted).toEqual(["13"]);
  });

  it("names an artboard no page claims", () => {
    const c = checkCoverage([sitemap(FULL)], [...CANVAS, art("a13", "13 · export-csv")])!;
    expect(c.orphans).toEqual([{ nodeId: "a13", name: "13 · export-csv" }]);
  });

  it("matches on an id BOUNDARY, so 01 never claims 010", () => {
    const c = checkCoverage(
      [sitemap([{ id: "p", label: "P", screenId: "01" }])],
      [art("x", "01 · list"), art("y", "010 · other")],
    )!;
    expect(c.orphans.map((o) => o.nodeId)).toEqual(["y"]);
  });

  it("says it in one line", () => {
    const c = checkCoverage(
      [sitemap([...FULL, { id: "reports", label: "Báo cáo", parent: "admin", screenId: "13" }])],
      [...CANVAS, art("a14", "14 · export-csv")],
    )!;
    const line = coverageSummary(c);
    expect(line).toContain("6/8 pages have a design");
    expect(line).toContain('"Báo cáo"');
    expect(line).toContain('"14 · export-csv"');
  });
});

describe("what coverage stays silent about", () => {
  it("a sitemap that names no artboard at all — the author has not opted in", () => {
    // Reporting "7 pages have no design" at somebody who never used screenId
    // is noise, not news, and it would fire on every IA-first sitemap ever
    // drawn before a single screen exists.
    const bare = FULL.map(({ screenId, ...rest }) => rest);
    expect(checkCoverage([sitemap(bare)], CANVAS)).toBeNull();
  });

  it("a page with no artboard, on a sitemap where others have one", () => {
    // Unmapped is not undesigned. The root here names nothing and is not a
    // finding; only a page that SAYS which artboard it is can be missing one.
    const c = checkCoverage([sitemap(FULL)], CANVAS)!;
    expect(c.undesigned).toEqual([]);
    expect(c.stats.pages).toBe(7);
    expect(c.stats.designed).toBe(6);
  });

  it("a page with no sitemap on it", () => {
    const flow: StoredDiagram = { nodeId: "2:1", kind: "userflow", spec: { nodes: [] } };
    expect(checkCoverage([flow], CANVAS)).toBeNull();
  });

  it("a canvas with no artboards yet — IA drawn first", () => {
    const c = checkCoverage([sitemap(FULL)], [])!;
    // Every page that names an artboard is undesigned, which is TRUE and is
    // the progress answer somebody drawing the IA first actually wants.
    expect(c.undesigned).toHaveLength(6);
    expect(c.orphans).toEqual([]);
    expect(coverageSummary(c)).toContain("0/7 pages have a design");
  });

  it("a malformed or missing spec, rather than throwing", () => {
    expect(() =>
      checkCoverage(
        [
          { nodeId: "9:1", kind: "sitemap", spec: undefined },
          { nodeId: "9:2", kind: "sitemap", spec: "nope" },
          { nodeId: "9:3", kind: "sitemap", spec: { pages: "nope" } },
          { nodeId: "9:4", kind: "sitemap", spec: { pages: [null, 3, { label: "no id" }] } },
        ],
        CANVAS,
      ),
    ).not.toThrow();
  });
});

describe("more than one sitemap on a page", () => {
  it("an artboard claimed by EITHER has a home", () => {
    const web = sitemap([{ id: "w", label: "Web", screenId: "01" }]);
    const mobile: StoredDiagram = {
      nodeId: "1:2",
      kind: "sitemap",
      title: "Mobile IA",
      spec: { pages: [{ id: "m", label: "Mobile", screenId: "02" }] },
    };
    const c = checkCoverage([web, mobile], [CANVAS[0]!, CANVAS[1]!])!;
    expect(c.orphans).toEqual([]);
    expect(c.stats.pages).toBe(2);
  });
});
