/**
 * What a page of diagrams collectively KNOWS, pulled out of the models each
 * frame stores.
 *
 * The five views keep retyping the same facts — the roles, the statuses an
 * entity can hold — and nothing checks that the copies agree. Reading them
 * back out of the frames is what makes agreement checkable, and it needs no
 * glossary written by hand: since a frame remembers the model it was drawn
 * from, the file already holds every fact anybody has drawn.
 *
 * Deliberately small and shallow. This layer knows only enough about each kind
 * to answer four questions — who appears as a role, who a journey/card names
 * as a person, what values an entity can hold, and which pages exist — so
 * another diagram kind costs one case here, not a redesign.
 */
import { refsIn } from "./policy.js";
import { firstLine } from "../diagram/graph.js";
import { FINAL_ID, INITIAL } from "../state/text.js";

/** One diagram's stored model, as `get_page_model` hands it over. */
export interface StoredDiagram {
  nodeId: string;
  kind: string;
  title?: string;
  /** The page it lives on — present only when the read spanned the file. */
  page?: string;
  spec: unknown;
}

/** Someone or something that DOES things, named in a diagram. */
export interface RoleFact {
  id: string;
  name: string;
  /** Where it was found, for a finding a person can act on. */
  where: string;
  nodeId: string;
  frame: string;
}

/** An entity whose column enumerates the values it can hold. */
export interface EnumFact {
  entity: string;
  field: string;
  values: string[];
  nodeId: string;
  frame: string;
}

/** A rule with a value, as one diagram declares it. */
export interface PolicyFact {
  name: string;
  value: string | number;
  /** Whether any label on this diagram actually references it. */
  used: boolean;
  nodeId: string;
  frame: string;
}

/**
 * A screen or page some diagram names, and which relation it came from.
 *
 * The only fact two DIFFERENT kinds contribute to: a userflow's screens (what
 * the user walks through) and a sitemap's pages (what the product is made of).
 * They are the same objects seen through two relations, which is what makes
 * them comparable — and is the whole reason the sitemap kind is worth having
 * beside the userflow rather than instead of it.
 */
export interface ScreenFact {
  id: string;
  name: string;
  /** `userflow screen` or `sitemap page`. */
  where: "userflow screen" | "sitemap page";
  /**
   * The artboards the diagram says it is designed as. A sitemap page names
   * several (itself plus its states); a userflow node names one or none.
   */
  screenIds: string[];
  nodeId: string;
  frame: string;
}

/** The values a state diagram says one entity moves between. */
export interface LifecycleFact {
  subject: string;
  states: string[];
  nodeId: string;
  frame: string;
}

/**
 * A person a diagram names — a journey's `persona` line, or a card's `name`.
 *
 * Kept OFF `roles` on purpose. Feeding either in as a role produced
 * `id-drift` against actors (a person is not the role they occupy; a journey
 * line has no id at all). This fact exists so those two kinds can be compared
 * to EACH OTHER, by name, without reopening that hole.
 */
export interface WhoFact {
  name: string;
  where: "journey persona" | "persona card";
  nodeId: string;
  frame: string;
}

export interface PageFacts {
  roles: RoleFact[];
  enums: EnumFact[];
  lifecycles: LifecycleFact[];
  policies: PolicyFact[];
  screens: ScreenFact[];
  who: WhoFact[];
}

/**
 * Pseudo-states are notation, not stored values: `initial` is where the
 * lifecycle starts, and choice/fork/join are routing. Only a real state — and
 * a `final` one, which IS a value the row ends up holding — can be compared
 * against a column's enum.
 */
const PSEUDO = new Set(["initial", "choice", "fork", "join"]);

export function collectFacts(diagrams: StoredDiagram[]): PageFacts {
  const out: PageFacts = { roles: [], enums: [], lifecycles: [], policies: [], screens: [], who: [] };
  // Name the page only when there is more than one in play. On a single page
  // it is a prefix on every finding that tells the reader nothing; across
  // pages it is the difference between two frames that share a title.
  const pages = new Set(diagrams.map((d) => d.page).filter(Boolean));
  const spanning = pages.size > 1;
  for (const d of diagrams) {
    const spec = d.spec as Record<string, unknown> | undefined;
    if (!spec || typeof spec !== "object") continue;
    const bare = d.title || d.nodeId;
    const frame = spanning && d.page ? `${d.page} › ${bare}` : bare;
    const add = (id: unknown, name: unknown, where: string) => {
      if (typeof id === "string" && id && typeof name === "string" && name) {
        out.roles.push({ id, name, where, nodeId: d.nodeId, frame });
      }
    };

    // Policies are kind-agnostic — any diagram can declare one.
    const declared = (spec.options as Record<string, unknown> | undefined)?.policies;
    if (declared && typeof declared === "object" && !Array.isArray(declared)) {
      const referenced = new Set<string>();
      // Each string on its own, never the JSON of the whole spec: serialised,
      // a label that OPENS with the reference ("@hold-minutes phút") has a
      // quote mark in front of the @, which is not a place a reference may
      // begin, so the policy it uses was reported as declared-but-unused.
      collectRefs(spec, referenced);
      for (const [name, value] of Object.entries(declared as Record<string, unknown>)) {
        if (typeof value !== "string" && typeof value !== "number") continue;
        out.policies.push({
          name,
          value,
          used: referenced.has(name.toLowerCase()),
          nodeId: d.nodeId,
          frame,
        });
      }
    }

    // A sitemap contributes no ROLE either — a page is not somebody who does
    // things — so it joins the comparison through `screens` and `policies`,
    // both of which it can answer without inventing an id.
    if (d.kind === "sitemap") {
      for (const p of arr(spec.pages)) {
        const id = str(p.id);
        if (!id) continue;
        out.screens.push({
          id,
          name: str(p.label) || id,
          where: "sitemap page",
          screenIds: strs(p.screenId),
          nodeId: d.nodeId,
          frame,
        });
      }
    } else if (d.kind === "userflow") {
      for (const n of arr(spec.nodes)) {
        const id = str(n.id);
        // `screen` is the default kind, and it is the only one that is a PAGE.
        // A decision diamond, a state, a terminal and an external system are
        // not things an IA has a page for, so feeding them in would report a
        // missing page for every `if` in the flow.
        if (!id || (str(n.kind) || "screen") !== "screen") continue;
        out.screens.push({
          id,
          name: firstLine(str(n.label)) || id,
          where: "userflow screen",
          screenIds: strs(n.screenId),
          nodeId: d.nodeId,
          frame,
        });
      }
    }

    if (d.kind === "sequence") {
      for (const p of arr(spec.participants)) add(p.id, p.name, "sequence participant");
    } else if (d.kind === "activity") {
      for (const l of arr(spec.lanes)) add(l.id, l.label, "activity lane");
    } else if (d.kind === "erd") {
      for (const e of arr(spec.entities)) {
        const entity = str(e.name) || str(e.id);
        if (!entity) continue;
        for (const a of arr(e.attributes)) {
          const values = enumValues(str(a.type));
          if (values.length) {
            out.enums.push({ entity, field: str(a.name), values, nodeId: d.nodeId, frame });
          }
        }
      }
    } else if (d.kind === "state") {
      // `[*]` in the compact form becomes a pair of real nodes, and the end
      // one is kind:"final" — which PSEUDO rightly lets through for a named
      // final state. Those two are still only the notation's dots: the row
      // never holds "__end", and comparing it against the enum reported a
      // drift on every machine written with `-> [*]`.
      const states = arr(spec.states)
        .filter((s) => !PSEUDO.has(str(s.kind)))
        .filter((s) => str(s.id) !== INITIAL && str(s.id) !== FINAL_ID)
        .map((s) => str(s.id))
        .filter(Boolean);
      // What this machine is ABOUT: said outright if the author said it,
      // otherwise the title, which is where people put it in practice
      // ("Booking lifecycle").
      const subject = str(spec.entity) || d.title || "";
      if (states.length) out.lifecycles.push({ subject, states, nodeId: d.nodeId, frame });
    }
  }
  return out;
}

/** `enum(held|paying|paid)` or `enum(held,paying)` → the values. */
export function enumValues(type: string): string[] {
  const m = /^enum\s*\((.+)\)$/i.exec(type.trim());
  if (!m) return [];
  return m[1]!
    .split(/[|,]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Compare names the way a reader does: case and spacing are not the point. */
export function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/** For matching a table against what a state machine calls itself. */
export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}


function collectRefs(v: unknown, into: Set<string>): void {
  if (typeof v === "string") {
    for (const n of refsIn(v)) into.add(n);
  } else if (Array.isArray(v)) {
    for (const x of v) collectRefs(x, into);
  } else if (v && typeof v === "object") {
    for (const x of Object.values(v as Record<string, unknown>)) collectRefs(x, into);
  }
}

function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "");
}

function arr(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Array<Record<string, unknown>>) : [];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * `screenId` is a string OR a list of them, and this layer reads raw stored
 * models, so it normalises rather than importing the sitemap's own helper —
 * `src/shared/sitemap/check.ts` imports `normalize` from here, and depending
 * back on it would close a cycle for four lines of code.
 */
function strs(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : [v];
  return raw.map((x) => str(x).trim()).filter(Boolean);
}

/**
 * What this page knows, and which frames know it.
 *
 * The traceability answer: "the hold becomes 15 minutes — what has to change?"
 * is a lookup here, and the frames it names are the frames to patch. Without
 * it that question is answered by opening five diagrams and reading them,
 * which is exactly the work these tools exist to remove.
 */
export interface PageIndex {
  policies: Array<{
    name: string;
    /** More than one entry means the page disagrees with itself. */
    values: Array<{ value: string | number; frames: string[] }>;
    /** Frames that declare it but never reference it in a label. */
    unused: string[];
  }>;
  roles: Array<{ id: string; names: string[]; frames: string[] }>;
  entities: Array<{ name: string; frames: string[] }>;
}

export function indexPage(diagrams: StoredDiagram[]): PageIndex {
  const facts = collectFacts(diagrams);

  const policies = new Map<string, Map<string, { value: string | number; frames: string[] }>>();
  const unused = new Map<string, string[]>();
  for (const p of facts.policies) {
    const key = p.name.toLowerCase();
    const byValue = policies.get(key) ?? new Map();
    const slot = byValue.get(String(p.value)) ?? { value: p.value, frames: [] };
    if (!slot.frames.includes(p.nodeId)) slot.frames.push(p.nodeId);
    byValue.set(String(p.value), slot);
    policies.set(key, byValue);
    if (!p.used) unused.set(key, [...(unused.get(key) ?? []), p.nodeId]);
  }

  const roles = new Map<string, { names: string[]; frames: string[] }>();
  for (const r of facts.roles) {
    const slot = roles.get(r.id) ?? { names: [], frames: [] };
    if (!slot.names.some((n) => normalize(n) === normalize(r.name))) slot.names.push(r.name);
    if (!slot.frames.includes(r.nodeId)) slot.frames.push(r.nodeId);
    roles.set(r.id, slot);
  }

  const entities = new Map<string, string[]>();
  for (const e of facts.enums) {
    const cur = entities.get(e.entity) ?? [];
    if (!cur.includes(e.nodeId)) cur.push(e.nodeId);
    entities.set(e.entity, cur);
  }
  for (const l of facts.lifecycles) {
    if (!l.subject) continue;
    const cur = entities.get(l.subject) ?? [];
    if (!cur.includes(l.nodeId)) cur.push(l.nodeId);
    entities.set(l.subject, cur);
  }

  return {
    policies: [...policies.entries()].map(([name, byValue]) => ({
      name,
      values: [...byValue.values()],
      unused: unused.get(name) ?? [],
    })),
    roles: [...roles.entries()].map(([id, v]) => ({ id, ...v })),
    entities: [...entities.entries()].map(([name, frames]) => ({ name, frames })),
  };
}
