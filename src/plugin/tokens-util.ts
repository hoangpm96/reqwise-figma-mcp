/**
 * Pure token-value normalization. NO figma globals. The critical multi-mode
 * fix lives here so it is unit-testable: every mode gets an explicit value,
 * never left at the Figma default (0 / "String value").
 */

/** Collect the set of mode names referenced by any per-mode color value. */
export function collectModes(
  colors: Record<string, unknown> | undefined,
): string[] {
  const modes = new Set<string>();
  for (const v of Object.values(colors ?? {})) {
    if (v && typeof v === "object") {
      for (const k of Object.keys(v)) modes.add(k);
    }
  }
  if (modes.size === 0) return ["Mode 1"];
  return [...modes];
}

/**
 * Expand a color value (single hex OR per-mode map) into an explicit value for
 * every mode in `modeNames`. Modes not given fall back to the first provided
 * value. `__default__` holds the fallback for any additional collection mode.
 */
export function normalizeColorValue(
  value: string | Record<string, string | undefined>,
  modeNames: string[],
): Record<string, string> {
  if (typeof value === "string") {
    const out: Record<string, string> = { __default__: value };
    for (const m of modeNames) out[m] = value;
    return out;
  }
  const out: Record<string, string> = {};
  let first: string | undefined;
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string") {
      out[k] = v;
      if (first === undefined) first = v;
    }
  }
  if (first !== undefined) {
    out.__default__ = first;
    for (const m of modeNames) if (out[m] === undefined) out[m] = first;
  }
  return out;
}
