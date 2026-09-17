/**
 * Pure token-value normalization. NO figma globals. The critical multi-mode
 * fix lives here so it is unit-testable: every mode gets an explicit value,
 * never left at the Figma default (0 / "String value").
 */

/**
 * Collect the set of mode names referenced by any per-mode color value.
 *
 * EMPTY means "no opinion about modes" — write whatever modes the collection
 * already has. It used to return `["Mode 1"]`, Figma's name for a fresh
 * collection's only mode, and that sentinel was a demand: a caller passing
 * plain hexes was asking for a mode literally named "Mode 1". Once the first
 * mode had been renamed (to `light`, say), a later plain-hex call asked for a
 * mode that no longer existed and tried to ADD one — which on a plan that
 * allows a single mode fails outright.
 */
export function collectModes(
  colors: Record<string, unknown> | undefined,
): string[] {
  const modes = new Set<string>();
  for (const v of Object.values(colors ?? {})) {
    if (v && typeof v === "object") {
      for (const k of Object.keys(v)) modes.add(k);
    }
  }
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
