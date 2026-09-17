import { describe, expect, it } from "vitest";
import { checkSitemap } from "../../src/shared/sitemap/check.js";
import { layoutSitemap } from "../../src/shared/sitemap/layout.js";
import type { PageSpec, Placement } from "../../src/shared/sitemap/types.js";

/**
 * The tidy-tree pass is the one piece of geometry in this repo that is not
 * dagre's problem, so it has to be held by properties rather than by a
 * screenshot: no two boxes on a level may touch, every parent sits over the
 * middle of its children, and the order they were written in is the order they
 * are drawn in — that last one being the whole reason not to use dagre, since
 * an IA's sibling order is the nav order and therefore content.
 */

const laid = (pages: PageSpec[], options = {}) => layoutSitemap(checkSitemap(pages), options);

const boxes = (pages: ReturnType<typeof laid>["pages"]): Map<string, Placement> =>
  new Map(pages.map((p) => [p.id, p.at]));

/** A three-level tree with deliberately uneven branch widths. */
const TREE: PageSpec[] = [
  { id: "app", label: "CRM" },
  { id: "dash", label: "Dashboard", parent: "app" },
  { id: "contacts", label: "Liên hệ", parent: "app" },
  { id: "list", label: "Danh sách", parent: "contacts" },
  { id: "detail", label: "Chi tiết liên hệ", parent: "contacts" },
  { id: "import", label: "Nhập từ CSV", parent: "contacts" },
  { id: "settings", label: "Cài đặt", parent: "app" },
  { id: "billing", label: "Thanh toán", parent: "settings" },
];

describe("the tidy tree", () => {
  it("never lets two boxes on a level touch", () => {
    const out = laid(TREE);
    const byLevel = new Map<number, Array<{ id: string; at: Placement }>>();
    for (const p of out.pages) {
      const row = byLevel.get(p.depth) ?? [];
      row.push({ id: p.id, at: p.at });
      byLevel.set(p.depth, row);
    }
    for (const [level, row] of byLevel) {
      row.sort((a, b) => a.at.x - b.at.x);
      for (let i = 1; i < row.length; i++) {
        const prev = row[i - 1]!;
        const cur = row[i]!;
        expect(
          cur.at.x,
          `level ${level}: "${cur.id}" overlaps "${prev.id}"`,
        ).toBeGreaterThanOrEqual(prev.at.x + prev.at.w);
      }
    }
  });

  it("centres every parent over its children", () => {
    const out = laid(TREE);
    const at = boxes(out.pages);
    const centre = (id: string) => at.get(id)!.x + at.get(id)!.w / 2;
    for (const [parent, kids] of [
      ["app", ["dash", "contacts", "settings"]],
      ["contacts", ["list", "detail", "import"]],
    ] as Array<[string, string[]]>) {
      const first = centre(kids[0]!);
      const last = centre(kids[kids.length - 1]!);
      expect(centre(parent), parent).toBeCloseTo((first + last) / 2, 0);
    }
  });

  it("keeps the order the pages were written in, because that is the nav order", () => {
    const out = laid(TREE);
    const at = boxes(out.pages);
    expect(at.get("dash")!.x).toBeLessThan(at.get("contacts")!.x);
    expect(at.get("contacts")!.x).toBeLessThan(at.get("settings")!.x);
    expect(at.get("list")!.x).toBeLessThan(at.get("detail")!.x);
    expect(at.get("detail")!.x).toBeLessThan(at.get("import")!.x);
  });

  it("puts each level on its own row, deeper level further down", () => {
    const out = laid(TREE);
    const at = boxes(out.pages);
    expect(at.get("app")!.y).toBeLessThan(at.get("contacts")!.y);
    expect(at.get("contacts")!.y).toBeLessThan(at.get("list")!.y);
    // Siblings share a row exactly — a ragged row is what uneven sibling
    // spacing looks like once it reaches the canvas.
    expect(at.get("list")!.y).toBe(at.get("detail")!.y);
    expect(at.get("dash")!.y).toBe(at.get("settings")!.y);
  });

  it("tucks a narrow branch under a wide one instead of reserving a column", () => {
    // The point of Reingold–Tilford over the naive "subtree width = sum of
    // children" layout: `a`'s deep-but-narrow branch can slide under `b`'s
    // shallow-but-wide one. If this ever regresses the tree still draws, it
    // just gets wider than it needs to be — so the assertion is on the width.
    const tucked = laid([
      { id: "r", label: "Root" },
      { id: "a", label: "A", parent: "r" },
      { id: "a1", label: "A1", parent: "a" },
      { id: "b", label: "B", parent: "r" },
      { id: "b1", label: "B1", parent: "b" },
      { id: "b2", label: "B2", parent: "b" },
      { id: "b3", label: "B3", parent: "b" },
    ]);
    const wide = laid([
      { id: "r", label: "Root" },
      { id: "a", label: "A", parent: "r" },
      { id: "a1", label: "A1", parent: "a" },
      { id: "a2", label: "A2", parent: "a" },
      { id: "a3", label: "A3", parent: "a" },
      { id: "b", label: "B", parent: "r" },
      { id: "b1", label: "B1", parent: "b" },
      { id: "b2", label: "B2", parent: "b" },
      { id: "b3", label: "B3", parent: "b" },
    ]);
    expect(tucked.w).toBeLessThan(wide.w);
  });

  it("lays out a forest side by side rather than on top of itself", () => {
    const out = laid([
      { id: "a", label: "A" },
      { id: "b", label: "B" },
      { id: "a1", label: "A1", parent: "a" },
    ]);
    const at = boxes(out.pages);
    expect(at.get("a")!.y).toBe(at.get("b")!.y);
    expect(at.get("b")!.x).toBeGreaterThanOrEqual(at.get("a")!.x + at.get("a")!.w);
  });
});

describe("the containment lines", () => {
  it("draws one elbow per parent→child pair and no arrow heads anywhere", () => {
    const out = laid(TREE);
    expect(out.edges.map((e) => e.id).sort()).toEqual([
      "app->contacts",
      "app->dash",
      "app->settings",
      "contacts->detail",
      "contacts->import",
      "contacts->list",
      "settings->billing",
    ]);
    // One line per containment link, which in a tree is every page but the
    // root. DrawEdge carries no head flag — the plugin decides — so the
    // guarantee here is that nothing else got drawn.
    expect(out.edges.length).toBe(TREE.length - 1);
  });

  it("gives every child of one parent the same shoulder", () => {
    const out = laid(TREE);
    const bent = out.edges.filter((e) => e.id.startsWith("contacts->") && e.points.length === 4);
    // Two of the three bend; the middle child sits exactly under its parent
    // and gets a straight drop with NO shoulder, which is the right drawing
    // and the reason this filters rather than reading points[1] blindly.
    expect(bent.length).toBe(2);
    expect(new Set(bent.map((e) => e.points[1]![1])).size).toBe(1);
    const straight = out.edges.filter((e) => e.id.startsWith("contacts->") && e.points.length === 2);
    expect(straight.map((e) => e.id)).toEqual(["contacts->detail"]);
  });

  it("routes orthogonally: every segment is horizontal or vertical", () => {
    for (const rankdir of ["TB", "LR"] as const) {
      const out = laid(TREE, { rankdir });
      for (const e of out.edges) {
        for (let i = 1; i < e.points.length; i++) {
          const [ax, ay] = e.points[i - 1]!;
          const [bx, by] = e.points[i]!;
          expect(
            Math.abs(ax - bx) < 0.6 || Math.abs(ay - by) < 0.6,
            `${rankdir} ${e.id} segment ${i} is diagonal`,
          ).toBe(true);
        }
      }
    }
  });

  it("runs rightwards for rankdir LR", () => {
    const out = laid(TREE, { rankdir: "LR" });
    const at = boxes(out.pages);
    expect(at.get("app")!.x).toBeLessThan(at.get("contacts")!.x);
    expect(at.get("dash")!.x).toBe(at.get("settings")!.x);
    expect(at.get("dash")!.y).toBeLessThan(at.get("contacts")!.y);
  });
});

describe("the dagre escape hatch", () => {
  it("draws the same tree, on the same rows", () => {
    const tree = laid(TREE);
    const dag = laid(TREE, { layout: "dagre" });
    expect(dag.pages.length).toBe(tree.pages.length);
    expect(dag.edges.length).toBe(tree.edges.length);
    const rows = (out: typeof tree) =>
      new Map(out.pages.map((p) => [p.id, p.at.y]));
    // The level positions are ours in both modes, so only the sibling axis
    // may differ — that is exactly what the option is for.
    expect([...rows(dag).values()].sort()).toEqual([...rows(tree).values()].sort());
  });

  it("still never overlaps two boxes on a level", () => {
    const out = laid(TREE, { layout: "dagre" });
    const byLevel = new Map<number, Array<{ id: string; at: Placement }>>();
    for (const p of out.pages) {
      const row = byLevel.get(p.depth) ?? [];
      row.push({ id: p.id, at: p.at });
      byLevel.set(p.depth, row);
    }
    for (const row of byLevel.values()) {
      row.sort((a, b) => a.at.x - b.at.x);
      for (let i = 1; i < row.length; i++) {
        expect(row[i]!.at.x).toBeGreaterThanOrEqual(row[i - 1]!.at.x + row[i - 1]!.at.w);
      }
    }
  });
});

describe("what each kind looks like", () => {
  // Three independent signals rather than four unrelated looks: the stroke
  // says "a page you navigate to" or not, the dash says "ours" or not, the
  // radius says "a page" or "an overlay". Pinned because the first real
  // drawing had four dialogs among seven boxes and only the corner radius
  // distinguished them — which is the one distinction this kind exists to
  // make, since a modal is not a navigation level and the depth rule exempts
  // it for exactly that reason.
  const look = (page: PageSpec) => {
    const out = laid([{ id: "r", label: "Root" }, { ...page, parent: "r" }]);
    return out.pages.find((p) => p.id === page.id)!;
  };

  it("marks a modal as not-a-nav-level, by more than its corners", () => {
    const modal = look({ id: "m", label: "M", kind: "modal" });
    const page = look({ id: "p", label: "P" });
    expect(modal.radius).toBeGreaterThan(page.radius);
    expect(modal.stroke).not.toBe(page.stroke);
    expect(modal.dashed).toBe(false);
  });

  it("gives an external the same muted stroke, plus the dash that means not ours", () => {
    const ext = look({ id: "e", label: "E", kind: "external" });
    const modal = look({ id: "m", label: "M", kind: "modal" });
    expect(ext.stroke).toBe(modal.stroke);
    expect(ext.dashed).toBe(true);
    expect(ext.radius).toBe(look({ id: "p", label: "P" }).radius);
  });

  it("tints a section, because it is the one kind that is a GROUP", () => {
    const section = look({ id: "s", label: "S", kind: "section" });
    expect(section.fill).not.toBe(look({ id: "p", label: "P" }).fill);
  });

  it("lets an explicit class win over the kind's default look", () => {
    // `cls` is the author saying what the page MEANS, which outranks what it
    // structurally is.
    const plain = look({ id: "m", label: "M", kind: "modal" });
    const err = look({ id: "m2", label: "M", kind: "modal", cls: "error" });
    expect(err.stroke).not.toBe(plain.stroke);
    expect(err.radius).toBe(plain.radius);
  });
});

describe("the title block, which nothing used to measure", () => {
  // Reported by a user on the first real drawing: the subtitle ran into the
  // root box. This kind had a flat 78px header against a title block that
  // ends at 74 — four pixels — while the other six kinds reserve 96. Flat 96
  // would have fixed THAT drawing and still broken on a subtitle long enough
  // to wrap, which is the bug the journey handler was bitten by ("a subtitle
  // whose height nothing downstream counted"). So it is measured.
  const topOf = (out: ReturnType<typeof laid>) => Math.min(...out.pages.map((p) => p.at.y));

  it("leaves real air under a one-line subtitle, matching the other kinds", () => {
    const out = layoutSitemap(checkSitemap(TREE), {}, "Một dòng ngắn");
    expect(topOf(out)).toBe(96);
  });

  it("pushes the tree DOWN for a subtitle long enough to wrap, instead of drawing over it", () => {
    const short = layoutSitemap(checkSitemap(TREE), {}, "Ngắn");
    const long = layoutSitemap(
      checkSitemap([{ id: "only", label: "Một trang" }]),
      {},
      "Suy ra từ 12 artboard trên page này cộng với model mà Userflow lead-management đã lưu, dựng ngược từ code production đang chạy thật",
    );
    // The narrow frame makes that subtitle wrap; the first row has to clear it.
    expect(long.w).toBeLessThan(short.w);
    expect(topOf(long)).toBeGreaterThan(96);
  });

  it("reserves less when there is no subtitle at all", () => {
    expect(topOf(layoutSitemap(checkSitemap(TREE), {}, ""))).toBeLessThan(96);
  });

  it("never lets the first row start inside the subtitle", () => {
    for (const sub of ["", "Một dòng", "Hai mươi bảy từ ".repeat(12)]) {
      for (const rankdir of ["TB", "LR"] as const) {
        const out = layoutSitemap(checkSitemap(TREE), { rankdir }, sub);
        const bottomOfHeader = sub.trim() ? 56 + 18 : 24 + 26;
        expect(topOf(out), `${rankdir} / ${sub.length} chars`).toBeGreaterThanOrEqual(bottomOfHeader);
      }
    }
  });
});
