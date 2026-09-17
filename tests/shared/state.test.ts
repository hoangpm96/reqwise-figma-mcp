import { describe, expect, it } from "vitest";
import { buildState, checkState, reflowState, transitionLabel } from "../../src/shared/state/index.js";
import type { StateSpec } from "../../src/shared/state/types.js";

/**
 * A state machine. The drawing is the easy half — the tests that matter are
 * the proof-reading ones, because every finding here is a bug that would
 * otherwise be found in code: a value nothing can reach, a record that gets
 * stuck, two transitions racing on one event.
 *
 * And the rule the sequence checker taught us: a proof-reader is only worth
 * having if it is QUIET when the machine is right. That is its own test.
 */

const loan = (over: Partial<StateSpec> = {}): StateSpec => ({
  title: "Vòng đời hợp đồng vay",
  states: [
    { id: "begin", kind: "initial" },
    { id: "draft", label: "Nháp", entry: "tạo mã HĐ" },
    { id: "review", label: "Chờ duyệt", do: "chấm điểm tín dụng" },
    { id: "signed", label: "Đã ký", cls: "happy" },
    { id: "rejected", label: "Bị từ chối", kind: "final", cls: "error" },
    { id: "done", label: "Đã tất toán", kind: "final", cls: "happy" },
  ],
  transitions: [
    { from: "begin", to: "draft" },
    { from: "draft", to: "review", event: "Gửi duyệt", guard: "đủ hồ sơ", action: "notify(QLTD)" },
    { from: "draft", to: "draft", event: "Lưu nháp" },
    { from: "review", to: "signed", event: "Duyệt" },
    { from: "review", to: "rejected", event: "Từ chối", cls: "error" },
    { from: "review", to: "draft", event: "Yêu cầu bổ sung", kind: "return" },
    { from: "signed", to: "done", event: "Trả hết nợ" },
  ],
  ...over,
});

const node = (b: ReturnType<typeof buildState>, id: string) =>
  b.draw.states.find((s) => s.id === id)!;
const edge = (b: ReturnType<typeof buildState>, id: string) =>
  b.draw.edges.find((e) => e.id === id)!;

describe("a state machine", () => {
  const built = buildState(loan());

  it("says nothing at all about a machine that is right", () => {
    expect(built.warnings).toEqual([]);
  });

  it("runs the lifecycle along the flow, starting at the dot", () => {
    const begin = node(built, "begin");
    expect(begin.at.x).toBeLessThan(node(built, "draft").at.x);
    expect(node(built, "draft").at.x).toBeLessThan(node(built, "review").at.x);
    expect(node(built, "signed").at.x).toBeLessThan(node(built, "done").at.x);
    // The starting dot is a dot: square, small, and filled.
    expect(begin.at.w).toBe(begin.at.h);
    expect(begin.at.w).toBeLessThan(30);
    expect(begin.strokeWeight).toBe(0);
  });

  it("draws a final state as a ring — two circles, not one", () => {
    const done = node(built, "done");
    expect(done.inner).toBeTruthy();
    expect(done.inner!.w).toBeLessThan(done.at.w);
    // Concentric.
    expect(done.inner!.x + done.inner!.w / 2).toBeCloseTo(done.at.x + done.at.w / 2, 0);
    expect(done.inner!.y + done.inner!.h / 2).toBeCloseTo(done.at.y + done.at.h / 2, 0);
    // And its name is drawn beside it: a 26px ring has no room inside.
    expect(done.outside).toBeTruthy();
  });

  it("gives a state with behaviour a second compartment under a rule", () => {
    const draft = node(built, "draft");
    expect(draft.body).toEqual(["entry / tạo mã HĐ"]);
    expect(draft.ruleY).toBeGreaterThan(0);
    // The rule sits below the name and above the body, inside the box.
    expect(draft.ruleY!).toBeLessThan(draft.at.h);
    // A state with no entry/do/exit gets no rule at all.
    expect(node(built, "signed").body).toEqual([]);
    expect(node(built, "signed").ruleY).toBeUndefined();
  });

  it("writes a transition the UML way: event [guard] / action", () => {
    expect(transitionLabel({ from: "a", to: "b", event: "Gửi duyệt", guard: "đủ hồ sơ", action: "notify(x)" }))
      .toBe("Gửi duyệt [đủ hồ sơ] / notify(x)");
    expect(transitionLabel({ from: "a", to: "b", event: "Duyệt" })).toBe("Duyệt");
    expect(transitionLabel({ from: "a", to: "b", guard: "quá hạn" })).toBe("[quá hạn]");
    expect(transitionLabel({ from: "a", to: "b", action: "log()" })).toBe("/ log()");
    expect(edge(built, "draft->review").label!.text).toContain("[đủ hồ sơ]");
  });

  it("loops a self-transition out of its own state and back", () => {
    const self = edge(built, "draft->draft");
    const box = node(built, "draft").at;
    expect(self.points.length).toBeGreaterThan(2);
    // It leaves and arrives on the same box, and bulges outside it.
    const outside = self.points.some(
      ([x, y]) => x < box.x || x > box.x + box.w || y < box.y || y > box.y + box.h,
    );
    expect(outside).toBe(true);
  });

  it("dashes a way back and leaves the forward path alone", () => {
    expect(edge(built, "review->draft").dashed).toBe(true);
    expect(edge(built, "draft->review").dashed).toBe(false);
  });

  it("leaves a crossing label room in the gap instead of on a state", () => {
    // The gap between two ranks is sized by the label that crosses it; a fixed
    // corridor put "Bấm Ký hợp đồng [đủ hồ sơ] / gửi OTP" on top of a box.
    const long = buildState(
      loan({
        transitions: (loan().transitions ?? []).map((t) =>
          t.from === "draft" && t.to === "review"
            ? { ...t, event: "Bấm Ký hợp đồng", guard: "đủ hồ sơ và đã eKYC", action: "gửi OTP qua SMS" }
            : t,
        ),
      }),
    );
    const label = long.draw.edges.find((e) => e.id === "draft->review")!.label!;
    const rect = { x: label.x, y: label.y, w: label.w, h: label.h };
    for (const s of long.draw.states) {
      const clear =
        rect.x + rect.w <= s.at.x ||
        rect.x >= s.at.x + s.at.w ||
        rect.y + rect.h <= s.at.y ||
        rect.y >= s.at.y + s.at.h;
      expect(clear, `label sits on "${s.id}"`).toBe(true);
    }
  });

  it("meets a dot and a ring at the middle of a face, where the circle is", () => {
    // A circle touches its bounding box at exactly ONE point per side, so an
    // arrow spread along the face lands on empty space and clips the curve.
    for (const e of built.draw.edges) {
      const [from, to] = e.id.split("->") as [string, string];
      const end = e.points[e.points.length - 1]!;
      const start = e.points[0]!;
      for (const [id, at] of [[to, end], [from, start]] as const) {
        const s = node(built, id);
        if (s.kind !== "initial" && s.kind !== "final") continue;
        const cx = s.at.x + s.at.w / 2;
        const cy = s.at.y + s.at.h / 2;
        // On one of the four face midpoints: one coordinate is the centre.
        const onMid = Math.abs(at[0] - cx) < 0.6 || Math.abs(at[1] - cy) < 0.6;
        expect(onMid, `${e.id} meets "${id}" at ${at} (centre ${cx},${cy})`).toBe(true);
      }
    }
  });

  it("counts the text drawn beside a dot as part of the frame", () => {
    for (const s of built.draw.states) {
      if (!s.outside) continue;
      expect(s.outside.at.x, s.id).toBeGreaterThanOrEqual(0);
      expect(s.outside.at.x + s.outside.at.w, s.id).toBeLessThanOrEqual(built.draw.w);
      expect(s.outside.at.y + s.outside.at.h, s.id).toBeLessThanOrEqual(built.draw.h);
    }
  });

  it("re-routes from where the states are now, and moves nothing back", () => {
    const graph = built.draw.graph!;
    const placed = new Map(graph.nodes.map((n) => [n.id, n.at]));
    const still = reflowState(graph, placed);
    expect(still.moved).toEqual([]);

    const review = graph.nodes.find((n) => n.id === "review")!;
    placed.set("review", { ...review.at, y: review.at.y + 180 });
    const after = reflowState(graph, placed);
    expect(after.moved).toEqual(["review"]);
    const moved = after.edges.find((e) => e.id === "draft->review")!;
    const end = moved.points[moved.points.length - 1]!;
    expect(end[1]).toBeGreaterThan(review.at.y + 100);
  });
});

describe("the state proof-reader", () => {
  const warn = (over: Partial<StateSpec>): string[] =>
    checkState(loan(over).states!, loan(over).transitions ?? []).warnings;

  it("finds a state nothing can reach", () => {
    const found = warn({
      states: loan().states!.concat([{ id: "frozen", label: "Đóng băng" }]),
      transitions: (loan().transitions ?? []).concat([{ from: "frozen", to: "done", event: "Mở" }]),
    });
    expect(found.join(" ")).toContain("Unreachable");
    expect(found.join(" ")).toContain("Đóng băng");
  });

  it("finds a state the record can never leave", () => {
    const found = warn({
      transitions: (loan().transitions ?? []).filter((t) => t.from !== "signed"),
    });
    expect(found.join(" ")).toContain("No way out of");
    expect(found.join(" ")).toContain("Đã ký");
  });

  it("finds two transitions racing on one event", () => {
    const found = warn({
      transitions: (loan().transitions ?? []).concat([
        { from: "review", to: "done", event: "Duyệt" },
      ]),
    });
    expect(found.join(" ")).toContain("Duyệt");
    expect(found.join(" ")).toContain("no guard");
  });

  it("stays quiet when those two are told apart by a guard", () => {
    const found = warn({
      transitions: (loan().transitions ?? [])
        .map((t) => (t.from === "review" && t.to === "signed" ? { ...t, guard: "đủ hạn mức" } : t))
        .concat([{ from: "review", to: "done", event: "Duyệt", guard: "vay 0 đồng" }]),
    });
    expect(found).toEqual([]);
  });

  it("finds a final state with a way out, and a transition back into the start", () => {
    const found = warn({
      transitions: (loan().transitions ?? []).concat([
        { from: "done", to: "draft", event: "Vay lại" },
        { from: "signed", to: "begin", event: "Huỷ" },
      ]),
    });
    expect(found.join(" ")).toContain("Final state with a way out");
    expect(found.join(" ")).toContain("Transition INTO an initial state");
  });

  it("wants to know what triggers a transition — unless the source has a `do`", () => {
    // `review` HAS a do activity, so an unlabelled exit is UML's completion
    // transition and reads fine; `signed` does not.
    const found = warn({
      transitions: (loan().transitions ?? []).map((t) =>
        t.from === "signed" ? { from: t.from, to: t.to } : t,
      ),
    });
    const line = found.find((w) => w.startsWith("Transition with no event"))!;
    expect(line).toContain("Đã ký");
    expect(line).not.toContain("Chờ duyệt");
  });

  it("wants every branch of a choice labelled, but allows one else", () => {
    const withChoice = (guards: Array<string | undefined>): string[] =>
      checkState(
        [
          { id: "begin", kind: "initial" },
          { id: "check", label: "Đủ điều kiện?", kind: "choice" },
          { id: "yes", label: "Cho vay", kind: "final" },
          { id: "no", label: "Từ chối", kind: "final" },
        ],
        [
          { from: "begin", to: "check" },
          { from: "check", to: "yes", ...(guards[0] ? { guard: guards[0] } : {}) },
          { from: "check", to: "no", ...(guards[1] ? { guard: guards[1] } : {}) },
        ],
      ).warnings;
    expect(withChoice(["điểm ≥ 600", undefined])).toEqual([]);
    expect(withChoice([undefined, undefined]).join(" ")).toContain("no [guard]");
  });

  it("reports a missing initial state and a fork with nothing to rejoin it", () => {
    const found = checkState(
      [
        { id: "a", label: "A" },
        { id: "f", kind: "fork" },
        { id: "b", label: "B", kind: "final" },
        { id: "c", label: "C", kind: "final" },
      ],
      [
        { from: "a", to: "f", event: "Bắt đầu" },
        { from: "f", to: "b" },
        { from: "f", to: "c" },
      ],
    ).warnings.join(" ");
    expect(found).toContain("No initial state");
    expect(found).toContain("fork(s) and no join");
  });

  it("drops a transition that names a state nobody declared", () => {
    const res = checkState(loan().states!, (loan().transitions ?? []).concat([
      { from: "draft", to: "ghost", event: "?" },
    ]));
    expect(res.transitions.some((t) => t.to === "ghost")).toBe(false);
    expect(res.warnings.join(" ")).toContain('"ghost"');
  });
});

describe("findings about [*]", () => {
  it("name it as written, not by the tool's internal id", () => {
    const b = buildState({ title: "T", text: "[*] -> held\nheld -> paid: Pay\npaid -> [*]" } as never);
    const all = b.warnings.join(" ");
    expect(all).not.toMatch(/__end|__start/);
  });
});
