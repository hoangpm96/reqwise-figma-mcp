import { describe, expect, it } from "vitest";
import { headerHeight } from "../../src/shared/diagram/metrics.js";
import { buildUserflow } from "../../src/shared/userflow/index.js";
import { buildActivity } from "../../src/shared/activity/index.js";
import { buildErd } from "../../src/shared/erd/index.js";
import { buildSequence } from "../../src/shared/sequence/index.js";
import { buildState } from "../../src/shared/state/index.js";
import { buildSitemap } from "../../src/shared/sitemap/index.js";

/**
 * The title block is MEASURED, in every kind.
 *
 * All of them draw the title at y=24 and the subtitle at y=56, and all of them
 * reserved a flat 96 for the pair — right for a one-line subtitle and wrong for
 * a longer one, which then gets drawn on top of the first row. The journey
 * handler was bitten first ("a subtitle whose height nothing downstream
 * counted … the subtitle's last line sat on the first card") and a user caught
 * it again on a sitemap: four pixels between the subtitle and the root box.
 *
 * Two things have to hold for every kind, and the first is why this is safe to
 * do to seven layouts at once: a ONE-LINE subtitle must still land on exactly
 * 96, so nothing anybody has already drawn moves.
 */
describe("headerHeight", () => {
  it("keeps the old 96 for one line, so no existing diagram shifts", () => {
    expect(headerHeight("Một dòng ngắn", 1000)).toBe(96);
  });

  it("reserves less when there is no subtitle at all", () => {
    expect(headerHeight("", 1000)).toBe(72);
    expect(headerHeight("   ", 1000)).toBe(72);
  });

  it("grows by one line height per wrapped line", () => {
    const long = "Suy ra từ 12 artboard trên page này cộng với model mà Userflow lead-management đã lưu";
    expect(headerHeight(long, 2000)).toBe(96);
    const narrow = headerHeight(long, 420);
    expect(narrow).toBeGreaterThan(96);
    expect((narrow - 96) % 18).toBe(0);
  });

  it("never goes below the title's own block, however narrow the frame", () => {
    expect(headerHeight("x".repeat(400), 120)).toBeGreaterThanOrEqual(72);
  });
});

/** The first row of each kind's drawing — whatever that kind calls its boxes. */
const TOP: Record<string, (d: any) => number> = {
  userflow: (d) => Math.min(...d.boxes.map((b: any) => b.y)),
  // The lane BANDS are the top of an activity diagram, not the first step
  // inside them; likewise a use case diagram's system boundary sits above its
  // contents. Measure what actually touches the title block.
  activity: (d) => Math.min(...d.lanes.map((l: any) => l.at.y), ...d.steps.map((s: any) => s.at.y)),
  erd: (d) => Math.min(...d.entities.map((e: any) => e.at.y)),
  sequence: (d) => Math.min(...d.participants.map((p: any) => p.at.y)),
  state: (d) => Math.min(...d.states.map((s: any) => s.at.y)),
  sitemap: (d) => Math.min(...d.pages.map((p: any) => p.at.y)),
};

const BUILD: Record<string, (subtitle: string) => any> = {
  userflow: (subtitle) => buildUserflow({
    title: "T", subtitle,
    nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
    edges: [{ from: "a", to: "b" }],
  }),
  activity: (subtitle) => buildActivity({
    title: "T", subtitle,
    lanes: [{ id: "l", label: "L" }],
    nodes: [
      { id: "s", label: "S", lane: "l", kind: "start" },
      { id: "e", label: "E", lane: "l", kind: "end" },
    ],
    edges: [{ from: "s", to: "e" }],
  }),
  erd: (subtitle) => buildErd({
    title: "T", subtitle,
    entities: [
      { id: "u", name: "users", attributes: [{ name: "id", type: "uuid", key: "pk" }] },
      { id: "b", name: "bookings", attributes: [{ name: "user_id", type: "uuid", key: "fk" }] },
    ],
    relations: [{ from: "u", to: "b", fromField: "id", toField: "user_id" }],
  }),
  sequence: (subtitle) => buildSequence({
    title: "T", subtitle,
    participants: [{ id: "u", name: "U" }, { id: "s", name: "S" }],
    messages: [{ id: "m1", from: "u", to: "s", label: "call" }],
  }),
  state: (subtitle) => buildState({
    title: "T", subtitle,
    text: `[*] -> draft: create\ndraft -> done: finish\ndone "Done" final`,
  }),
  sitemap: (subtitle) => buildSitemap({
    title: "T", subtitle,
    text: `root "Root"\n  a "A"\n  b "B"`,
  }),
};

/** Long enough to wrap on any frame these fixtures produce. */
const LONG =
  "Suy ra từ mười hai artboard trên trang này cộng với mô hình mà sơ đồ luồng người dùng " +
  "lead-management đã lưu lại, dựng ngược từ mã nguồn đang chạy thật trên production";

describe.each(Object.keys(BUILD))("%s", (kind) => {
  const top = TOP[kind]!;
  const build = BUILD[kind]!;

  it("starts its first row at 96 under a one-line subtitle", () => {
    // The number every kind used as a constant. It has to survive the change,
    // or seven diagrams' worth of drawings quietly move.
    expect(top(build("Một dòng").draw)).toBe(96);
  });

  it("pushes the drawing DOWN for a subtitle that wraps, instead of under it", () => {
    const short = build("Ngắn");
    const long = build(LONG);
    expect(top(long.draw), `${kind} drew its first row over the subtitle`).toBeGreaterThan(
      top(short.draw),
    );
    // And the frame grew with it, rather than the content being pushed out of
    // the bottom of a frame that stayed the same height.
    expect(long.draw.h).toBeGreaterThan(short.draw.h);
  });

  it("leaves the first row clear of the subtitle's last line", () => {
    const d = build(LONG).draw;
    const lines = Math.round((top(d) - 96) / 18) + 1;
    const subtitleBottom = 56 + lines * 18;
    expect(top(d), `${kind}: the first row starts inside the subtitle`).toBeGreaterThanOrEqual(
      subtitleBottom,
    );
  });

  it("reserves less when there is no subtitle", () => {
    expect(top(build("").draw)).toBeLessThan(96);
  });
});
