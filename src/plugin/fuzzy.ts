/**
 * Pure fuzzy matching for component/name search. NO figma globals.
 * Normalize → exact → prefix → contains → token-overlap scoring.
 */

/** Lowercase, strip separators (/ - _ space .) → single normalized token. */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[/\-_.\s]+/g, "")
    .trim();
}

/** Split a name into lowercase tokens on separators + camelCase boundaries. */
export function tokenize(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[/\-_.\s]+/)
    .filter((t) => t.length > 0);
}

export interface Candidate {
  id: string;
  name: string;
}

export interface ScoredCandidate<T extends Candidate = Candidate> {
  candidate: T;
  score: number;
  reason: "exact" | "prefix" | "contains" | "token-overlap" | "none";
}

/**
 * Score a single candidate against a query. Higher is better; 0 means no
 * meaningful match. Deterministic tiers so ranking is stable:
 *   exact          → 1000
 *   prefix         → 800 - lengthDelta
 *   contains       → 600 - offset
 *   token-overlap  → up to 500 by shared-token ratio
 */
export function scoreCandidate<T extends Candidate>(
  query: string,
  candidate: T,
): ScoredCandidate<T> {
  const nq = normalizeName(query);
  const nc = normalizeName(candidate.name);

  if (nq.length === 0) {
    return { candidate, score: 0, reason: "none" };
  }
  if (nq === nc) {
    return { candidate, score: 1000, reason: "exact" };
  }
  if (nc.startsWith(nq)) {
    const delta = Math.min(nc.length - nq.length, 200);
    return { candidate, score: 800 - delta, reason: "prefix" };
  }
  const idx = nc.indexOf(nq);
  if (idx >= 0) {
    return { candidate, score: 600 - Math.min(idx, 200), reason: "contains" };
  }

  // Token overlap.
  const qt = tokenize(query);
  const ct = tokenize(candidate.name);
  if (qt.length === 0 || ct.length === 0) {
    return { candidate, score: 0, reason: "none" };
  }
  const cset = new Set(ct);
  let shared = 0;
  for (const t of qt) {
    if (cset.has(t)) shared++;
  }
  if (shared === 0) {
    return { candidate, score: 0, reason: "none" };
  }
  // ratio over union approximates Jaccard, scaled to <500.
  const union = new Set([...qt, ...ct]).size;
  const ratio = shared / union;
  return { candidate, score: Math.round(ratio * 500), reason: "token-overlap" };
}

/**
 * Rank candidates against a query, best first, dropping zero scores.
 * Ties broken by shorter name (more specific match).
 */
export function rankCandidates<T extends Candidate>(
  query: string,
  candidates: readonly T[],
  limit = 10,
): ScoredCandidate<T>[] {
  const scored = candidates
    .map((c) => scoreCandidate(query, c))
    .filter((s) => s.score > 0);
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.candidate.name.length - b.candidate.name.length;
  });
  return scored.slice(0, limit);
}
