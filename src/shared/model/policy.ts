/**
 * A business rule with a number in it, written once and referenced everywhere.
 *
 * The hold lasts 10 minutes. Payment may be tried 3 times. Those facts get
 * retyped into four diagrams as prose — "Giữ ghế 10 phút", `[n < 3]`,
 * "up to 3 attempts" — and then one of them is updated and the others are not.
 * Nothing catches it, because each label is just a string and every diagram is
 * still a perfectly legal diagram of its kind.
 *
 * So the label stops carrying the number and references it instead:
 *
 *     options: { policies: { "hold-minutes": 10, "retry-attempts": 3 } }
 *     "Giữ ghế @hold-minutes phút"      →  drawn as "Giữ ghế 10 phút"
 *     "Declined [n < @retry-attempts]"  →  drawn as "Declined [n < 3]"
 *
 * Two things follow, and they are the whole point. A label cannot drift from
 * the value, because it IS the value. And the reference survives into the
 * stored model — substitution happens on the way to the LAYOUT, never on the
 * way to the model — so the page can be asked which frames depend on
 * `hold-minutes`, and changing it is a patch to each of them.
 */

export type PolicyValues = Record<string, string | number>;

/**
 * `@name` where a reference can begin: start of string, or after whitespace or
 * an opening bracket. Never after a word character, so `user@example.com` and
 * an `@` inside an identifier are left alone.
 */
const REF = /(^|[\s([{<>=,;:|/-])@([a-z][a-z0-9-]*)/gi;

/** Every policy name referenced by this string. */
export function refsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(REF)) out.push(m[2]!.toLowerCase());
  return out;
}

/** Replace the references this string makes to values that exist. */
export function fill(text: string, policies: PolicyValues): string {
  if (!text || text.indexOf("@") < 0) return text;
  return text.replace(REF, (whole, lead: string, name: string) => {
    const v = lookup(policies, name);
    return v === undefined ? whole : `${lead}${v}`;
  });
}

function lookup(policies: PolicyValues, name: string): string | number | undefined {
  if (Object.prototype.hasOwnProperty.call(policies, name)) return policies[name];
  const lower = name.toLowerCase();
  for (const k of Object.keys(policies)) if (k.toLowerCase() === lower) return policies[k];
  return undefined;
}

/**
 * A deep copy with every string filled in. Applied to the CHECKED model on its
 * way to the layout: the checker reads the reference form (so an empty label
 * is still an empty label), and the layout reads the filled form, because the
 * filled text is what has to fit in the box.
 */
export function fillDeep<T>(value: T, policies: PolicyValues): T {
  if (!policies || !Object.keys(policies).length) return value;
  return walk(value, policies) as T;
}

function walk(v: unknown, p: PolicyValues): unknown {
  if (typeof v === "string") return fill(v, p);
  if (Array.isArray(v)) return v.map((x) => walk(x, p));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val, p);
    return out;
  }
  return v;
}

/**
 * References this diagram makes but does not define.
 *
 * Only reported when the diagram declares policies at all — otherwise every
 * stray `@` in a label would be accused of being a typo, and plenty of labels
 * legitimately contain one.
 */
export function unresolved(value: unknown, policies: PolicyValues): string[] {
  if (!policies || !Object.keys(policies).length) return [];
  const seen = new Set<string>();
  collect(value, seen);
  return [...seen].filter((n) => lookup(policies, n) === undefined).sort();
}

function collect(v: unknown, into: Set<string>): void {
  if (typeof v === "string") {
    for (const n of refsIn(v)) into.add(n);
  } else if (Array.isArray(v)) {
    for (const x of v) collect(x, into);
  } else if (v && typeof v === "object") {
    for (const x of Object.values(v as Record<string, unknown>)) collect(x, into);
  }
}
