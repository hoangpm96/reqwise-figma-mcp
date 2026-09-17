import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The same gate the design-system generator got, pointed at the diagram kinds.
 *
 * `create()` silently ignores any spec key it does not implement, so a dropped
 * key produces a node that is perfectly valid and completely wrong. Nothing
 * downstream can notice: not the plugin, not a warning, not a unit test on the
 * payload. On one canvas run it cost four defects at once — `effectStyle` (every
 * elevated card flat), `textAutoResize` (every width-constrained text clipped to
 * one line), `layoutWrap` and `counterAxisSpacing` (two thirds of a specimen
 * outside its frame).
 *
 * Every diagram kind writes create() specs by hand, so every one of them is
 * exposed to it. `textAutoResize` was in fact dropped for all eight of them
 * from the beginning, which is how a wrap one line longer than the server's
 * metric predicted became a sentence that silently vanished.
 *
 * So this asserts the invariant rather than the four bugs: every key a handler
 * writes into a spec is a key something in the plugin actually reads.
 */

const PLUGIN = join(import.meta.dirname, "../../src/plugin");

/** The files that between them consume a create() spec. */
const CONSUMERS = [
  "handlers/create.ts",
  "handlers/text.ts",
  "handlers/styles.ts",
  "handlers/tokens.ts",
  "layout-math.ts",
  "paints.ts",
  "vector-path.ts",
  "insert.ts",
]
  .map((f) => readFileSync(join(PLUGIN, f), "utf8"))
  .join("\n");

/**
 * Names that appear as `key:` in a handler without ever being part of a spec.
 * Listed rather than pattern-matched, so adding one is a deliberate act —
 * which is the whole difference between a gate and a green light.
 */
const NOT_A_SPEC_KEY = new Set([
  // What a handler RETURNS to the server.
  "frameId",
  "pageModel",
  "box",
  // What it writes into the frame's marker, for read-back and patching.
  "kind",
  "title",
  "nodes",
  "entities",
  "participants",
  "lanes",
  "blocks",
  // Multi-line TypeScript signatures: a parameter name reads as `name:` too.
  "origin",
  "font",
  "S",
  "italic",
  "ctx",
  "parent",
  "d",
  "drawn",
  "linked",
  // A prototype reaction, which goes to the Plugin API through
  // `normalizeReactions` — not to create(). The userflow kind is the only one
  // that wires ON_CLICK → NAVIGATE between the screens it drew.
  "trigger",
  "action",
]);

/**
 * The resolved LOOK, which travels in the draw payload and is read by the
 * handler itself — never passed to create() under these names. Both kinds that
 * carry a theme declare their palette as a literal fallback, and every field of
 * it would otherwise read as an unknown spec key.
 */
const STYLE_FIELDS = new Set([
  "ink",
  "muted",
  "frameFill",
  "frameStroke",
  "frameRadius",
  "cardFill",
  "cardStroke",
  "cardRadius",
  "railFill",
  "outputFill",
  "sectionFill",
  "cellRadius",
  "cellStroke",
  "cellPad",
  "stageInk",
  "trough",
  "pad",
  "accent",
  "warnFill",
  "warnInk",
  "sourceFill",
  "sourceInk",
  "titleSize",
  "subSize",
  "nameSize",
  "quoteSize",
  "bodySize",
  "labelSize",
  "cardLineH",
  "cellLineH",
]);

/** How create() reads a key: `p.key`, `params.key`, or a quoted literal. */
function isRead(key: string): boolean {
  return [
    new RegExp(`\\bp\\.${key}\\b`),
    new RegExp(`\\bparams\\.${key}\\b`),
    new RegExp(`["']${key}["']`),
  ].some((re) => re.test(CONSUMERS));
}

/** Every `key:` a handler writes. */
function keysIn(source: string): string[] {
  return [...new Set([...source.matchAll(/^\s+([a-zA-Z][a-zA-Z0-9]*):/gm)].map((m) => m[1]!))];
}

/** The kinds, found rather than listed — a ninth must not be able to skip this. */
const KINDS = readdirSync(join(PLUGIN, "handlers"))
  .filter((f) => /^(activity|erd|journey|persona|sequence|sitemap|state|usecase|userflow)\.ts$/.test(f))
  .sort();

describe("the spec keys a diagram handler writes", () => {
  it("covers every kind, so a new one cannot skip the gate", () => {
    expect(KINDS.length).toBeGreaterThanOrEqual(6);
  });

  it("is a gate, not a green light", () => {
    // The first version of this test passed immediately, which proved nothing.
    // These three were genuinely dropped until create.ts learned them; if the
    // predicate cannot tell them from an invented name it is measuring nothing.
    for (const real of ["effectStyle", "textAutoResize", "layoutWrap"]) {
      expect(isRead(real), `"${real}" is read by create() and must be seen as read`).toBe(true);
    }
    for (const invented of ["cornerRadiusButBlue", "textAutoResizeish", "layoutWrapper2"]) {
      expect(isRead(invented), `"${invented}" is read by nothing and must be reported`).toBe(false);
    }
  });

  it("are all keys the plugin actually reads", () => {
    for (const file of KINDS) {
      const unread = keysIn(readFileSync(join(PLUGIN, "handlers", file), "utf8")).filter(
        (k) => !NOT_A_SPEC_KEY.has(k) && !STYLE_FIELDS.has(k) && !isRead(k),
      );
      expect(unread, `${file} writes keys nothing reads — create() will drop them silently`).toEqual(
        [],
      );
    }
  });
});
