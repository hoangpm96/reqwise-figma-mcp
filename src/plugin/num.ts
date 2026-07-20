/**
 * Pure numeric helpers used by serialization to keep responses token-frugal.
 * NO figma globals.
 */

/** Round to 2 decimals, collapse -0 → 0, drop trailing noise. */
export function r2(n: number): number {
  if (!isFinite(n)) return 0;
  const v = Math.round(n * 100) / 100;
  return v === 0 ? 0 : v;
}

/** Round an {x,y,w,h}-ish box. */
export function roundBox<T extends Record<string, number>>(box: T): T {
  const out: Record<string, number> = {};
  for (const k of Object.keys(box)) {
    out[k] = r2(box[k] as number);
  }
  return out as T;
}

/**
 * Strip a plain object of null/undefined and (optionally) default-valued
 * fields to keep serialized node info compact.
 */
export function compact<T extends Record<string, unknown>>(
  obj: T,
): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v === undefined || v === null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out as Partial<T>;
}
