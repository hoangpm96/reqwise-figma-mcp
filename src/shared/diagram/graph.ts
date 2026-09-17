/**
 * Graph plumbing every diagram's proof-reader needs: adjacency, reachability,
 * and the two formatting helpers that keep one systemic mistake from flooding
 * the report with a hundred findings.
 */

export interface Edgeish {
  from: string;
  to: string;
}

export interface Adjacency<E extends Edgeish> {
  out: Map<string, E[]>;
  inbound: Map<string, E[]>;
}

export function adjacency<E extends Edgeish>(ids: string[], edges: E[]): Adjacency<E> {
  const out = new Map<string, E[]>();
  const inbound = new Map<string, E[]>();
  for (const id of ids) {
    out.set(id, []);
    inbound.set(id, []);
  }
  for (const e of edges) {
    out.get(e.from)?.push(e);
    inbound.get(e.to)?.push(e);
  }
  return { out, inbound };
}

/** Ids reachable from `roots` by following edges forwards. */
export function reachableFrom<E extends Edgeish>(roots: string[], out: Map<string, E[]>): Set<string> {
  const seen = new Set<string>();
  const queue = roots.slice();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of out.get(id) ?? []) queue.push(e.to);
  }
  return seen;
}

/** Join a finding list, capped so one systemic problem cannot flood the report. */
export function list(items: string[], max = 10): string {
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")} and ${items.length - max} more`;
}

/** The first line of a multi-line label, for quoting a node in a finding. */
export function firstLine(label: string): string {
  const line = (label.split(/<br\s*\/?>|\n/)[0] ?? "").trim();
  return line.length > 40 ? `${line.slice(0, 39)}…` : line;
}

/**
 * The drawn layer's handle: `from->to`, which is also what the reflow pass
 * matches layers by. Two edges between the SAME pair would collide on that
 * name (and a reflow would then move the wrong line), so a repeated pair gets
 * a `#n` suffix. Order is the caller's edge order, which the frame stores, so
 * the ids a reflow computes are the ids the draw pass used.
 */
export function edgeIds(edges: Edgeish[]): string[] {
  const total = new Map<string, number>();
  for (const e of edges) {
    const pair = `${e.from}->${e.to}`;
    total.set(pair, (total.get(pair) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return edges.map((e) => {
    const pair = `${e.from}->${e.to}`;
    if ((total.get(pair) ?? 0) < 2) return pair;
    const n = (seen.get(pair) ?? 0) + 1;
    seen.set(pair, n);
    return `${pair}#${n}`;
  });
}
