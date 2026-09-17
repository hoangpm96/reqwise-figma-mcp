import { describe, expect, it } from "vitest";
import { buildSequence, parseSequenceText } from "../../src/shared/sequence/index.js";
import type { SequenceSpec } from "../../src/shared/sequence/types.js";

/**
 * The compact form has to say EXACTLY what the JSON says — same draw data,
 * same findings. If the two ever diverge, the cheap door is a different tool
 * wearing the same name, and the agent that used it drew something else.
 */

const TEXT = `
actor user "User"
participant web "Web app" / browser
participant api "Booking API" / booking-svc
db store "Bookings DB" / postgres
external psp "Payment Gateway"

user ->> web: Confirm order, pay by credit card
web ->> api: POST /bookings/{id}/payments { method: card }
api ->> store: INSERT payments(attempt_no=n, status=pending)
store -->> api: paymentId
loop retry payment, up to 3 attempts
  api ->> psp: POST /charges { amount, idempotency_key }
  note: timeout not specified
  alt payment succeeded
    psp -->> api: 200 { status: succeeded, txn_ref }
    api -->> web: 200 { ticketId, qrCode }
    web -->> user: Display the QR code
  else payment declined
    psp -->> api: 402 card_declined !err
    api -->> web: 402 payment_failed (attempt n of 3) !err
    web -->> user: Show error, offer retry !err
  end
end
`;

const JSON_TWIN: SequenceSpec = {
  title: "Pay",
  participants: [
    { id: "user", name: "User", kind: "actor" },
    { id: "web", name: "Web app", detail: "browser" },
    { id: "api", name: "Booking API", detail: "booking-svc" },
    { id: "store", name: "Bookings DB", detail: "postgres", kind: "db" },
    { id: "psp", name: "Payment Gateway", kind: "external" },
  ],
  messages: [
    { id: "m1", from: "user", to: "web", label: "Confirm order, pay by credit card" },
    { id: "m2", from: "web", to: "api", label: "POST /bookings/{id}/payments { method: card }" },
    { id: "m3", from: "api", to: "store", label: "INSERT payments(attempt_no=n, status=pending)" },
    { id: "m4", from: "store", to: "api", label: "paymentId", kind: "return" },
    { id: "m5", from: "api", to: "psp", label: "POST /charges { amount, idempotency_key }", note: "timeout not specified" },
    { id: "m6", from: "psp", to: "api", label: "200 { status: succeeded, txn_ref }", kind: "return" },
    { id: "m7", from: "api", to: "web", label: "200 { ticketId, qrCode }", kind: "return" },
    { id: "m8", from: "web", to: "user", label: "Display the QR code", kind: "return" },
    { id: "m9", from: "psp", to: "api", label: "402 card_declined", kind: "return", cls: "error" },
    { id: "m10", from: "api", to: "web", label: "402 payment_failed (attempt n of 3)", kind: "return", cls: "error" },
    { id: "m11", from: "web", to: "user", label: "Show error, offer retry", kind: "return", cls: "error" },
  ],
  // Outermost first, the way a person lists them.
  fragments: [
    {
      kind: "loop",
      label: "retry payment, up to 3 attempts",
      messages: ["m5", "m6", "m7", "m8", "m9", "m10", "m11"],
    },
    {
      kind: "alt",
      label: "payment succeeded",
      messages: ["m6", "m7", "m8"],
      else: { label: "payment declined", messages: ["m9", "m10", "m11"] },
    },
  ],
};

describe("the compact sequence form", () => {
  it("parses to the same model the JSON spells out", () => {
    const p = parseSequenceText(TEXT);
    expect(p.warnings).toEqual([]);
    expect(p.participants).toEqual(JSON_TWIN.participants);
    expect(p.messages).toEqual(JSON_TWIN.messages);
    // Blocks are written where they apply, so the id-lists are derived — and
    // they come back outermost-first, matching how the JSON form lists them.
    expect(p.fragments).toEqual(JSON_TWIN.fragments);
  });

  it("draws the same thing, down to the geometry", () => {
    const fromText = buildSequence({ title: "Pay", text: TEXT });
    const fromJson = buildSequence(JSON_TWIN);
    expect(fromText.warnings).toEqual(fromJson.warnings);
    expect(fromText.stats).toEqual(fromJson.stats);
    expect(fromText.draw).toEqual(fromJson.draw);
  });

  it("costs a fraction of the tokens", () => {
    const json = JSON.stringify({ participants: JSON_TWIN.participants, messages: JSON_TWIN.messages, fragments: JSON_TWIN.fragments });
    expect(TEXT.length).toBeLessThan(json.length * 0.55);
  });

  it("reports a participant it had to invent instead of drawing it silently", () => {
    const p = parseSequenceText(`actor u "User"\nu ->> ghost: hello`);
    expect(p.participants.map((x) => x.id)).toEqual(["u", "ghost"]);
    expect(p.warnings.join(" ")).toContain('"ghost" was never declared');
  });

  it("reports a block nobody closed, and an else with no block", () => {
    const p = parseSequenceText(`actor u "U"\nparticipant a "A"\nalt one\nu ->> a: hi`);
    expect(p.warnings.join(" ")).toContain("never closed");
    expect(parseSequenceText(`else nope`).warnings.join(" ")).toContain("no open block");
  });

  it("says so when a line makes no sense, rather than dropping it", () => {
    const p = parseSequenceText(`actor u "U"\nthis is not a message`);
    expect(p.warnings.join(" ")).toContain("not understood");
  });

  it("takes the text over the arrays, and says which won", () => {
    const b = buildSequence({ title: "x", text: `actor u "U"\nparticipant a "A"\nu ->> a: hi`, messages: [{ id: "z", from: "u", to: "a", label: "ignored" }] });
    expect(b.warnings.join(" ")).toContain("the text won");
    expect(b.stats.messages).toBe(1);
  });
});

describe("mermaid written the way mermaid is written", () => {
  it("reads arrows with no spaces around them", () => {
    // `db-->>api:` is the normal way to type it, and a greedy sender group
    // ate the arrow's first dash — inventing a participant called "db-".
    const p = parseSequenceText(`participant db "DB"\nparticipant api "API"\ndb-->>api: paymentId\napi->>db: INSERT`);
    expect(p.warnings).toEqual([]);
    expect(p.messages).toEqual([
      { id: "m1", from: "db", to: "api", label: "paymentId", kind: "return" },
      { id: "m2", from: "api", to: "db", label: "INSERT" },
    ]);
  });

  it("still reads an id with a dash in it", () => {
    const p = parseSequenceText(`participant web-app "Web"\nparticipant api "API"\nweb-app-->>api: ok`);
    expect(p.warnings).toEqual([]);
    expect(p.messages[0]).toMatchObject({ from: "web-app", to: "api", kind: "return" });
  });
});
