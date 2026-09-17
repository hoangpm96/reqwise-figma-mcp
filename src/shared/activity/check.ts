/**
 * The proof-reading half of the activity tool.
 *
 * A swimlane diagram fails in ways a flowchart cannot: a step nobody owns, a
 * handoff that does not say WHAT is handed over, a fork that never joins, a
 * lane drawn for a role that turns out to do nothing. Those are process bugs,
 * not drawing bugs, and they are invisible until the lanes are on the page —
 * so they are reported before anything is drawn.
 */
import { adjacency, firstLine, list, reachableFrom } from "../diagram/graph.js";
import type { ActivityEdgeSpec, ActivityNodeSpec, LaneSpec } from "./types.js";

/** The lane a step lands in when the caller named one that does not exist. */
export const UNASSIGNED_LANE = "__unassigned";

export interface ActivityCheck {
  warnings: string[];
  lanes: LaneSpec[];
  nodes: ActivityNodeSpec[];
  edges: ActivityEdgeSpec[];
}

const DEAD_END_OK = new Set(["end", "external"]);

export function checkActivity(
  rawLanes: LaneSpec[],
  rawNodes: ActivityNodeSpec[],
  rawEdges: ActivityEdgeSpec[],
): ActivityCheck {
  const warnings: string[] = [];

  // Lane ids on the steps but no lanes[]: the owners are the caller's own
  // data, so the bands are derived from them rather than refused. Nothing is
  // invented — only the ORDER and the labels are missing, and that is said.
  if (!rawLanes.length) {
    const derived: LaneSpec[] = [];
    const seen = new Set<string>();
    for (const n of rawNodes) {
      const lane = (n.lane ?? "").trim();
      if (!lane || seen.has(lane)) continue;
      seen.add(lane);
      derived.push({ id: lane, label: lane });
    }
    if (derived.length) {
      rawLanes = derived;
      warnings.push(
        `No lanes[] was given, but ${seen.size} step lane id(s) were (${list(derived.map((l) => `"${l.id}"`))}) — bands were derived from them, in the order they first appear, labelled with the id. Declare lanes[] to control the order and give each one a readable name.`,
      );
    }
  }
  const laneless = !rawLanes.length;

  const lanes: LaneSpec[] = [];
  const laneIds = new Set<string>();
  for (const lane of rawLanes) {
    if (laneIds.has(lane.id)) {
      warnings.push(`Duplicate lane id "${lane.id}" — the later declaration was dropped.`);
      continue;
    }
    laneIds.add(lane.id);
    lanes.push(lane);
  }

  const nodes: ActivityNodeSpec[] = [];
  const byId = new Map<string, ActivityNodeSpec>();
  const homeless: string[] = [];
  for (const n of rawNodes) {
    if (byId.has(n.id)) {
      warnings.push(`Duplicate step id "${n.id}" — the later declaration was dropped.`);
      continue;
    }
    // A step whose lane does not exist is NOT quietly filed under the first
    // lane: it is drawn in a visible "(no lane)" band, because "who does this"
    // is the one question this diagram exists to answer. With no lanes at all
    // there is no such question — a plain activity diagram is a legitimate
    // drawing, and every step simply has no owner.
    //
    // A lane-less step carries NO `lane` rather than `lane: ""`. These nodes are
    // the model the frame stores for a later patch, and the schema that patch
    // is validated against wants a lane to be a real id — an empty string made
    // every plain activity diagram impossible to patch. The layout reads a
    // missing lane as "", so nothing downstream sees a difference.
    const lane = (n.lane ?? "").trim();
    let node: ActivityNodeSpec;
    if (laneless) {
      node = { ...n };
      delete node.lane;
    } else {
      node = laneIds.has(lane) ? { ...n, lane } : { ...n, lane: UNASSIGNED_LANE };
    }
    if (node.lane === UNASSIGNED_LANE) {
      homeless.push(lane ? `"${n.id}" (lane "${lane}")` : `"${n.id}" (no lane given)`);
    }
    byId.set(node.id, node);
    nodes.push(node);
  }
  if (homeless.length) {
    warnings.push(
      `No owning lane for ${list(homeless)} — those steps were drawn in a "(no lane)" band. Declare the lane, or move the step to one that exists: an unowned step is a process with no owner.`,
    );
    lanes.push({ id: UNASSIGNED_LANE, label: "(no lane)" });
  }

  const edges: ActivityEdgeSpec[] = [];
  for (const e of rawEdges) {
    const missing = [!byId.has(e.from) ? e.from : null, !byId.has(e.to) ? e.to : null].filter(
      (v): v is string => v !== null,
    );
    if (missing.length) {
      warnings.push(
        `Edge ${e.from} → ${e.to} points at undeclared step ${missing.map((m) => `"${m}"`).join(" and ")} — edge dropped. Declare the step or fix the id.`,
      );
      continue;
    }
    edges.push(e);
  }

  const ids = nodes.map((n) => n.id);
  const { out, inbound } = adjacency(ids, edges);

  const deadEnds: string[] = [];
  const handoffs: string[] = [];
  for (const n of nodes) {
    const kind = n.kind ?? "action";
    const outs = out.get(n.id)!.filter((e) => e.to !== n.id);

    if (kind === "decision" && outs.length < 2) {
      warnings.push(
        `Decision "${n.id}" (${firstLine(n.label)}) has ${outs.length} way out — a question needs at least two. Add the missing branch (the rejection, the timeout, the exception).`,
      );
    }
    if (kind === "decision" && outs.length >= 2) {
      const unlabelled = outs.filter((e) => !e.label || !e.label.trim()).length;
      if (unlabelled) {
        warnings.push(
          `Decision "${n.id}" (${firstLine(n.label)}) has ${unlabelled} of ${outs.length} branches with no label — the reader cannot tell which answer leads where. Label each branch with its condition.`,
        );
      }
    }
    if (outs.length === 0 && !DEAD_END_OK.has(kind)) {
      deadEnds.push(`"${n.id}" (${firstLine(n.label)})`);
    }

    // The handoff is the whole reason to draw lanes: an arrow that changes
    // lane and says nothing leaves the reader guessing what was passed over.
    // With no lanes there are no handoffs to name.
    for (const e of laneless ? [] : outs) {
      const target = byId.get(e.to)!;
      if (target.lane === n.lane) continue;
      if (e.label && e.label.trim()) continue;
      if (kind === "fork" || kind === "join") continue;
      handoffs.push(`${e.from} → ${e.to}`);
    }
  }

  if (deadEnds.length) {
    warnings.push(
      `Dead end — nothing leaves ${list(deadEnds)}. Add the next step, or mark it kind:"end" (the process finishes here) / kind:"external" (it leaves the boundary).`,
    );
  }
  if (handoffs.length) {
    warnings.push(
      `Unlabelled handoff between lanes: ${list(handoffs)}. Say WHAT crosses the lane ("approved PO", "rejection reason", "signed contract") — an unnamed handoff is where processes lose things.`,
    );
  }

  const starts = nodes.filter((n) => (n.kind ?? "action") === "start");
  const ends = nodes.filter((n) => (n.kind ?? "action") === "end");
  if (!starts.length) {
    warnings.push(
      `No kind:"start" step — the reader cannot tell what sets this process off (a request arriving, a schedule, a manual decision). Mark the trigger.`,
    );
  }
  if (starts.length > 1) {
    warnings.push(
      `${starts.length} start steps (${starts.map((n) => `"${n.id}"`).join(", ")}) — that is ${starts.length} different triggers. Intended, or should they be one?`,
    );
  }
  if (!ends.length && nodes.length) {
    warnings.push(
      `No kind:"end" step — every process needs a stated outcome, including the unhappy one (rejected, cancelled, timed out).`,
    );
  }

  // The two terminals mean something only while they ARE terminal. An end
  // with a way out is not where the process finishes, and a start that
  // something loops back into is not what sets it off — the reader of either
  // is told a wrong story about where the process begins and stops. The
  // state checker says the same of a final state that leaks and of a
  // transition into the initial dot.
  const leaky = ends.filter((n) => out.get(n.id)!.length > 0);
  if (leaky.length) {
    warnings.push(
      `End step with a way out: ${list(leaky.map((n) => `"${n.id}" (${firstLine(n.label)})`))}. An end is where the process finishes — if something follows it, it is an ordinary step (or the arrow belongs somewhere else).`,
    );
  }
  const reentered = starts.filter((n) => inbound.get(n.id)!.length > 0);
  if (reentered.length) {
    warnings.push(
      `Arrow INTO a start step: ${list(reentered.map((n) => `"${n.id}" (${firstLine(n.label)}) from ${list(inbound.get(n.id)!.map((e) => `"${e.from}"`))}`))}. The start is the trigger, not somewhere the process returns to — point the arrow at the first real step it goes back to.`,
    );
  }

  const forks = nodes.filter((n) => n.kind === "fork");
  const joinIds = new Set(nodes.filter((n) => n.kind === "join").map((n) => n.id));
  const unjoined: string[] = [];
  for (const f of forks) {
    const reach = reachableFrom([f.id], out);
    let joined = false;
    for (const id of reach) if (joinIds.has(id)) joined = true;
    if (!joined) unjoined.push(`"${f.id}" (${firstLine(f.label)})`);
  }
  if (unjoined.length) {
    warnings.push(
      `Fork with no join downstream: ${list(unjoined)}. Parallel work that never rejoins means nobody waits for it — add the kind:"join", or say why the branches end separately.`,
    );
  }

  const roots = starts.length
    ? starts.map((n) => n.id)
    : nodes.filter((n) => inbound.get(n.id)!.length === 0).map((n) => n.id);
  const seen = reachableFrom(roots.length ? roots : ids.slice(0, 1), out);
  const unreachable = nodes.filter((n) => !seen.has(n.id)).map((n) => `"${n.id}" (${firstLine(n.label)})`);
  if (unreachable.length) {
    warnings.push(
      `Unreachable from the start — no path leads into ${list(unreachable)}. Add the edge that triggers it, or drop the step.`,
    );
  }

  const used = new Set(nodes.map((n) => n.lane));
  const idle = laneless ? [] : lanes.filter((l) => !used.has(l.id)).map((l) => `"${l.id}"`);
  if (idle.length) {
    warnings.push(
      `Lane with no steps: ${list(idle)}. Either the role does something nobody wrote down, or the lane should go.`,
    );
  }
  if (!nodes.length) warnings.push("The process is empty — nothing to draw.");

  return { warnings, lanes, nodes, edges };
}
