import { describe, expect, it } from "vitest";
import { textWidth, wrapToWidth } from "../../src/shared/diagram/metrics.js";

/**
 * `wrapToWidth` carries a running width instead of re-measuring every trial
 * candidate, which took it from quadratic to linear on long tokens. The
 * optimisation is only worth having if it wraps IDENTICALLY, and "identically"
 * is not something a handful of hand-picked cases can establish — a greedy
 * wrap changes its mind at one character.
 *
 * So the naive version lives here, and the fast one is held to it over a
 * corpus. If this ever goes red, the fast path is wrong, not the slow one.
 */
function naive(line: string, maxPx: number, size: number): string[] {
  const fits = (s: string): boolean => textWidth(s, size) <= maxPx;
  const words: string[] = [];
  for (const w of line.split(" ")) {
    if (!w) continue;
    if (fits(w)) {
      words.push(w);
      continue;
    }
    let piece = "";
    for (const ch of w) {
      if (piece && !fits(piece + ch)) {
        words.push(piece);
        piece = ch;
      } else piece += ch;
    }
    if (piece) words.push(piece);
  }
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && !fits(next)) {
      out.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) out.push(cur);
  return out.length ? out : [""];
}

/** Deterministic, so a failure is reproducible rather than "it went red once". */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const ALPHABET = [
  ..."abcdefghijklmnopqrstuvwxyz",
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  ..."0123456789",
  ..." .,:;'|!()[]/-",
  // Vietnamese, which is what this repo actually draws, plus the wide and
  // pictographic branches of the width table.
  ..."ếàảãạăâđêìíòóôơùúưỳýỹ",
  ..."日本語한국어",
  ..."😀→—",
];

describe("wrapToWidth", () => {
  it("wraps exactly as the naive re-measuring version does", () => {
    const rand = rng(20260911);
    const SIZES = [10, 11, 12, 13, 14, 20, 28];
    for (let i = 0; i < 4000; i++) {
      const len = 1 + Math.floor(rand() * 60);
      let line = "";
      for (let j = 0; j < len; j++) {
        line += ALPHABET[Math.floor(rand() * ALPHABET.length)]!;
      }
      const size = SIZES[Math.floor(rand() * SIZES.length)]!;
      const maxPx = 20 + Math.floor(rand() * 400);
      expect(
        wrapToWidth(line, maxPx, size),
        `wrap differs at size ${size}, maxPx ${maxPx}, line ${JSON.stringify(line)}`,
      ).toEqual(naive(line, maxPx, size));
    }
  });

  it("agrees on the shapes that break greedy wrapping", () => {
    const CASES: Array<[string, number, number]> = [
      ["", 100, 12],
      [" ", 100, 12],
      ["   ", 100, 12],
      ["a", 1, 12],
      ["a".repeat(300), 40, 12],
      ["aaa bbb ccc", 0, 12],
      ["word ".repeat(50).trim(), 120, 11],
      ["Đặt vé xe khách về quê dịp Tết cho cả gia đình", 140, 12],
      ["日本語のテキストは折り返しが違う", 60, 12],
      ["supercalifragilisticexpialidocious and then some", 55, 14],
      ["a b", 6, 12],
    ];
    for (const [line, maxPx, size] of CASES) {
      expect(wrapToWidth(line, maxPx, size), JSON.stringify(line)).toEqual(
        naive(line, maxPx, size),
      );
    }
  });

  it("no longer costs a re-measure per character on a long token", () => {
    // The behavioural guard is above; this is the reason for the change.
    // A 20,000-character unbroken token was ~200M character inspections
    // before, which is seconds, not milliseconds.
    const started = Date.now();
    const lines = wrapToWidth("x".repeat(20_000), 120, 12);
    expect(lines.length).toBeGreaterThan(100);
    expect(Date.now() - started, "a long token still wraps quadratically").toBeLessThan(500);
  });
});
