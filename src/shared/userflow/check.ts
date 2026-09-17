/**
 * The proof-reading half of the userflow tool. A userflow drawn from an
 * agent's business analysis fails in predictable ways — a question with only
 * one way out, a screen nobody can reach, a branch that just stops — and those
 * holes are invisible until the arrows are on the page. Reported BEFORE
 * drawing so the agent can go back to the spec and fill the gap.
 */
import type { FlowEdgeSpec, FlowNodeSpec } from "./types.js";
import { firstLine, list } from "../diagram/graph.js";

export interface CheckResult {
  warnings: string[];
  /** Edges whose endpoints all exist — the only ones safe to lay out. */
  edges: FlowEdgeSpec[];
  /** Nodes with a unique id, first declaration wins. */
  nodes: FlowNodeSpec[];
}

const DEAD_END_OK = new Set(["external", "terminal"]);

export function checkGraph(
  rawNodes: FlowNodeSpec[],
  rawEdges: FlowEdgeSpec[],
): CheckResult {
  const warnings: string[] = [];
  const nodes: FlowNodeSpec[] = [];
  const byId = new Map<string, FlowNodeSpec>();
  for (const n of rawNodes) {
    if (byId.has(n.id)) {
      warnings.push(`Duplicate node id "${n.id}" — the later declaration was dropped.`);
      continue;
    }
    byId.set(n.id, n);
    nodes.push(n);
  }

  const edges: FlowEdgeSpec[] = [];
  for (const e of rawEdges) {
    const missing = [!byId.has(e.from) ? e.from : null, !byId.has(e.to) ? e.to : null]
      .filter((v): v is string => v !== null);
    if (missing.length) {
      warnings.push(
        `Edge ${e.from} → ${e.to} points at undeclared node ${missing.map((m) => `"${m}"`).join(" and ")} — edge dropped. Declare the node or fix the id.`,
      );
      continue;
    }
    edges.push(e);
  }

  const out = new Map<string, FlowEdgeSpec[]>();
  const inbound = new Map<string, FlowEdgeSpec[]>();
  for (const n of nodes) {
    out.set(n.id, []);
    inbound.set(n.id, []);
  }
  for (const e of edges) {
    out.get(e.from)!.push(e);
    inbound.get(e.to)!.push(e);
  }

  const noScreenId: string[] = [];
  const deadEnds: string[] = [];
  for (const n of nodes) {
    const outs = out.get(n.id)!.filter((e) => e.to !== n.id);
    const selfLoops = out.get(n.id)!.filter((e) => e.to === n.id);
    if (n.kind === "decision" && outs.length < 2 && selfLoops.length) {
      // The branch IS there — it just asks the same question again, which no
      // user can act on. "Has 1 way out, add the no case" sent authors
      // looking for a branch they had already written.
      const back = inbound.get(n.id)!.find((e) => e.from !== n.id)?.from;
      const label = selfLoops[0]!.label ? ` "${selfLoops[0]!.label}"` : "";
      warnings.push(
        `Decision "${n.id}" (${firstLine(n.label)}): the branch${label} loops straight back to the same question, so it is not a way out. Point it at the step where the user fixes things${back ? ` (e.g. back to "${back}")` : ""}.`,
      );
    } else if (n.kind === "decision" && outs.length < 2) {
      warnings.push(
        `Decision "${n.id}" (${firstLine(n.label)}) has ${outs.length} way out — a question needs at least two. Add the missing branch (the "no" / error / timeout case).`,
      );
    }
    // A question whose branches are unlabelled draws fine and reads as
    // nonsense: the diagram shows THAT it splits, never on what.
    if (n.kind === "decision" && outs.length >= 2) {
      const unlabelled = outs.filter((e) => !e.label || !e.label.trim()).length;
      if (unlabelled) {
        warnings.push(
          `Decision "${n.id}" (${firstLine(n.label)}) has ${unlabelled} of ${outs.length} branches with no label — the reader cannot tell which answer leads where. Label each branch with its condition ("yes"/"no", "valid"/"expired").`,
        );
      }
      const seen = new Set<string>();
      const dupes = new Set<string>();
      for (const e of outs) {
        const key = (e.label ?? "").trim().toLowerCase();
        if (!key) continue;
        if (seen.has(key)) dupes.add(key);
        seen.add(key);
      }
      if (dupes.size) {
        warnings.push(
          `Decision "${n.id}" (${firstLine(n.label)}) has two branches labelled the same (${[...dupes].map((d) => `"${d}"`).join(", ")}) — one of the conditions is wrong or the branches should be merged.`,
        );
      }
    }
    if (outs.length === 0 && !DEAD_END_OK.has(n.kind ?? "screen")) {
      deadEnds.push(`"${n.id}" (${firstLine(n.label)})`);
    }
    if ((n.kind ?? "screen") === "screen" && !n.screenId && !n.slug) {
      noScreenId.push(n.id);
    }
  }
  if (deadEnds.length) {
    warnings.push(
      `Dead end — nothing leaves ${list(deadEnds)}. Add the next step, or mark the node kind:"terminal" (the flow ends here) / kind:"external" (it leaves the product).`,
    );
  }
  if (noScreenId.length) {
    warnings.push(
      `No screenId/slug on ${list(noScreenId.map((id) => `"${id}"`))} — the reader cannot trace those boxes back to an artboard. Give each the id you will name its artboard with.`,
    );
  }

  // A dashed `return` (retry, go back) is a way BACK, not a way in: counting
  // it made the first screen of every flow with a retry loop look reachable
  // only from inside, and the flow was reported as having no entry point.
  const starts = nodes.filter((n) => inbound.get(n.id)!.every((e) => e.kind === "return"));
  const roots = starts.length ? starts : nodes.slice(0, 1);
  const seen = new Set<string>();
  const queue = roots.map((n) => n.id);
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of out.get(id) ?? []) queue.push(e.to);
  }
  const unreachable: string[] = [];
  for (const n of nodes) {
    if (!seen.has(n.id)) unreachable.push(`"${n.id}" (${firstLine(n.label)})`);
  }
  if (unreachable.length) {
    warnings.push(
      `Unreachable from the start — no path leads into ${list(unreachable)}. Add the entry edge, or drop the node.`,
    );
  }
  if (!starts.length && nodes.length > 0) {
    warnings.push(
      `Every node has something leading into it, so the flow has no entry point — it is a closed loop. Mark where the user actually arrives (a screen with no inbound edge), or the reader cannot tell where to start reading.`,
    );
  }
  if (starts.length > 1) {
    warnings.push(
      `${starts.length} nodes have no way in (${starts.map((n) => `"${n.id}"`).join(", ")}) — that is ${starts.length} separate entry points. Intended, or is an edge missing?`,
    );
  }
  if (!nodes.length) {
    warnings.push("The graph is empty — nothing to draw.");
  }

  return { warnings, edges, nodes };
}
