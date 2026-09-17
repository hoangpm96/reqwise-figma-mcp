/**
 * Do the diagrams on this page agree with each other?
 *
 * Every existing checker reads ONE model and asks whether it is a legal
 * diagram of its kind. None of them can see the diagram next to it, so the
 * mistake nobody catches is the one where two views of the same business are
 * each perfectly well-formed and say different things: the sequence retries
 * three times and the state machine guards on `n < 5`; the ERD stores
 * `cancelled` and the lifecycle has no way to reach it; the customer is
 * "User" here and "Khách hàng" there.
 *
 * That is the gap mermaid and plantuml cannot close at all — each diagram is
 * an island — and it is the reason to keep the drawings in one Figma file
 * where the models can be read back.
 *
 * These findings are advisory. A page mid-way through being drawn is SUPPOSED
 * to disagree with itself, so nothing here blocks a drawing; it reports, the
 * way every other checker in this codebase does.
 */
import { collectFacts, normalize, slug, type PageFacts, type StoredDiagram } from "./facts.js";

export interface ConsistencyFinding {
  /** Which rule fired, so a caller can filter without parsing prose. */
  rule: "lifecycle-drift" | "name-drift" | "id-drift" | "policy-drift" | "ia-drift" | "persona-drift";
  message: string;
  /** The frames involved — a finding you cannot locate is not actionable. */
  frames: string[];
}

export function checkConsistency(diagrams: StoredDiagram[]): ConsistencyFinding[] {
  const facts = collectFacts(diagrams);
  return [
    ...lifecycleDrift(facts),
    ...policyDrift(facts),
    ...nameDrift(facts),
    ...iaDrift(facts),
  ];
}

/**
 * A column that enumerates what an entity can hold, against the state diagram
 * that says the same thing in pictures. Both are the truth about one table, so
 * a value in one and not the other is a real hole: either the lifecycle cannot
 * reach a status the database allows, or it draws one the database rejects.
 */
function lifecycleDrift(facts: PageFacts): ConsistencyFinding[] {
  const out: ConsistencyFinding[] = [];
  for (const e of facts.enums) {
    // EVERY machine drawn for this entity, not just the first one found. A
    // page routinely carries an old lifecycle and a redraft of it, and taking
    // only the first meant the draft — the one being worked on, and the one
    // most likely to be wrong — was never compared to anything.
    for (const life of facts.lifecycles.filter((l) =>
      subjectMatches(l.subject, e.entity),
    )) {
      const declared = new Set(e.values.map(normalize));
      const drawn = new Set(life.states.map(normalize));
      const onlyDrawn = life.states.filter((s) => !declared.has(normalize(s)));
      const onlyDeclared = e.values.filter((v) => !drawn.has(normalize(v)));
      if (!onlyDrawn.length && !onlyDeclared.length) continue;

      const parts: string[] = [];
      if (onlyDrawn.length) {
        parts.push(
          `the state diagram has ${list(onlyDrawn)}, which \`${e.entity}.${e.field}\` cannot store`,
        );
      }
      if (onlyDeclared.length) {
        parts.push(
          `\`${e.entity}.${e.field}\` allows ${list(onlyDeclared)}, which nothing in the lifecycle reaches`,
        );
      }
      out.push({
        rule: "lifecycle-drift",
        message: `"${life.frame}" and "${e.frame}" disagree about ${e.entity}: ${parts.join("; ")}. One of the two is wrong — decide which, then patch it.`,
        frames: [life.nodeId, e.nodeId],
      });
    }
  }
  return out;
}

/**
 * One rule, two values.
 *
 * A label that references `@retry-attempts` cannot contradict the rule, since
 * it does not hold the number. Two DIAGRAMS can still declare the rule
 * differently, though, and that is the drift this catches: the sequence says
 * three attempts and the state machine guards on five, and both drawings look
 * right because each is internally consistent.
 */
function policyDrift(facts: PageFacts): ConsistencyFinding[] {
  const out: ConsistencyFinding[] = [];
  const byName = new Map<string, typeof facts.policies>();
  for (const p of facts.policies) push(byName, p.name.toLowerCase(), p);

  for (const [, ps] of byName) {
    const values = [...new Set(ps.map((p) => String(p.value)))];
    if (values.length < 2) continue;
    const said = ps
      .map((p) => `"${p.frame}" says ${JSON.stringify(p.value)}`)
      .filter((v, i, a) => a.indexOf(v) === i);
    out.push({
      rule: "policy-drift",
      message: `\`@${ps[0]!.name}\` has ${values.length} different values on this page: ${said.join(", ")}. One rule, one number — decide which, then patch the others.`,
      frames: [...new Set(ps.map((p) => p.nodeId))],
    });
  }
  return out;
}

/**
 * One role, two names — or one name, two ids.
 *
 * The first is the drift that makes a set of diagrams read as if they describe
 * different systems. The second is worse and quieter: two ids for one person
 * means nothing downstream can tell they are the same, so traceability between
 * the views is broken while every diagram still looks right.
 */
function nameDrift(facts: PageFacts): ConsistencyFinding[] {
  const out: ConsistencyFinding[] = [];

  const byId = new Map<string, typeof facts.roles>();
  const byName = new Map<string, typeof facts.roles>();
  for (const r of facts.roles) {
    push(byId, r.id, r);
    push(byName, normalize(r.name), r);
  }

  for (const [id, rs] of byId) {
    const names = [...new Set(rs.map((r) => normalize(r.name)))];
    if (names.length < 2) continue;
    out.push({
      rule: "name-drift",
      message: `\`${id}\` is called ${list(uniqueNames(rs))} in different diagrams (${where(rs)}). Same id, so it is meant to be one role — pick one name and patch the others.`,
      frames: [...new Set(rs.map((r) => r.nodeId))],
    });
  }

  for (const [, rs] of byName) {
    const ids = [...new Set(rs.map((r) => r.id))];
    if (ids.length < 2) continue;
    out.push({
      rule: "id-drift",
      message: `"${rs[0]!.name}" appears under ${ids.length} different ids (${ids.map((i) => `\`${i}\``).join(", ")}) in ${where(rs)}. Nothing can tell they are the same role — give them one id.`,
      frames: [...new Set(rs.map((r) => r.nodeId))],
    });
  }

  return out;
}

/**
 * A flow walks through a screen the information architecture has no page for.
 *
 * ONE DIRECTION, and the other one is deliberately silent. This is the check
 * that makes `type:"sitemap"` worth having next to `type:"userflow"` — the two
 * kinds describe the same boxes through different relations, so they can
 * contradict each other while each is perfectly well-formed:
 *
 *   flow → IA   a screen the flow walks through that lives nowhere in the
 *               product. Either the IA is missing a page or the flow invented
 *               one. Small, specific, and there is something to do about it.
 *
 *   IA → flow   a page no flow reaches. REPORTED BY NOTHING, on purpose. A
 *               userflow is *supposed* to draw one flow, so a sitemap with 30
 *               pages beside a six-screen signup flow would report 24 findings
 *               that are all true and all useless — and it would do it on
 *               every page anybody put both kinds on. That is exactly the
 *               false positive the journey persona fact had to be removed for
 *               (see collectFacts); `sitemap-consistency.test.ts` pins the
 *               silence so it cannot be helpfully added back.
 *
 * Matching is by id, then by the artboard the two sides name, then by label.
 * A label match with different ids is its own finding: both drawings look
 * right and nothing downstream can tell the two are one screen.
 */
function iaDrift(facts: PageFacts): ConsistencyFinding[] {
  const pages = facts.screens.filter((s) => s.where === "sitemap page");
  const flows = facts.screens.filter((s) => s.where === "userflow screen");
  // No sitemap on the page means there is no IA to disagree with. Comparing a
  // flow against nothing would report every screen it has.
  if (!pages.length || !flows.length) return [];

  // The UNION of every sitemap on the page: a product routinely carries a web
  // IA and a mobile one, and a screen that lives in either has a home.
  const keys = new Set<string>();
  for (const p of pages) {
    keys.add(normalize(p.id));
    for (const art of p.screenIds) keys.add(normalize(art));
  }
  const byName = new Map<string, typeof pages>();
  for (const p of pages) push(byName, normalize(p.name), p);
  const pageFrames = [...new Set(pages.map((p) => p.nodeId))];

  const out: ConsistencyFinding[] = [];
  const orphans = new Map<string, typeof flows>();
  for (const s of flows) {
    if (keys.has(normalize(s.id))) continue;
    if (s.screenIds.some((art) => keys.has(normalize(art)))) continue;
    const sameName = byName.get(normalize(s.name));
    if (sameName?.length) {
      out.push({
        rule: "ia-drift",
        message: `"${s.name}" is \`${s.id}\` in "${s.frame}" and ${sameName.map((p) => `\`${p.id}\``).join(", ")} in "${sameName[0]!.frame}". Same screen, two ids — nothing can tell the flow and the sitemap are talking about one page, so traceability between them is broken. Give them one id, or point the flow's screenId at the sitemap page.`,
        frames: [s.nodeId, ...new Set(sameName.map((p) => p.nodeId))],
      });
      continue;
    }
    push(orphans, s.nodeId, s);
  }

  for (const [nodeId, missing] of orphans) {
    const named = missing.map((s) => `"${s.name}"`);
    out.push({
      rule: "ia-drift",
      message: `"${missing[0]!.frame}" walks through ${list(named)}, which no sitemap on this page has a page for. Either the IA is missing ${missing.length > 1 ? "them" : "it"}, or the flow named a screen that does not exist. (The reverse is NOT checked: a flow draws one journey, so pages it never visits are expected.)`,
      frames: [nodeId, ...pageFrames],
    });
  }
  return out;
}

/**
 * Does this state machine describe that table? An explicit `entity` on the
 * spec is taken at its word; otherwise the title is matched loosely, because
 * "Booking lifecycle" is how people actually name the machine for `bookings`.
 * Loose in one direction only — containment, not fuzzy distance — so an
 * unrelated pair is never dragged together.
 */
function subjectMatches(subject: string, entity: string): boolean {
  const s = slug(subject);
  const e = slug(entity);
  if (!s || !e) return false;
  if (s === e) return true;
  // `bookings` vs `booking`: a table is plural, its lifecycle usually is not.
  // Conservative: only the trailing "s" goes — never the "e" before it, which
  // halved "releases"/"responses" to "releas"/"respons" — and never off a
  // word whose plural-looking ending IS the word ("status", "class",
  // "analysis"), since the stub that leaves still matches by prefix alone.
  const sing = /(ss|us|is)$/.test(e) ? e : e.replace(/s$/, "");
  return s.includes(e) || (sing.length > 2 && s.includes(sing));
}

function uniqueNames(rs: Array<{ name: string }>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rs) {
    const k = normalize(r.name);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r.name);
  }
  return out;
}

function where(rs: Array<{ where: string }>): string {
  return [...new Set(rs.map((r) => r.where))].join(" / ");
}

function list(values: string[]): string {
  const q = values.map((v) => `\`${v}\``);
  if (q.length === 1) return q[0]!;
  return `${q.slice(0, -1).join(", ")} and ${q[q.length - 1]}`;
}

function push<T>(m: Map<string, T[]>, k: string, v: T): void {
  const cur = m.get(k);
  if (cur) cur.push(v);
  else m.set(k, [v]);
}
