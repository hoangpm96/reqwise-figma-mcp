/**
 * Pure font fallback chain logic. NO figma globals — the actual
 * listAvailableFontsAsync / loadFontAsync live in fonts.ts and delegate the
 * decision here so it is unit-testable.
 */

export interface FontName {
  family: string;
  style: string;
}

export interface FontResolution {
  requestedFont: FontName;
  resolvedFont: FontName;
  /** Present only when a substitution happened. */
  reason?: string;
  substituted: boolean;
}

/** Fallback families tried in order when the requested one is unavailable. */
export const FALLBACK_FAMILIES = ["Inter", "Roboto"];
export const DEFAULT_STYLE = "Regular";

interface AvailableIndex {
  /** family (lowercased) → set of available styles. */
  byFamily: Map<string, Set<string>>;
}

/** Build a lookup index from a flat list of available font names. */
export function indexAvailableFonts(
  fonts: readonly FontName[],
): AvailableIndex {
  const byFamily = new Map<string, Set<string>>();
  for (const f of fonts) {
    const key = f.family.toLowerCase();
    let set = byFamily.get(key);
    if (!set) {
      set = new Set<string>();
      byFamily.set(key, set);
    }
    set.add(f.style);
  }
  return { byFamily };
}

/**
 * Approximate numeric weight of a style name, so a missing weight can fall back
 * to the NEAREST available weight in the same family rather than collapsing to
 * Regular (which silently strips a bold display face down to book weight — the
 * "loud headline became Regular" bug). Italic/oblique suffixes are ignored for
 * weight ranking; the caller keeps whatever slant the picked style carries.
 */
const WEIGHT_OF: Array<[RegExp, number]> = [
  [/thin|hairline/, 100],
  [/extra[\s-]?light|ultra[\s-]?light/, 200],
  [/light/, 300],
  [/regular|normal|book|^$/, 400],
  [/medium/, 500],
  [/semi[\s-]?bold|demi[\s-]?bold/, 600],
  [/extra[\s-]?bold|ultra[\s-]?bold/, 800],
  [/black|heavy/, 900],
  [/bold/, 700], // after extra/semi so those win their more specific match
];

export function styleWeight(style: string): number {
  const s = style.toLowerCase();
  for (const [re, w] of WEIGHT_OF) {
    if (re.test(s)) return w;
  }
  return 400;
}

/** Is this style italic/oblique? Used to prefer same-slant matches. */
function isItalic(style: string): boolean {
  return /italic|oblique/i.test(style);
}

function pickStyle(styles: Set<string>, wanted: string): string | null {
  if (styles.has(wanted)) return wanted;
  // Case-insensitive style match.
  const lw = wanted.toLowerCase();
  for (const s of styles) {
    if (s.toLowerCase() === lw) return s;
  }
  if (styles.size === 0) return null;

  // Nearest-weight match within the family, preferring the same slant. This is
  // what keeps a requested "ExtraBold" landing on "Bold" instead of "Regular".
  const wantWeight = styleWeight(wanted);
  const wantItalic = isItalic(wanted);
  let best: string | null = null;
  let bestScore = Infinity;
  for (const s of styles) {
    // Weight gap dominates; a slant mismatch adds a flat penalty large enough
    // to break ties but never to override a closer weight.
    const score =
      Math.abs(styleWeight(s) - wantWeight) +
      (isItalic(s) === wantItalic ? 0 : 50);
    if (score < bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best;
}

/**
 * Resolve a requested font against the available index, walking the fallback
 * chain requested → Inter → Roboto → any. Returns which font to actually
 * load and whether/why it was substituted.
 */
export function resolveFont(
  requested: FontName,
  index: AvailableIndex,
): FontResolution {
  const reqFamilyKey = requested.family.toLowerCase();
  const reqStyles = index.byFamily.get(reqFamilyKey);

  if (reqStyles) {
    const style = pickStyle(reqStyles, requested.style);
    if (style) {
      const substituted = style !== requested.style;
      return {
        requestedFont: requested,
        resolvedFont: { family: requested.family, style },
        substituted,
        reason: substituted
          ? `Style "${requested.style}" not found for ${requested.family}; used "${style}".`
          : undefined,
      };
    }
  }

  // Walk fallback families.
  for (const fam of FALLBACK_FAMILIES) {
    if (fam.toLowerCase() === reqFamilyKey) continue;
    const styles = index.byFamily.get(fam.toLowerCase());
    if (!styles) continue;
    const style = pickStyle(styles, requested.style) ?? DEFAULT_STYLE;
    return {
      requestedFont: requested,
      resolvedFont: { family: fam, style },
      substituted: true,
      reason: `Font "${requested.family}" unavailable; fell back to "${fam} ${style}".`,
    };
  }

  // Last resort: first available font of any family.
  const firstFamily = index.byFamily.entries().next();
  if (!firstFamily.done) {
    const [famKey, styles] = firstFamily.value;
    const style = pickStyle(styles, requested.style) ?? DEFAULT_STYLE;
    // We lowercased the key; recover a display family from the style set is
    // not possible, so report the key. Callers pass the real FontName from
    // the available list when they need exact casing.
    return {
      requestedFont: requested,
      resolvedFont: { family: famKey, style },
      substituted: true,
      reason: `No preferred fonts available; used first available "${famKey}".`,
    };
  }

  // Nothing available at all — echo the request; loadFontAsync will surface.
  return {
    requestedFont: requested,
    resolvedFont: requested,
    substituted: false,
  };
}
