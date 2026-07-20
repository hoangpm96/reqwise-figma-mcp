import { describe, it, expect } from "vitest";
import {
  toDtcg,
  toCss,
  toTailwind,
  parseDtcg,
  isAliasRef,
  cssSlug,
  NeutralCollection,
} from "../../src/shared/token-format.js";

const kit: NeutralCollection[] = [
  {
    name: "Reqwise Tokens",
    modes: ["light", "dark"],
    defaultMode: "light",
    tokens: [
      {
        path: ["color", "primary"],
        type: "color",
        valuesByMode: { light: "#3366ee", dark: "#88aaff" },
      },
      {
        path: ["color", "accent"],
        type: "color",
        valuesByMode: { light: "{color.primary}", dark: "{color.primary}" },
      },
      { path: ["radius"], type: "number", valuesByMode: { light: 8, dark: 8 } },
      {
        path: ["font", "family"],
        type: "string",
        valuesByMode: { light: "Inter", dark: "Inter" },
      },
    ],
  },
];

describe("toDtcg", () => {
  it("builds a flat nested tree for the default mode", () => {
    const t = toDtcg(kit) as any;
    expect(t.color.primary).toEqual({ $type: "color", $value: "#3366ee" });
    expect(t.color.accent.$value).toBe("{color.primary}");
    expect(t.radius).toEqual({ $type: "number", $value: 8 });
  });

  it("mode selects values; allModes keys by mode", () => {
    const dark = toDtcg(kit, { mode: "dark" }) as any;
    expect(dark.color.primary.$value).toBe("#88aaff");
    const all = toDtcg(kit, { allModes: true }) as any;
    expect(Object.keys(all).sort()).toEqual(["dark", "light"]);
    expect(all.dark.color.primary.$value).toBe("#88aaff");
  });

  it("nests under collection names when several collections export", () => {
    const two = toDtcg([
      ...kit,
      { name: "Brand", modes: ["light"], defaultMode: "light", tokens: [
        { path: ["logo"], type: "string", valuesByMode: { light: "acme" } },
      ]},
    ]) as any;
    expect(two["Reqwise Tokens"].color.primary.$value).toBe("#3366ee");
    expect(two.Brand.logo.$value).toBe("acme");
  });
});

describe("toCss", () => {
  it("emits :root defaults and [data-theme] overrides; aliases become var()", () => {
    const css = toCss(kit);
    expect(css).toContain(":root {");
    expect(css).toContain("--color-primary: #3366ee;");
    expect(css).toContain("--color-accent: var(--color-primary);");
    expect(css).toContain("--radius: 8px;");
    expect(css).toContain('[data-theme="dark"] {');
    expect(css).toContain("--color-primary: #88aaff;");
    // dark radius equals default → not repeated in the dark block
    expect(css.split('[data-theme="dark"]')[1]).not.toContain("--radius");
  });

  it("cssSlug normalizes odd names", () => {
    expect(cssSlug(["color", "Primary Dark"])).toBe("color-primary-dark");
  });
});

describe("toTailwind", () => {
  it("maps colors + spacing, skips strings and aliases", () => {
    const tw = toTailwind(kit);
    expect(tw.content).toContain('"primary": "#3366ee"');
    expect(tw.content).toContain('"radius": "8px"');
    expect(tw.skipped).toEqual(
      expect.arrayContaining(["color/accent", "font/family"]),
    );
    expect(tw.content).toContain("module.exports =");
  });
});

describe("parseDtcg", () => {
  it("flattens groups, honors $type, infers when missing", () => {
    const flat = parseDtcg({
      color: {
        primary: { $type: "color", $value: "#3366ee" },
        accent: { $value: "{color.primary}" },
      },
      radius: { $type: "dimension", $value: 8 },
      label: { $value: "hello" },
    });
    const byName = Object.fromEntries(flat.map((t) => [t.name, t]));
    expect(byName["color/primary"]).toMatchObject({ type: "color", value: "#3366ee" });
    expect(byName["color/accent"]!.aliasTo).toEqual(["color", "primary"]);
    expect(byName["radius"]!.type).toBe("number");
    expect(byName["label"]!.type).toBe("string");
  });

  it("isAliasRef detects only {…} refs", () => {
    expect(isAliasRef("{a.b}")).toBe(true);
    expect(isAliasRef("#fff")).toBe(false);
    expect(isAliasRef("{a}{b}")).toBe(false);
  });
});
