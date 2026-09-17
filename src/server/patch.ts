/**
 * Change one thing in a drawn diagram without re-authoring it.
 *
 * The frame stores the model it was made from, so "the finding says this
 * handoff has no label" is a patch against that model rather than the whole
 * spec sent again. On the ticket-booking set, 73% of the JSON an agent emitted
 * was a spec it had already emitted; this is what that number was measuring.
 *
 * Deliberately kind-agnostic: a collection is just an array on the spec, so
 * `messages`, `entities`, `transitions` and `links` all work here without this
 * module knowing what any of them mean. The rebuild that follows is what
 * decides whether the result is a legal diagram — a patch is only allowed to
 * produce a spec, never to skip the checker.
 */
import { OpError } from "./errors.js";
import { ErrorCode } from "../shared/protocol.js";

/** How a patch names the member it acts on. */
export interface PatchSelector {
  /** Match `member.id`. The usual case, where the collection has ids. */
  id?: string;
  /** Match by position, 0-based. The fallback for collections without ids. */
  at?: number;
  /** Match the first member whose every listed field is equal. */
  where?: Record<string, unknown>;
}

export interface PatchOp extends PatchSelector {
  /** The array to act on. Omit to act on the spec itself (title, options, …). */
  collection?: string;
  /**
   * Merge these fields into the selected member (or into the spec root).
   *
   * A dotted key reaches inside, through objects and through lists by index:
   * `"options.policies.hold-minutes": 15` changes one rule without resending
   * the rest of `options`, and `"attributes.2.type": "enum(a|b)"` changes one
   * column without resending the table.
   *
   * `null` REMOVES a field, since JSON has no way to say `undefined` — which
   * is how a state stops being `final`, or a message stops being a `return`.
   */
  set?: Record<string, unknown>;
  /** Append a new member. `after` says where; the end, by default. */
  add?: Record<string, unknown>;
  after?: string | PatchSelector;
  /** Drop a member: the id, or `true` with `at`/`where`. */
  remove?: string | boolean;
}

export interface PatchResult {
  spec: Record<string, unknown>;
  /** One line per op, in order — what the agent asked for, as applied. */
  applied: string[];
}

/**
 * Apply the ops in order to a copy of the stored spec.
 *
 * In order matters and is not an implementation detail: `add` then `set` on the
 * thing just added is the obvious way to write a two-step change, and an `at:`
 * index means the position at the time that op runs.
 */
export function applyPatch(stored: unknown, ops: unknown): PatchResult {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    throw new OpError(
      ErrorCode.INVALID_PARAMS,
      "The frame did not give back a model to patch.",
      "Redraw it once with the full spec and the frame will carry its model from then on.",
    );
  }
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new OpError(
      ErrorCode.INVALID_PARAMS,
      "`patch` must be a non-empty array of operations.",
      'e.g. patch: [{ collection: "edges", where: { from: "draft", to: "review" }, set: { label: "the draft" } }].',
    );
  }

  const spec = structuredClone(stored) as Record<string, unknown>;
  const applied: string[] = [];
  ops.forEach((raw, i) => applied.push(applyOne(spec, raw as PatchOp, i)));
  return { spec, applied };
}

function applyOne(spec: Record<string, unknown>, op: PatchOp, i: number): string {
  const at = `patch[${i}]`;
  if (!op || typeof op !== "object") {
    throw new OpError(ErrorCode.INVALID_PARAMS, `${at} is not an operation object.`, SHAPE);
  }

  const verbs = ["set", "add", "remove"].filter((v) => op[v as "set"] !== undefined);
  if (verbs.length !== 1) {
    throw new OpError(
      ErrorCode.INVALID_PARAMS,
      verbs.length === 0
        ? `${at} says nothing to do — it needs one of \`set\`, \`add\` or \`remove\`.`
        : `${at} asks for ${verbs.join(" and ")} at once; each op does one thing.`,
      SHAPE,
    );
  }

  // No collection: the op is about the spec itself — the title, the system
  // boundary, an option. Only `set` makes sense there.
  if (op.collection === undefined) {
    if (!op.set) {
      throw new OpError(
        ErrorCode.INVALID_PARAMS,
        `${at} has no \`collection\`, so it can only \`set\` fields on the diagram itself.`,
        'e.g. { set: { title: "Booking lifecycle" } }, or name a collection to change its members.',
      );
    }
    assign(spec, op.set);
    return `set ${Object.keys(op.set).join(", ")} on the diagram`;
  }

  const list = collectionOf(spec, op.collection, at);

  if (op.add !== undefined) {
    if (!op.add || typeof op.add !== "object" || Array.isArray(op.add)) {
      throw new OpError(ErrorCode.INVALID_PARAMS, `${at}: \`add\` must be an object.`, SHAPE);
    }
    const where = op.after === undefined ? list.length : after(list, op.after, op.collection, at) + 1;
    list.splice(where, 0, op.add);
    return `added ${describe(op.add)} to ${op.collection} at ${where}`;
  }

  if (op.remove !== undefined) {
    const sel: PatchSelector = typeof op.remove === "string" ? { id: op.remove } : op;
    const idx = select(list, sel, op.collection, at);
    const [gone] = list.splice(idx, 1);
    return `removed ${describe(gone)} from ${op.collection}`;
  }

  if (!op.set || typeof op.set !== "object" || Array.isArray(op.set)) {
    throw new OpError(ErrorCode.INVALID_PARAMS, `${at}: \`set\` must be an object of fields.`, SHAPE);
  }
  const idx = select(list, op, op.collection, at);
  const member = list[idx];
  if (!member || typeof member !== "object") {
    throw new OpError(ErrorCode.INVALID_PARAMS, `${at}: ${op.collection}[${idx}] is not an object.`, SHAPE);
  }
  const renames = plannedRenames(spec, op.collection, member as Record<string, unknown>, op.set, at);
  assign(member as Record<string, unknown>, op.set);
  const line = `set ${Object.keys(op.set).join(", ")} on ${op.collection} ${describe(member)}`;
  const cascaded = renames.map((r) => r(member as Record<string, unknown>));
  return cascaded.length ? `${line}; ${cascaded.join("; ")}` : line;
}

/**
 * Who refers to the members of a collection by id, per collection name.
 *
 * An id is not just a label on its member: messages name participants by it,
 * edges name nodes, fragments name messages. Renaming one through `set` and
 * leaving the references on the old id made every one of them point at
 * nothing — and the builders DROP an arrow whose end is unknown, so a sequence
 * silently lost its messages. A rename therefore carries its references with
 * it, the way renaming a symbol in an editor does.
 *
 * Keyed by collection name rather than by kind, which keeps this module
 * kind-agnostic: the names do not collide across kinds (`nodes` → `edges` is
 * the same relation in activity and userflow). `namespace` is every
 * collection whose ids the references resolve against — a usecase link's end
 * may be an actor OR a use case, so an id taken by either is taken.
 * `path` is dotted, and may end on a string or on a list of strings.
 */
const REFERENCES: Record<string, { noun: string; namespace: string[]; refs: Array<[string, string]> }> = {
  participants: { noun: "participant", namespace: ["participants"], refs: [["messages", "from"], ["messages", "to"]] },
  messages: { noun: "message", namespace: ["messages"], refs: [["fragments", "messages"], ["fragments", "else.messages"]] },
  lanes: { noun: "lane", namespace: ["lanes"], refs: [["nodes", "lane"]] },
  nodes: { noun: "node", namespace: ["nodes"], refs: [["edges", "from"], ["edges", "to"]] },
  states: { noun: "state", namespace: ["states"], refs: [["transitions", "from"], ["transitions", "to"]] },
  entities: { noun: "entity", namespace: ["entities"], refs: [["relations", "from"], ["relations", "to"]] },
  actors: { noun: "actor", namespace: ["actors", "useCases"], refs: [["links", "from"], ["links", "to"]] },
  useCases: { noun: "use case", namespace: ["actors", "useCases"], refs: [["links", "from"], ["links", "to"]] },
  pages: { noun: "page", namespace: ["pages"], refs: [["pages", "parent"]] },
};

/**
 * Look at a `set` BEFORE it is applied and return the cascades it implies —
 * each one runs after the assign and reports what it rewrote.
 *
 * The old values have to be read before the merge overwrites them, and a
 * rename onto an id that is already taken has to be refused before anything
 * moves: two members with one id would make every reference to it ambiguous,
 * and the cascade would merge two things the author kept apart.
 */
function plannedRenames(
  spec: Record<string, unknown>,
  collection: string,
  member: Record<string, unknown>,
  set: Record<string, unknown>,
  at: string,
): Array<(member: Record<string, unknown>) => string> {
  const out: Array<(member: Record<string, unknown>) => string> = [];
  const table = REFERENCES[collection];
  const oldId = member.id;
  const newId = set.id;

  if (typeof oldId === "string" && typeof newId === "string" && newId !== oldId) {
    const namespace = table?.namespace ?? [collection];
    for (const name of namespace) {
      const taken = Array.isArray(spec[name])
        && (spec[name] as unknown[]).some((m) => m !== member && isObj(m) && m.id === newId);
      if (taken) {
        throw new OpError(
          ErrorCode.INVALID_PARAMS,
          `${at}: cannot rename ${JSON.stringify(oldId)} to ${JSON.stringify(newId)} — \`${name}\` already has a member with that id.`,
          "Ids have to stay unique: every reference to one would otherwise be ambiguous. Pick another id, or remove the other member first.",
        );
      }
    }
    if (table) {
      out.push(() => {
        let n = 0;
        for (const [refCollection, path] of table.refs) {
          n += rewrite(spec[refCollection], path, (v) => v === oldId, newId);
        }
        return `renamed ${table.noun} ${oldId} → ${newId} (${references(n)})`;
      });
    }
  }

  // An ERD column has no id — its NAME is what `relations[].fromField/toField`
  // point at, so renaming it strands the line on a column that no longer
  // exists. Only a rename addressed to ONE column by index is followed
  // (`"attributes.2.name"` or `"attributes.2": {…}`): replacing the whole list
  // could be a reorder as easily as a rename, and guessing which would
  // rewrite relations the author never touched.
  if (collection === "entities" && Array.isArray(member.attributes)) {
    const attrs = member.attributes as unknown[];
    for (const key of Object.keys(set)) {
      const m = /^attributes\.(\d+)(\.name)?$/.exec(key);
      if (!m) continue;
      const i = Number(m[1]);
      const before = attrs[i];
      if (!isObj(before) || typeof before.name !== "string") continue;
      const value = set[key];
      const after = m[2] ? value : isObj(value) ? value.name : undefined;
      if (typeof after !== "string" || after === before.name) continue;
      const oldName = before.name;
      out.push((changed) => {
        // The entity may have been renamed by the same `set`; the relations
        // were already moved to the new id by the cascade above.
        const entity = changed.id;
        let n = 0;
        for (const rel of Array.isArray(spec.relations) ? (spec.relations as unknown[]) : []) {
          if (!isObj(rel)) continue;
          if (rel.from === entity && rel.fromField === oldName) {
            rel.fromField = after;
            n++;
          }
          if (rel.to === entity && rel.toField === oldName) {
            rel.toField = after;
            n++;
          }
        }
        return `renamed column ${String(entity)}.${oldName} → ${after} (${references(n)})`;
      });
    }
  }
  return out;
}

/** Replace every string at `path` in each member that matches; count them. */
function rewrite(list: unknown, path: string, match: (v: unknown) => boolean, to: string): number {
  if (!Array.isArray(list)) return 0;
  let n = 0;
  const steps = path.split(".");
  const last = steps.pop()!;
  for (const m of list) {
    let cur: unknown = m;
    for (const step of steps) cur = isObj(cur) ? cur[step] : undefined;
    if (!isObj(cur)) continue;
    const value = cur[last];
    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        if (match(v)) {
          value[i] = to;
          n++;
        }
      });
    } else if (match(value)) {
      cur[last] = to;
      n++;
    }
  }
  return n;
}

function references(n: number): string {
  return n === 1 ? "1 reference" : `${n} references`;
}

/**
 * The named array, or an error that lists the ones this diagram actually has —
 * the collections differ per kind, and guessing `nodes` on a sequence diagram
 * is the mistake this message exists to answer.
 */
function collectionOf(
  spec: Record<string, unknown>,
  name: string,
  at: string,
): Array<unknown> {
  const value = spec[name];
  if (Array.isArray(value)) return value as unknown[];
  const have = Object.keys(spec).filter((k) => Array.isArray(spec[k]));
  throw new OpError(
    ErrorCode.INVALID_PARAMS,
    value === undefined
      ? `${at}: this diagram has no \`${name}\` collection.`
      : `${at}: \`${name}\` is not a collection on this diagram.`,
    have.length
      ? `It has: ${have.join(", ")}. Read the model first with figma_read op:"get_diagram_spec".`
      : 'Read the model first with figma_read op:"get_diagram_spec".',
  );
}

/** Resolve a selector to an index, or explain why it matched nothing. */
function select(
  list: unknown[],
  sel: PatchSelector,
  collection: string,
  at: string,
): number {
  const given = ["id", "at", "where"].filter((k) => sel[k as "id"] !== undefined);
  if (given.length !== 1) {
    throw new OpError(
      ErrorCode.INVALID_PARAMS,
      given.length === 0
        ? `${at} does not say WHICH member of \`${collection}\` to change.`
        : `${at} names the member ${given.length} ways (${given.join(", ")}); pick one.`,
      'Use `id` when the members have ids, `where: { from, to }` to match on fields, or `at: <index>` for position.',
    );
  }

  if (sel.at !== undefined) {
    const i = sel.at;
    if (!Number.isInteger(i) || i < 0 || i >= list.length) {
      throw new OpError(
        ErrorCode.INVALID_PARAMS,
        `${at}: \`at: ${i}\` is outside \`${collection}\`, which has ${list.length} member(s).`,
        "Indices are 0-based, and shift as earlier ops in the same patch add or remove members.",
      );
    }
    return i;
  }

  if (sel.id !== undefined) {
    const i = list.findIndex((m) => isObj(m) && m.id === sel.id);
    if (i >= 0) return i;
    const ids = list.filter(isObj).map((m) => m.id).filter((v) => typeof v === "string");
    throw new OpError(
      ErrorCode.INVALID_PARAMS,
      `${at}: no member of \`${collection}\` has id ${JSON.stringify(sel.id)}.`,
      ids.length
        ? `Ids here: ${ids.slice(0, 20).join(", ")}${ids.length > 20 ? ", …" : ""}.`
        : `Members of \`${collection}\` have no ids — select them with \`where\` (e.g. { from, to }) or \`at\`.`,
    );
  }

  const want = sel.where as Record<string, unknown>;
  const keys = Object.keys(want);
  if (!keys.length) {
    throw new OpError(ErrorCode.INVALID_PARAMS, `${at}: \`where\` is empty.`, SHAPE);
  }
  const hits: number[] = [];
  list.forEach((m, i) => {
    if (isObj(m) && keys.every((k) => m[k] === want[k])) hits.push(i);
  });
  if (hits.length === 1) return hits[0]!;
  throw new OpError(
    ErrorCode.INVALID_PARAMS,
    hits.length === 0
      ? `${at}: nothing in \`${collection}\` matches ${JSON.stringify(want)}.`
      : `${at}: ${hits.length} members of \`${collection}\` match ${JSON.stringify(want)}, so it is ambiguous.`,
    hits.length === 0
      ? 'Read the model back with figma_read op:"get_diagram_spec" and match on fields that are actually there.'
      : `Add a field that tells them apart, or use \`at\` (they are at ${hits.join(", ")}).`,
  );
}

function after(
  list: unknown[],
  sel: string | PatchSelector,
  collection: string,
  at: string,
): number {
  return select(list, typeof sel === "string" ? { id: sel } : sel, collection, `${at} \`after\``);
}

/** A member named the way the agent will recognise it in the result. */
function describe(m: unknown): string {
  if (!isObj(m)) return JSON.stringify(m);
  if (typeof m.id === "string") return m.id;
  if (typeof m.from === "string" && typeof m.to === "string") return `${m.from}→${m.to}`;
  if (typeof m.label === "string") return JSON.stringify(m.label);
  return JSON.stringify(m).slice(0, 60);
}

/**
 * Merge fields in, following a dotted key into nested objects.
 *
 * A plain `Object.assign` on `{ options: {...} }` replaces the whole of
 * `options`, so changing one rule would mean resending every other option —
 * which is the re-emission this whole path exists to avoid. Missing levels are
 * created; a level that exists but is not an object is refused rather than
 * silently overwritten.
 */
function assign(target: Record<string, unknown>, fields: Record<string, unknown>): void {
  // Keys in one `set` read as simultaneous, so every index means the list as
  // it was when the call was made. Removing as we went shifted the rest:
  // {"attributes.1": null, "attributes.2": null} removed b and d, not b and c.
  // Removals are collected and applied last, highest index first.
  const removals = new Map<unknown[], Set<number>>();
  for (const [key, value] of Object.entries(fields)) {
    const path = key.split(".");
    const last = path.pop()!;
    // Prototype-pollution guard: "__proto__" as an intermediate step resolves
    // to Object.prototype and the write lands globally; as a leaf it rewrites
    // the spec object's own prototype. Both are refused (constructor/prototype
    // too — a spec never has those fields).
    if (path.concat(last).some((s) => FORBIDDEN_KEYS.has(s))) {
      throw new OpError(
        ErrorCode.INVALID_PARAMS,
        `Cannot set \`${key}\`: that path segment is not allowed.`,
        "Keys may not walk into __proto__, constructor or prototype.",
      );
    }
    let cur: Record<string, unknown> | unknown[] = target;

    for (const step of path) {
      const next = (cur as Record<string, unknown>)[step];
      if (next === undefined || next === null) {
        if (Array.isArray(cur)) {
          throw new OpError(
            ErrorCode.INVALID_PARAMS,
            `Cannot set \`${key}\`: there is no index ${step} in that list.`,
            "A list index has to already exist — use `add` to append a member, then set fields on it.",
          );
        }
        const made: Record<string, unknown> = {};
        (cur as Record<string, unknown>)[step] = made;
        cur = made;
      } else if (isObj(next) || Array.isArray(next)) {
        cur = next as Record<string, unknown> | unknown[];
      } else {
        throw new OpError(
          ErrorCode.INVALID_PARAMS,
          `Cannot set \`${key}\`: \`${step}\` is a ${typeof next}, not an object or a list.`,
          "A dotted key walks into nested objects and into lists by index. Set the whole field instead, or pick a path that exists.",
        );
      }
    }

    // `null` means REMOVE. JSON cannot carry `undefined`, so without this
    // there is no way to make a state stop being `final` or a message stop
    // being a `return` — the field could only ever be changed, never dropped.
    if (Array.isArray(cur)) {
      // A list leaf is an existing index, like the steps above: `delete` left
      // a hole that serialised as null, and a far index padded with holes.
      const i = /^\d+$/.test(last) ? Number(last) : -1;
      if (i < 0 || i >= cur.length) {
        throw new OpError(
          ErrorCode.INVALID_PARAMS,
          `Cannot set \`${key}\`: there is no index ${last} in that list.`,
          "A list index has to already exist — use `add` to append a member, then set fields on it.",
        );
      }
      if (value === null) {
        const at = removals.get(cur) ?? new Set<number>();
        at.add(i);
        removals.set(cur, at);
      } else cur[i] = value;
    } else if (value === null) delete (cur as Record<string, unknown>)[last];
    else (cur as Record<string, unknown>)[last] = value;
  }
  for (const [list, at] of removals) {
    for (const i of [...at].sort((a, b) => b - a)) list.splice(i, 1);
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const SHAPE =
  'Each op is one of: { collection, id|at|where, set:{…} }, { collection, add:{…}, after? } or { collection, remove: id }. Omit `collection` to set a field on the diagram itself. A dotted key in `set` reaches into nested objects and lists (`"attributes.2.type"`); `null` removes a field.';
