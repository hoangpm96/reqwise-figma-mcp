import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeBase64, encodeBase64 } from "../../src/plugin/base64.js";

// Node has Buffer, so we can cross-check the pure implementation against it.
// Note: in Node, atob/btoa exist as globals, so the native path is what runs
// here; the pure path is exercised via direct byte-pattern assertions below.

function roundTrip(bytes: number[]): void {
  const input = new Uint8Array(bytes);
  const b64 = encodeBase64(input);
  expect(b64).toBe(Buffer.from(input).toString("base64"));
  expect(Array.from(decodeBase64(b64))).toEqual(bytes);
}

describe("base64", () => {
  it("round-trips empty, 1, 2, 3 byte inputs (padding cases)", () => {
    roundTrip([]);
    roundTrip([0x41]);
    roundTrip([0x41, 0x42]);
    roundTrip([0x41, 0x42, 0x43]);
  });

  it("round-trips binary data including zero and 0xff bytes", () => {
    const bytes = Array.from({ length: 256 }, (_, i) => i);
    roundTrip(bytes);
  });

  it("decodes data: URI prefixes and whitespace", () => {
    const b64 = Buffer.from("hello").toString("base64");
    expect(Array.from(decodeBase64(`data:image/png;base64,${b64}`))).toEqual(
      Array.from(Buffer.from("hello")),
    );
    expect(Array.from(decodeBase64(`${b64.slice(0, 4)}\n${b64.slice(4)}`))).toEqual(
      Array.from(Buffer.from("hello")),
    );
  });

  it("rejects invalid characters", () => {
    expect(() => decodeBase64("ab*d")).toThrow();
  });
});

describe("base64 pure fallback (Figma main thread has no atob/btoa)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("round-trips without native atob/btoa", () => {
    vi.stubGlobal("atob", undefined);
    vi.stubGlobal("btoa", undefined);
    const bytes = new Uint8Array(Array.from({ length: 256 }, (_, i) => i));
    const b64 = encodeBase64(bytes);
    expect(b64).toBe(Buffer.from(bytes).toString("base64"));
    expect(Array.from(decodeBase64(b64))).toEqual(Array.from(bytes));
  });

  it("handles padding variants without native atob", () => {
    vi.stubGlobal("atob", undefined);
    for (const s of ["A", "AB", "ABC", "ABCD", "hello world!"]) {
      const b64 = Buffer.from(s).toString("base64");
      expect(Buffer.from(decodeBase64(b64)).toString()).toBe(s);
    }
  });
});
