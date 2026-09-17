import { describe, expect, it } from "vitest";
import { buildSequence, checkSequence } from "../../src/shared/sequence/index.js";
import { reflowSequence } from "../../src/shared/sequence/layout.js";
import type { SequenceSpec } from "../../src/shared/sequence/types.js";

/**
 * A sequence diagram. Its geometry is a grid — participants are columns, the
 * order of the messages is the time axis — so the tests are about the grid
 * holding: arrows spanning the right columns, bars covering the right rows,
 * fragments covering the right run, and none of it moving when a column does.
 */

const otp = (over: Partial<SequenceSpec> = {}): SequenceSpec => ({
  title: "Ký hợp đồng bằng OTP",
  participants: [
    { id: "kh", name: "Khách hàng", kind: "actor" },
    { id: "app", name: "App", detail: "mobile" },
    { id: "los", name: "LOS", detail: "loan-svc" },
    { id: "sms", name: "SMS gateway", kind: "external" },
  ],
  messages: [
    { id: "m1", from: "kh", to: "app", label: "Bấm Ký hợp đồng" },
    { id: "m2", from: "app", to: "los", label: "POST /sign-otp" },
    { id: "m3", from: "los", to: "sms", label: "sendOtp(phone, code)", kind: "async" },
    { id: "m4", from: "los", to: "app", label: "202 otpSent", kind: "return" },
    { id: "m5", from: "kh", to: "app", label: "Nhập 6 số" },
    { id: "m6", from: "app", to: "los", label: "POST /verify-otp" },
    { id: "m7", from: "los", to: "app", label: "200 signed", kind: "return" },
    { id: "m8", from: "los", to: "app", label: "409 wrong_otp", kind: "return", cls: "error" },
  ],
  fragments: [
    { kind: "alt", label: "OTP đúng", messages: ["m7"], else: { label: "OTP sai", messages: ["m8"] } },
  ],
  ...over,
});

const party = (b: ReturnType<typeof buildSequence>, id: string) =>
  b.draw.participants.find((p) => p.id === id)!;
const msg = (b: ReturnType<typeof buildSequence>, id: string) =>
  b.draw.messages.find((m) => m.id === id)!;

describe("a sequence diagram", () => {
  const built = buildSequence(otp());

  it("puts the participants in the order they were given, on one line", () => {
    const xs = built.draw.participants.map((p) => p.at.x);
    expect(built.draw.participants.map((p) => p.id)).toEqual(["kh", "app", "los", "sms"]);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    // Heads share a height, so every lifeline starts on the same line.
    const tops = built.draw.participants.map((p) => p.lifeline.y);
    expect(new Set(tops).size).toBe(1);
  });

  it("runs time downwards, in the order the messages were written", () => {
    const ys = built.draw.messages.map((m) => m.points[0]![1]);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
  });

  it("spans each arrow between the two lifelines it belongs to", () => {
    const m2 = msg(built, "m2");
    expect(m2.points[0]![0]).toBeCloseTo(party(built, "app").lifelineX + 5, 0);
    expect(m2.points[1]![0]).toBeCloseTo(party(built, "los").lifelineX - 5, 0);
    // A reply runs the other way.
    const m4 = msg(built, "m4");
    expect(m4.points[0]![0]).toBeGreaterThan(m4.points[1]![0]);
  });

  it("draws a call filled and a reply dashed and open", () => {
    expect(msg(built, "m2").cap).toBe("filled");
    expect(msg(built, "m2").dashed).toBe(false);
    expect(msg(built, "m4").cap).toBe("line");
    expect(msg(built, "m4").dashed).toBe(true);
    expect(msg(built, "m3").cap).toBe("line"); // async
    expect(msg(built, "m3").dashed).toBe(false);
  });

  it("derives an activation bar from a call and its reply", () => {
    // m2 calls LOS, m4 replies: the bar covers exactly that stretch.
    const bar = built.draw.activations.find((b) => b.id === "m2")!;
    expect(bar.participant).toBe("los");
    expect(bar.at.y).toBeLessThan(msg(built, "m2").points[0]![1]);
    expect(bar.at.y + bar.at.h).toBeGreaterThan(msg(built, "m4").points[0]![1]);
    expect(bar.at.x).toBeCloseTo(party(built, "los").lifelineX - 5, 0);
  });

  it("gives a participant ONE bar per stretch of work, not one per tap", () => {
    // Both taps are unanswered calls from a person, and App works straight
    // through them: two bars covering nearly the same rows is what the first
    // version drew, and it read as a duplicate on the canvas.
    const onApp = built.draw.activations.filter((b) => b.participant === "app");
    expect(onApp.length).toBe(1);
    const bar = onApp[0]!;
    expect(bar.at.y).toBeLessThan(msg(built, "m1").points[0]![1]);
    // It ends with App's last message, not at the bottom of the diagram.
    expect(bar.at.y + bar.at.h).toBeLessThan(built.draw.h);
  });

  it("steps a nested bar sideways instead of hiding it", () => {
    // SMS calls back into LOS while LOS is still inside App's call: one
    // lifeline, two bars running at once.
    const nested = buildSequence(
      otp({
        messages: [
          { id: "n1", from: "app", to: "los", label: "POST /sign" },
          { id: "n2", from: "los", to: "sms", label: "sendOtp()" },
          { id: "n3", from: "sms", to: "los", label: "delivered(id)" },
          { id: "n4", from: "los", to: "sms", label: "ack", kind: "return" },
          { id: "n5", from: "los", to: "app", label: "200 signed", kind: "return" },
        ],
        fragments: [],
      }),
    );
    const onLos = nested.draw.activations.filter((b) => b.participant === "los");
    expect(onLos.map((b) => b.id)).toEqual(["n1", "n3"]);
    const [outer, inner] = onLos as [typeof onLos[0], typeof onLos[0]];
    expect(inner.at.y).toBeGreaterThan(outer.at.y);
    expect(inner.at.y + inner.at.h).toBeLessThan(outer.at.y + outer.at.h);
    // Stepped sideways so the inner one is not swallowed by the outer.
    expect(inner.at.x).toBeGreaterThan(outer.at.x);
  });

  it("opens the fragment box above a two-line label, not through it", () => {
    const tall = buildSequence(
      otp({
        messages: [
          { id: "t1", from: "app", to: "los", label: "POST /disbursements { contractId, amount }" },
          { id: "t2", from: "los", to: "app", label: "201 { coreRef }", kind: "return" },
        ],
        fragments: [{ kind: "opt", label: "đủ hạn mức", messages: ["t1", "t2"] }],
      }),
    );
    const frag = tall.draw.fragments[0]!;
    const t1 = tall.draw.messages.find((m) => m.id === "t1")!;
    expect(t1.label.h).toBeGreaterThan(20); // it did wrap to two lines
    expect(frag.at.y).toBeLessThan(t1.label.y);
  });

  it("keeps the else divider and its label clear of the message label", () => {
    const frag = built.draw.fragments[0]!;
    const m8 = msg(built, "m8");
    // The label of the else branch's first message sits BELOW the divider —
    // the divider used to be dropped into the 26px above the arrow, which is
    // exactly where that label lives.
    expect(frag.divider!.y).toBeLessThan(m8.label.y);
    // And the divider's own label, drawn just above the line, clears it too.
    expect(frag.divider!.y - 8 + 16).toBeLessThan(m8.label.y);
  });

  it("boxes the alt around its branches, with the else divider between them", () => {
    const frag = built.draw.fragments[0]!;
    expect(frag.kind).toBe("alt");
    expect(frag.at.y).toBeLessThan(msg(built, "m7").points[0]![1]);
    expect(frag.at.y + frag.at.h).toBeGreaterThan(msg(built, "m8").points[0]![1]);
    expect(frag.divider!.y).toBeGreaterThan(msg(built, "m7").points[0]![1]);
    expect(frag.divider!.y).toBeLessThan(msg(built, "m8").points[0]![1]);
    expect(frag.divider!.label).toBe("OTP sai");
  });

  it("widens a column gap so its labels fit", () => {
    const wide = buildSequence(
      otp({
        messages: [
          {
            id: "m1",
            from: "kh",
            to: "app",
            label: "một nhãn rất dài để ép cột phải giãn ra cho vừa",
          },
        ],
        fragments: [],
      }),
    );
    const gap = party(wide, "app").at.x - (party(wide, "kh").at.x + party(wide, "kh").at.w);
    expect(gap).toBeGreaterThan(msg(wide, "m1").label.w - 40);
  });

  it("keeps a clean exchange quiet", () => {
    expect(built.warnings).toEqual([]);
    expect(built.stats).toMatchObject({ participants: 4, messages: 8, returns: 3, fragments: 1 });
  });
});

describe("the proof-read", () => {
  it("does NOT call the else branch's reply an orphan", () => {
    // Both m7 and m8 answer m6 — they are alternative timelines. The first cut
    // of this check reported the else branch as a reply with no call.
    const res = buildSequence(otp());
    expect(res.warnings.join(" ")).not.toContain("no call to answer");
  });

  it("does NOT expect a reply to a person tapping a button", () => {
    const res = buildSequence(otp());
    expect(res.warnings.join(" ")).not.toContain('"m1"');
  });

  it("does NOT expect a reply to a participant's own work", () => {
    // A self-message is internal processing: "generate the code", "recompute
    // the score". Nobody answers it and nothing waits for it.
    const res = checkSequence(
      [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ],
      [
        { id: "m1", from: "a", to: "b", label: "call" },
        { id: "m2", from: "b", to: "b", label: "sinh mã" },
        { id: "m3", from: "b", to: "a", label: "ok", kind: "return" },
      ],
      [],
    );
    expect(res.warnings).toEqual([]);
  });

  it("names a reply that answers nothing", () => {
    const res = checkSequence(
      [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ],
      [
        { id: "m1", from: "a", to: "b", label: "call" },
        { id: "m2", from: "b", to: "a", label: "reply", kind: "return" },
        { id: "m3", from: "b", to: "a", label: "another reply", kind: "return" },
      ],
      [],
    );
    expect(res.warnings.join(" ")).toContain("Reply with no call");
  });

  it("names a system call the diagram never answers", () => {
    const res = checkSequence(
      [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
        { id: "c", name: "C" },
      ],
      [
        { id: "m1", from: "a", to: "b", label: "call b" },
        { id: "m2", from: "b", to: "a", label: "ok", kind: "return" },
        { id: "m3", from: "a", to: "c", label: "call c" },
      ],
      [],
    );
    expect(res.warnings.join(" ")).toContain('Call with no reply: "m3"');
  });

  it("asks what happens otherwise when an alt has one branch", () => {
    const res = checkSequence(
      [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ],
      [{ id: "m1", from: "a", to: "b", label: "x" }],
      [{ kind: "alt", label: "khi hợp lệ", messages: ["m1"] }],
    );
    expect(res.warnings.join(" ")).toContain("has no else");
  });

  it("refuses a fragment that skips a message in the middle", () => {
    const res = checkSequence(
      [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ],
      [
        { id: "m1", from: "a", to: "b", label: "1" },
        { id: "m2", from: "a", to: "b", label: "2" },
        { id: "m3", from: "a", to: "b", label: "3" },
      ],
      [{ kind: "loop", label: "3 lần", messages: ["m1", "m3"] }],
    );
    expect(res.warnings.join(" ")).toContain("CONTIGUOUS");
    expect(res.fragments).toEqual([]);
  });

  it("names a participant nobody talks to, and an unlabelled message", () => {
    const res = checkSequence(
      [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
        { id: "ghost", name: "Ghost" },
      ],
      [{ id: "m1", from: "a", to: "b", label: "  " }],
      [],
    );
    const all = res.warnings.join(" ");
    expect(all).toContain('Participant with no messages: "ghost"');
    expect(all).toContain("has no label");
  });
});

describe("reflowSequence", () => {
  const built = buildSequence(otp());
  const graph = built.draw.graph!;
  const asDrawn = () => new Map(graph.participants.map((p) => [p.id, { ...p.at }]));

  it("reproduces the drawn geometry when nothing has moved", () => {
    const res = reflowSequence(graph, asDrawn());
    expect(res.moved).toEqual([]);
    expect(res.messages).toEqual(built.draw.messages);
    expect(res.activations).toEqual(built.draw.activations);
    expect(res.fragments).toEqual(built.draw.fragments);
  });

  it("moves a whole column when its head is dragged", () => {
    const placed = asDrawn();
    const los = placed.get("los")!;
    placed.set("los", { ...los, x: los.x + 200 });

    const res = reflowSequence(graph, placed);
    expect(res.moved).toEqual(["los"]);
    const m2 = res.messages.find((m) => m.id === "m2")!;
    expect(m2.points[1]![0]).toBeCloseTo(los.x + 200 + los.w / 2 - 5, 0);
    // The bar on that lifeline follows it…
    const bar = res.activations.find((b) => b.id === "m2")!;
    expect(bar.at.x).toBeCloseTo(los.x + 200 + los.w / 2 - 5, 0);
    // …and the fragment that spans it stretches.
    expect(res.fragments[0]!.at.w).toBeGreaterThan(built.draw.fragments[0]!.at.w);
  });

  it("does not move anything in TIME when a column moves", () => {
    const placed = asDrawn();
    const app = placed.get("app")!;
    placed.set("app", { ...app, x: app.x - 40 });
    const res = reflowSequence(graph, placed);
    for (const m of res.messages) {
      const before = built.draw.messages.find((o) => o.id === m.id)!;
      expect(m.points[0]![1]).toBe(before.points[0]![1]);
    }
  });

  it("carries a message's note along with it", () => {
    // Live finding: dragging a column moved the self-message but left its
    // yellow note behind on the old lifeline.
    const withNote = buildSequence(
      otp({
        messages: [
          { id: "m1", from: "app", to: "los", label: "POST /sign-otp" },
          { id: "m2", from: "los", to: "los", label: "sinh mã", note: "TTL 5 phút" },
          { id: "m3", from: "los", to: "app", label: "202", kind: "return" },
        ],
        fragments: [],
      }),
    );
    const g = withNote.draw.graph!;
    const placed = new Map(g.participants.map((p) => [p.id, { ...p.at }]));
    const los = placed.get("los")!;
    placed.set("los", { ...los, x: los.x + 120 });

    const res = reflowSequence(g, placed);
    const before = withNote.draw.messages.find((m) => m.id === "m2")!;
    const after = res.messages.find((m) => m.id === "m2")!;
    expect(before.note).toBeDefined();
    expect(after.note!.x).toBeCloseTo(before.note!.x + 120, 0);
  });

  it("drops a message whose participant is gone", () => {
    const placed = asDrawn();
    placed.delete("sms");
    expect(reflowSequence(graph, placed).dropped).toEqual(["m3"]);
  });
});

describe("sequence row spacing", () => {
  it("gives a three-line label room instead of letting it climb into the row above", () => {
    // ROW is a fixed 46px, which fits two label lines. A longer label is drawn
    // above its own arrow, so it used to overlap the message before it.
    const built = buildSequence({
      title: "Long labels",
      participants: [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ],
      messages: [
        { id: "m1", from: "a", to: "b", label: "short" },
        {
          id: "m2",
          from: "a",
          to: "b",
          label: "INSERT bookings(status=held, hold_expires_at=now()+10min) + booking_seats",
        },
      ],
    });
    const [m1, m2] = built.draw.graph!.messages;
    expect(m2!.labelLines.length).toBeGreaterThan(2);
    expect(m2!.y - m1!.y).toBeGreaterThanOrEqual(m2!.lh);
  });
});

describe("sequence unanswered bars", () => {
  const tapThenCall = () =>
    buildSequence({
      title: "Tap, then a real request",
      participants: [
        { id: "u", name: "User", kind: "actor" },
        { id: "web", name: "Web app" },
        { id: "api", name: "API" },
      ],
      messages: [
        { id: "t1", from: "u", to: "web", label: "Select seats" },
        { id: "t2", from: "web", to: "api", label: "POST /holds" },
        { id: "t3", from: "api", to: "web", label: "201 held", kind: "return" },
        { id: "t4", from: "u", to: "web", label: "Confirm order" },
        { id: "t5", from: "web", to: "api", label: "POST /payments" },
        { id: "t6", from: "api", to: "web", label: "200 paid", kind: "return" },
        { id: "t7", from: "web", to: "u", label: "Show the QR code", kind: "return" },
      ],
    });

  it("ends an unanswered tap before the next answered call, not at the diagram's end", () => {
    // t1 is a tap nobody replies to; t4 IS answered (t7). Running t1's bar to
    // Web app's last appearance covered t4's whole bar and stepped it aside.
    const bars = tapThenCall().draw.activations.filter((b) => b.participant === "web");
    const tap = bars.find((b) => b.id === "t1")!;
    const answered = bars.find((b) => b.id === "t4")!;
    expect(tap.at.y + tap.at.h).toBeLessThanOrEqual(answered.at.y);
  });

  it("keeps the later bar at depth 0, so it is not drawn as a nested call", () => {
    const bars = tapThenCall().draw.activations.filter((b) => b.participant === "web");
    const xs = new Set(bars.map((b) => b.at.x));
    expect(xs.size).toBe(1);
  });
});

describe("sequence branch pairing", () => {
  // One request, three outcomes: the happy reply, the retry reply and the
  // give-up reply. They are three branches of the same run, so all three
  // answer the SAME call.
  const branchy = (): SequenceSpec => ({
    title: "Pay, retry, give up",
    participants: [
      { id: "u", name: "User", kind: "actor" },
      { id: "web", name: "Web app" },
      { id: "api", name: "API" },
      { id: "db", name: "DB", kind: "db" },
    ],
    messages: [
      { id: "t1", from: "u", to: "web", label: "Select seats" },
      { id: "t2", from: "web", to: "api", label: "POST /holds" },
      { id: "t3", from: "api", to: "web", label: "201 held", kind: "return" },
      { id: "c1", from: "u", to: "web", label: "Confirm order" },
      { id: "c2", from: "web", to: "api", label: "POST /payments" },
      { id: "ok1", from: "api", to: "web", label: "200 paid", kind: "return" },
      { id: "ok2", from: "web", to: "u", label: "Show the QR code", kind: "return" },
      { id: "no1", from: "api", to: "db", label: "UPDATE payments=failed" },
      { id: "no2", from: "db", to: "api", label: "committed", kind: "return" },
      { id: "no3", from: "api", to: "web", label: "402 declined", kind: "return" },
      { id: "no4", from: "web", to: "u", label: "Show error", kind: "return" },
      { id: "gu1", from: "api", to: "db", label: "UPDATE bookings=cancelled" },
      { id: "gu2", from: "db", to: "api", label: "seats released", kind: "return" },
      { id: "gu3", from: "api", to: "web", label: "409 cancelled", kind: "return" },
      { id: "gu4", from: "web", to: "u", label: "Show cancelled", kind: "return" },
    ],
    fragments: [
      { kind: "loop", label: "up to 3 attempts", messages: ["c2", "ok1", "ok2", "no1", "no2", "no3", "no4", "gu1", "gu2", "gu3", "gu4"] },
      {
        kind: "alt",
        label: "paid",
        messages: ["ok1", "ok2"],
        else: { label: "declined", messages: ["no1", "no2", "no3", "no4"] },
      },
      { kind: "break", label: "attempts used up", messages: ["gu1", "gu2", "gu3", "gu4"] },
    ],
  });

  it("reads the else and break replies as the same answer, not as answers to an older call", () => {
    // t1 is the tap nobody replies to. Matching no2/no4/gu4 off a stack handed
    // them t1, whose bar then ran the length of the diagram.
    const built = buildSequence(branchy());
    const tap = built.draw.activations.find((b) => b.id === "t1")!;
    const confirm = built.draw.activations.find((b) => b.id === "c1")!;
    expect(tap.at.y + tap.at.h).toBeLessThanOrEqual(confirm.at.y);
    expect(tap.at.x).toBeCloseTo(confirm.at.x, 0);
  });

  it("covers every branch's outcome with the one call's bar", () => {
    const built = buildSequence(branchy());
    const call = built.draw.activations.find((b) => b.id === "c2")!;
    const last = built.draw.messages.find((m) => m.id === "gu3")!;
    expect(call.at.y + call.at.h).toBeGreaterThanOrEqual(last.points[0]![1]);
  });

  it("still lets a reply inside a branch answer the call made in that branch", () => {
    // no2 answers no1, and gu2 answers gu1 — not the call from the branch above.
    const spec = branchy();
    const { warnings } = checkSequence(
      spec.participants ?? [],
      spec.messages ?? [],
      spec.fragments ?? [],
    );
    expect(warnings.filter((w) => w.indexOf("no reply") >= 0)).toEqual([]);
    expect(warnings.filter((w) => w.indexOf("no call to answer") >= 0)).toEqual([]);
  });
});

describe("sequence nested fragments", () => {
  // Six loops over the same self message: each one nests inside the one
  // written before it, so each steps in another level.
  const deep = (label: string, messages: SequenceSpec["messages"], on: string[]) =>
    buildSequence({
      title: "Deep nesting",
      participants: [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ],
      messages,
      fragments: Array.from({ length: 6 }, (_, i) => ({
        kind: "loop" as const,
        label: `${label}${i}`,
        messages: on,
      })),
    });

  it("never collapses a deep stack, in the layout or the reflow", () => {
    // Uncapped, the widths went 68, 52, 36, 20, 4, -12 — Figma throws on the
    // last resize. Capped at the tab alone, the deeper boxes fell back onto the
    // outermost box's edges. Now every level keeps its own edges and a width.
    const built = deep("r", [{ id: "m1", from: "a", to: "a", label: "retry" }], ["m1"]);
    const g = built.draw.graph!;
    const reflowed = reflowSequence(g, new Map(g.participants.map((p) => [p.id, { ...p.at }])));
    for (const fragments of [built.draw.fragments, reflowed.fragments]) {
      expect(fragments).toHaveLength(6);
      const byDepth = [...fragments].sort((p, q) => p.at.y - q.at.y);
      for (let i = 0; i < byDepth.length; i++) {
        expect(byDepth[i]!.at.w).toBeGreaterThanOrEqual(12);
        if (i) expect(byDepth[i]!.at.x, `level ${i} shares its parent's left edge`).toBeGreaterThan(byDepth[i - 1]!.at.x);
      }
      // The outer levels, where there is room, still fit their tab.
      expect(byDepth[0]!.at.w).toBeGreaterThanOrEqual(byDepth[0]!.tabW);
    }
    expect(reflowed.fragments).toEqual(built.draw.fragments);
  });

  it("still steps nested boxes in while there is room", () => {
    const built = deep("x", [{ id: "m1", from: "a", to: "b", label: "call" }], ["m1"]);
    const widths = built.draw.fragments.map((f) => f.at.w);
    expect(widths[1]).toBeLessThan(widths[0]!);
    expect(Math.min(...widths)).toBeGreaterThanOrEqual(
      Math.max(...built.draw.fragments.map((f) => f.tabW)),
    );
  });
});

describe("a fragment around a self-message", () => {
  it("is wide enough for the hop and its label, and nested boxes still contain each other", () => {
    const built = buildSequence({
      title: "T",
      participants: [{ id: "u", name: "User" }, { id: "api", name: "API" }, { id: "n", name: "Notifier" }],
      text: undefined,
      messages: [
        { id: "m1", from: "u", to: "api", label: "POST /pay" },
        { id: "m2", from: "api", to: "api", label: "refresh token now" },
      ],
      fragments: [
        { kind: "loop", label: "retry", messages: ["m2"] },
        { kind: "opt", label: "token expired", messages: ["m2"] },
      ],
    } as never);
    const msg = built.draw.messages.find((m) => m.id === "m2")!;
    const labelEnd = msg.label.x + msg.label.w;
    const [outer, inner] = [...built.draw.fragments].sort((a, b) => a.at.y - b.at.y);
    expect(inner!.at.x + inner!.at.w).toBeGreaterThan(labelEnd);
    expect(outer!.at.x + outer!.at.w).toBeGreaterThan(inner!.at.x + inner!.at.w);
    const g = built.draw.graph!;
    const reflowed = reflowSequence(g, new Map(g.participants.map((p) => [p.id, { ...p.at }])));
    expect(reflowed.fragments).toEqual(built.draw.fragments);
  });
});
