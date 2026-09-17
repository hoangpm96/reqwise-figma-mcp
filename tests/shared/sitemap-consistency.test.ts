import { describe, expect, it } from "vitest";
import { checkConsistency } from "../../src/shared/model/check.js";
import { collectFacts, type StoredDiagram } from "../../src/shared/model/facts.js";

/**
 * The sitemap↔userflow cross-check, and — more importantly — the four things
 * it must never say.
 *
 * This file exists because of a mistake already made once in this repo: a
 * journey map's persona was fed into `collectFacts` because it looked free,
 * and the result was an `id-drift` finding on every page that held a journey
 * and a use case diagram, against a diagram that has no ids to give. It had to
 * be removed, and the lesson written into the code was: a new fact ships with
 * its SILENCE pinned by a test, not just its finding.
 *
 * So the `stays silent` block below is the load-bearing half. In particular
 * "a page no flow reaches" is the cheap, obvious, wrong check — a userflow is
 * supposed to draw one flow, so on a real product it would fire on most of
 * the IA, every time.
 */

const sitemap = (nodeId: string, title: string, pages: unknown[]): StoredDiagram => ({
  nodeId,
  kind: "sitemap",
  title,
  spec: { title, pages },
});

const userflow = (nodeId: string, title: string, nodes: unknown[]): StoredDiagram => ({
  nodeId,
  kind: "userflow",
  title,
  spec: { title, nodes, edges: [] },
});

const IA = sitemap("1:1", "CRM IA", [
  { id: "app", label: "CRM" },
  { id: "contacts", label: "Liên hệ", parent: "app" },
  { id: "detail", label: "Chi tiết liên hệ", parent: "contacts", screenId: "contact-detail" },
  { id: "settings", label: "Cài đặt", parent: "app" },
  { id: "billing", label: "Thanh toán", parent: "settings" },
]);

const find = (ds: StoredDiagram[]) => checkConsistency(ds).filter((f) => f.rule === "ia-drift");

describe("a flow against the IA", () => {
  it("names the screen the flow walks through that the product has no page for", () => {
    const f = find([
      IA,
      userflow("2:1", "Thêm liên hệ", [
        { id: "contacts", label: "Liên hệ" },
        { id: "otp", label: "Nhập OTP" },
      ]),
    ]);
    expect(f).toHaveLength(1);
    expect(f[0]!.message).toContain('"Nhập OTP"');
    expect(f[0]!.message).not.toContain("Liên hệ");
    // Both sides of the disagreement, or the finding cannot be acted on.
    expect(f[0]!.frames).toContain("2:1");
    expect(f[0]!.frames).toContain("1:1");
  });

  it("groups the missing screens into one finding per flow, not one per screen", () => {
    const f = find([
      IA,
      userflow("2:1", "Onboarding", [
        { id: "a", label: "Bước 1" },
        { id: "b", label: "Bước 2" },
        { id: "c", label: "Bước 3" },
      ]),
    ]);
    expect(f).toHaveLength(1);
    expect(f[0]!.message).toContain('"Bước 1"');
    expect(f[0]!.message).toContain('"Bước 3"');
  });

  it("catches the quiet one: same screen, two ids", () => {
    const f = find([
      IA,
      userflow("2:1", "Xem liên hệ", [{ id: "contact_detail", label: "Chi tiết liên hệ" }]),
    ]);
    expect(f).toHaveLength(1);
    expect(f[0]!.message).toContain("Same screen, two ids");
    expect(f[0]!.message).toContain("`contact_detail`");
    expect(f[0]!.message).toContain("`detail`");
  });

  it("says outright that the reverse direction is not checked", () => {
    // The message carries it because the reader's first question on seeing a
    // one-directional finding is "what about the other way".
    const f = find([IA, userflow("2:1", "F", [{ id: "nope", label: "Không có" }])]);
    expect(f[0]!.message).toContain("The reverse is NOT checked");
  });
});

describe("what the cross-check stays silent about", () => {
  it("a page no flow reaches — the cheap check that would fire on most of a real IA", () => {
    // The flow visits 2 of the 5 pages. The other 3 are NOT findings: a
    // userflow draws one journey through the product, so pages it does not
    // visit are the normal case, not a defect. Adding this back would put
    // three true, useless lines on every page that holds both kinds.
    const f = find([
      IA,
      userflow("2:1", "Sửa liên hệ", [
        { id: "contacts", label: "Liên hệ" },
        { id: "detail", label: "Chi tiết liên hệ" },
      ]),
    ]);
    expect(f).toEqual([]);
  });

  it("a userflow with no sitemap beside it", () => {
    expect(find([userflow("2:1", "F", [{ id: "x", label: "X" }])])).toEqual([]);
  });

  it("a sitemap with no userflow beside it", () => {
    expect(find([IA])).toEqual([]);
  });

  it("a decision, a state, a terminal or an external node — none of those is a page", () => {
    const f = find([
      IA,
      userflow("2:1", "Thanh toán", [
        { id: "contacts", label: "Liên hệ" },
        { id: "ok?", label: "Thành công?", kind: "decision" },
        { id: "saving", label: "Đang lưu", kind: "state" },
        { id: "done", label: "Kết thúc", kind: "terminal" },
        { id: "psp", label: "Cổng thanh toán", kind: "external" },
      ]),
    ]);
    expect(f).toEqual([]);
  });

  it("a flow that names the artboard instead of the page id", () => {
    // `screenId` is the back-reference to the artboard, and matching on it is
    // what lets a flow and a sitemap use different ids on purpose.
    expect(
      find([IA, userflow("2:1", "F", [{ id: "cd", label: "Chi tiết", screenId: "contact-detail" }])]),
    ).toEqual([]);
  });

  it("a screen that lives in ANY sitemap on the page, not just the first", () => {
    // A product routinely carries a web IA and a mobile one. A screen with a
    // home in either has a home.
    const mobile = sitemap("1:2", "Mobile IA", [
      { id: "m", label: "App" },
      { id: "scan", label: "Quét mã", parent: "m" },
    ]);
    expect(find([IA, mobile, userflow("2:1", "F", [{ id: "scan", label: "Quét mã" }])])).toEqual([]);
  });

  it("a sitemap contributes no ROLE, so it never drifts against an actor", () => {
    // The journey lesson applied ahead of time: a page is not somebody who
    // does things, so feeding pages in as roles would report id-drift between
    // a page called "Liên hệ" and an actor called "Liên hệ".
    const facts = collectFacts([IA]);
    expect(facts.roles).toEqual([]);
    expect(facts.screens.map((s) => s.where)).toEqual(new Array(5).fill("sitemap page"));
  });
});

describe("what a sitemap still contributes to the page index", () => {
  it("joins the policy comparison like every other kind", () => {
    const withRule: StoredDiagram = {
      nodeId: "1:9",
      kind: "sitemap",
      title: "IA",
      spec: {
        title: "IA",
        pages: [{ id: "app", label: "CRM" }, { id: "trial", label: "Dùng thử @trial-days ngày", parent: "app" }],
        options: { policies: { "trial-days": 14 } },
      },
    };
    const other: StoredDiagram = {
      nodeId: "1:10",
      kind: "state",
      title: "Trial lifecycle",
      spec: { title: "Trial lifecycle", states: [], options: { policies: { "trial-days": 30 } } },
    };
    const drift = checkConsistency([withRule, other]).filter((f) => f.rule === "policy-drift");
    expect(drift).toHaveLength(1);
    expect(drift[0]!.message).toContain("@trial-days");
  });
});
