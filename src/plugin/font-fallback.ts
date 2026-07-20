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

function pickStyle(styles: Set<string>, wanted: string): string | null {
  if (styles.has(wanted)) return wanted;
  // Case-insensitive style match.
  const lw = wanted.toLowerCase();
  for (const s of styles) {
    if (s.toLowerCase() === lw) return s;
  }
  // Fall back to Regular, else the first available style.
  if (styles.has(DEFAULT_STYLE)) return DEFAULT_STYLE;
  const first = styles.values().next();
  return first.done ? null : first.value;
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
