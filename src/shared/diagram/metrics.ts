/**
 * Text metrics for Inter, calibrated against Figma's own measurement (±3% on
 * the reference deck). The layout has to know how wide a label is BEFORE the
 * plugin renders it — dagre reserves space from these numbers — so this table
 * is load-bearing: if it under-estimates, boxes overlap their own text.
 */

/** Line height per font size, matching the plugin's defaultLineHeight rounding. */
export const LINE_HEIGHT: Record<number, number> = { 20: 26, 13: 18, 12: 16, 11: 15 };

export function lineHeight(size: number): number {
  return LINE_HEIGHT[size] ?? Math.round(size * 1.38);
}

/**
 * CJK ideographs, kana and hangul are full-width: one glyph is about one em,
 * not the ~0.55em the Latin table assumes. Without this a Japanese or Korean
 * label came out ~40% narrower than it renders and the text spilled out of its
 * own box. Emoji and pictographs are wider than a letter too.
 */
function isFullWidth(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

function isPictograph(cp: number): boolean {
  return (
    (cp >= 0x2190 && cp <= 0x2bff) ||
    (cp >= 0x1f000 && cp <= 0x1faff) ||
    (cp >= 0xfe0f && cp <= 0xfe0f)
  );
}

/** True when the text needs glyphs a Latin-only family (Inter) cannot draw. */
export function needsWideCoverage(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isFullWidth(cp)) return true;
  }
  return false;
}

function charWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (isFullWidth(cp)) return 12;
  if (isPictograph(cp)) return 13;
  const b = ch.normalize("NFD")[0] ?? ch;
  if (b === " ") return 3.6;
  if ("mwMW".includes(b)) return 10.5;
  if ("ijlt.,:;'|!".includes(b)) return 4;
  if ("frI()[]/-".includes(b)) return 5;
  if (/[A-Z]/.test(b)) return 8.8;
  if (/[0-9]/.test(b)) return 7.4;
  if (/[a-z]/.test(b)) return 7.2;
  if (b === "—") return 12;
  return 7;
}

/** Rendered width of `s` at `size`px Inter, rounded up with a 6px cushion. */
export function textWidth(s: string, size: number): number {
  let sum = 0;
  for (const ch of s) sum += charWidth(ch);
  return Math.ceil(sum * (size / 13) * 1.08 + 6);
}

/**
 * Greedy word wrap at `maxChars`. A single word longer than the limit is hard-
 * split rather than left to run: an unbroken 200-character token used to size
 * one box 1364px wide and skew the whole diagram around it.
 */
export function wrapText(line: string, maxChars: number): string[] {
  const words: string[] = [];
  for (const w of line.split(" ")) {
    if (w.length <= maxChars) {
      words.push(w);
      continue;
    }
    for (let i = 0; i < w.length; i += maxChars) words.push(w.slice(i, i + maxChars));
  }
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > maxChars && cur) {
      out.push(cur);
      cur = w;
    } else {
      cur = (cur + " " + w).trim();
    }
  }
  if (cur) out.push(cur);
  return out.length ? out : [""];
}

/**
 * Greedy wrap to a PIXEL width, measured with the table above.
 *
 * `wrapText` counts characters, so every caller has to guess a
 * chars-per-pixel constant. When that guess runs optimistic the line fits the
 * count but not the box, Figma re-wraps it, and the cell grows past the height
 * the layout already reserved for it — text then sits on the row below.
 * Measuring removes the guess: what this returns is what fits.
 */
export function wrapToWidth(line: string, maxPx: number, size: number): string[] {
  // Widths ACCUMULATE rather than being re-measured.
  //
  // The obvious version calls `textWidth(candidate)` on every trial, which
  // re-sums the whole candidate each time: hard-splitting one long token
  // measured character 1..n for every n, so an unbroken 1,000-character
  // string cost ~500,000 character inspections — and the journey layouts run
  // this over every cell. `textWidth` is `ceil(sum * k + 6)` over a
  // per-character table, so carrying `sum` makes each trial O(1) and the
  // whole wrap linear. The arithmetic is the same arithmetic, in the same
  // left-to-right order, which `metrics.test.ts` pins against the naive
  // implementation over a fuzz corpus.
  const k = (size / 13) * 1.08;
  const fitsSum = (sum: number): boolean => Math.ceil(sum * k + 6) <= maxPx;
  const SPACE = charWidth(" ");

  const words: Array<{ text: string; sum: number }> = [];
  for (const w of line.split(" ")) {
    if (!w) continue;
    let wSum = 0;
    for (const ch of w) wSum += charWidth(ch);
    if (fitsSum(wSum)) {
      words.push({ text: w, sum: wSum });
      continue;
    }
    // A single word wider than the box is hard-split, one character at a
    // time, rather than left to run past the edge.
    let piece = "";
    let pieceSum = 0;
    for (const ch of w) {
      const cw = charWidth(ch);
      if (piece && !fitsSum(pieceSum + cw)) {
        words.push({ text: piece, sum: pieceSum });
        piece = ch;
        pieceSum = cw;
      } else {
        piece += ch;
        pieceSum += cw;
      }
    }
    if (piece) words.push({ text: piece, sum: pieceSum });
  }

  const out: string[] = [];
  let cur = "";
  let curSum = 0;
  for (const w of words) {
    const nextSum = cur ? curSum + SPACE + w.sum : w.sum;
    if (cur && !fitsSum(nextSum)) {
      out.push(cur);
      cur = w.text;
      curSum = w.sum;
    } else {
      cur = cur ? `${cur} ${w.text}` : w.text;
      curSum = nextSum;
    }
  }
  if (cur) out.push(cur);
  return out.length ? out : [""];
}

/** Split a label into lines the caller wrote by hand (`\n` or mermaid `<br/>`). */
export function splitLines(label: string): string[] {
  return label.split(/<br\s*\/?>|\n/).map((l) => l.trim()).filter((l) => l.length > 0);
}

/**
 * Where a diagram's first row may start, under a title block that was
 * MEASURED rather than assumed.
 *
 * Every kind draws its title at y=24 (20px) and its subtitle at y=56 (13px),
 * and every kind reserved a flat 96 for the pair — which is right for a
 * one-line subtitle and wrong for a longer one. The journey handler was bitten
 * first ("a subtitle whose height nothing downstream counted … the subtitle's
 * last line sat on the first card"), and a user caught the same thing on a
 * sitemap: four pixels between the subtitle and the first box.
 *
 * So the subtitle is wrapped to the width it will actually be drawn at — the
 * frame less its two 32px margins, which is what the handlers pass — and the
 * rows start below however many lines that turns out to be. One line lands on
 * 96, so nothing about an existing diagram moves; a longer one pushes the
 * drawing down instead of being drawn on top of it.
 */
export function headerHeight(subtitle: string, frameW: number): number {
  const bare = TITLE_Y + lineHeight(TITLE_SIZE) + HEADER_GAP;
  const text = (subtitle ?? "").trim();
  if (!text) return bare;
  const lines = wrapToWidth(text, Math.max(120, frameW - FRAME_PAD * 2), SUBTITLE_SIZE).length;
  return Math.max(bare, SUBTITLE_Y + lines * lineHeight(SUBTITLE_SIZE) + HEADER_GAP);
}

/** Where the handlers put the two lines, and the air kept under them. */
const TITLE_Y = 24;
const TITLE_SIZE = 20;
const SUBTITLE_Y = 56;
const SUBTITLE_SIZE = 13;
const HEADER_GAP = 22;
/** The margin every diagram frame keeps, and what the subtitle is wrapped to. */
const FRAME_PAD = 32;
