import { describe, it, expect } from "vitest";
import {
  assertSafeImageUrl,
  assertSafeIconName,
  safeEqualString,
} from "../../src/server/security.js";

describe("assertSafeImageUrl", () => {
  it("allows public https", () => {
    expect(assertSafeImageUrl("https://cdn.example.com/a.png").href).toContain("cdn.example.com");
  });

  it("rejects http and private hosts", () => {
    expect(() => assertSafeImageUrl("http://example.com/a.png")).toThrow(/https/);
    expect(() => assertSafeImageUrl("https://127.0.0.1/a.png")).toThrow(/private|local|blocked/i);
    expect(() => assertSafeImageUrl("https://192.168.1.10/a.png")).toThrow(/private|local/i);
    expect(() => assertSafeImageUrl("https://localhost/a.png")).toThrow(/blocked/i);
    expect(() => assertSafeImageUrl("https://metadata.google.internal/")).toThrow(/blocked/i);
  });
});

describe("assertSafeIconName", () => {
  it("allows kebab-case", () => {
    expect(assertSafeIconName("arrow-right")).toBe("arrow-right");
  });
  it("rejects path tricks", () => {
    expect(() => assertSafeIconName("../etc/passwd")).toThrow();
    expect(() => assertSafeIconName("a/b")).toThrow();
    expect(() => assertSafeIconName("a?x=1")).toThrow();
  });
});

describe("safeEqualString", () => {
  it("matches equal strings", () => {
    expect(safeEqualString("abc", "abc")).toBe(true);
    expect(safeEqualString("abc", "abd")).toBe(false);
    expect(safeEqualString("abc", "ab")).toBe(false);
  });
});
