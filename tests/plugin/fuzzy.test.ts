import { describe, it, expect } from "vitest";
import {
  normalizeName,
  tokenize,
  scoreCandidate,
  rankCandidates,
} from "../../src/plugin/fuzzy.js";

describe("normalizeName", () => {
  it("lowercases and strips separators", () => {
    expect(normalizeName("Button/Primary-Large")).toBe("buttonprimarylarge");
    expect(normalizeName("icon_home")).toBe("iconhome");
  });
});

describe("tokenize", () => {
  it("splits on separators and camelCase", () => {
    expect(tokenize("Button/PrimaryLarge")).toEqual([
      "button",
      "primary",
      "large",
    ]);
    expect(tokenize("icon_home-24")).toEqual(["icon", "home", "24"]);
  });
});

describe("scoreCandidate", () => {
  it("exact match scores highest", () => {
    const s = scoreCandidate("Button Primary", {
      id: "1",
      name: "button/primary",
    });
    expect(s.reason).toBe("exact");
    expect(s.score).toBe(1000);
  });

  it("prefix beats contains beats token-overlap", () => {
    const prefix = scoreCandidate("btn", { id: "1", name: "btn-primary" });
    const contains = scoreCandidate("primary", {
      id: "2",
      name: "btn-primary",
    });
    const overlap = scoreCandidate("primary button", {
      id: "3",
      name: "button danger",
    });
    expect(prefix.reason).toBe("prefix");
    expect(contains.reason).toBe("contains");
    expect(overlap.reason).toBe("token-overlap");
    expect(prefix.score).toBeGreaterThan(contains.score);
    expect(contains.score).toBeGreaterThan(overlap.score);
  });

  it("no overlap → zero", () => {
    const s = scoreCandidate("zebra", { id: "1", name: "button" });
    expect(s.score).toBe(0);
    expect(s.reason).toBe("none");
  });
});

describe("rankCandidates", () => {
  const cands = [
    { id: "1", name: "Button/Primary" },
    { id: "2", name: "Button/Secondary" },
    { id: "3", name: "Icon/Home" },
    { id: "4", name: "Primary Button Large" },
  ];

  it("ranks exact/prefix first, drops zero", () => {
    const ranked = rankCandidates("button primary", cands);
    expect(ranked[0]?.candidate.id).toBe("1");
    expect(ranked.every((r) => r.score > 0)).toBe(true);
    expect(ranked.find((r) => r.candidate.id === "3")).toBeUndefined();
  });

  it("respects limit", () => {
    expect(rankCandidates("button", cands, 1).length).toBe(1);
  });

  it("tie broken by shorter name", () => {
    const tie = rankCandidates("home", [
      { id: "a", name: "Home Screen Large" },
      { id: "b", name: "Home" },
    ]);
    expect(tie[0]?.candidate.id).toBe("b");
  });
});
