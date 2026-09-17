/// <reference types="@figma/plugin-typings" />
/**
 * Re-place a drawn sequence diagram when its participants move.
 *
 * The other reflows re-route arrows between boxes that can be anywhere. Here
 * the geometry is a grid: a participant is a column and a message is a row, so
 * dragging a head sideways moves its lifeline, its activation bars, every
 * arrow that touches it and the fragment boxes that span it — and moves
 * nothing in time, because the row a message sits on IS its order.
 */
import { readDiagramData, SEQUENCE_MARKER } from "./diagram-mark.js";
import { applyEdge, canvasChildren, growToFit, hideEdge, hideLayer, indexChildren, scanBoxes, unhide } from "./diagram-apply.js";
import { setPolyline } from "./vector-path.js";
import { reflowSequence } from "../shared/sequence/layout.js";
import type { FlowClass, Placement } from "../shared/diagram/types.js";
import type { MessageKind, SequenceGraph } from "../shared/sequence/types.js";

export interface SequenceReflowReport {
  frameId: string;
  name: string;
  kind: "sequence";
  changed: boolean;
  routed: number;
  hidden: number;
  missing: string[];
  pinned: string[];
  /** Participants the diagram names but the canvas no longer has. */
  goneBoxes: string[];
}

export function sequenceGraphOf(node: BaseNode): SequenceGraph | null {
  const mark = readDiagramData(node, SEQUENCE_MARKER);
  return mark ? normalizeGraph(mark.graph) : null;
}

export function sequenceFrames(page: PageNode): FrameNode[] {
  const out: FrameNode[] = [];
  for (const child of canvasChildren(page)) {
    if (child.type === "FRAME" && sequenceGraphOf(child)) out.push(child);
  }
  return out;
}

export async function reflowSequenceFrame(
  frame: FrameNode,
  opts?: { grow?: boolean; onlyIfMoved?: boolean; force?: boolean },
): Promise<SequenceReflowReport | null> {
  const graph = sequenceGraphOf(frame);
  if (!graph) return null;

  const byName = indexChildren(frame);
  const scan = scanBoxes(frame, graph.participants, "party:");
  const { placed, goneBoxes } = scan;

  // Not one box found, though the graph names some: this frame is being
  // written, not emptied. Routing on from here would hide every line and
  // nothing would ever bring them back — see scanBoxes.
  if (scan.midWrite) {
    return {
      frameId: frame.id,
      name: frame.name,
      kind: "sequence",
      changed: false,
      routed: 0,
      hidden: 0,
      missing: [],
      pinned: [],
      goneBoxes: [],
    };
  }

  const { participants, messages, activations, fragments, moved, dropped } = reflowSequence(
    graph,
    placed,
  );
  const changed = moved.length > 0 || dropped.length > 0;
  if (opts?.onlyIfMoved && !changed) {
    return {
      frameId: frame.id,
      name: frame.name,
      kind: "sequence",
      changed: false,
      routed: 0,
      hidden: 0,
      missing: [],
      pinned: [],
      goneBoxes,
    };
  }

  // Participants still on the canvas — a deleted head takes its lifeline, its
  // bars and every message touching it with it, decided below.
  const alive = new Set(participants.map((p) => p.id));
  const fragParties = new Map(graph.fragments.map((f) => [f.id, f.parties]));

  // Lifelines first: they are what everything else hangs on.
  for (const p of participants) {
    const line = byName.get(`life ${p.id}`);
    if (line && line.type === "VECTOR") {
      setPolyline(line as VectorNode, [
        [p.lifeline.x, p.lifeline.y],
        [p.lifeline.x, p.lifeline.y + p.lifeline.h],
      ], false);
      unhide(line);
    }
  }

  let routed = 0;
  const missing: string[] = [];
  const pinned: string[] = [];
  for (const m of messages) {
    if (m.points.length < 2) continue;
    const force = opts?.force === true;
    const applied = await applyEdge(
      byName,
      { id: m.id, points: m.points, color: m.color, dashed: m.dashed, label: m.label },
      { force, cap: m.cap },
    );
    if (applied === "moved") routed++;
    else if (applied === "pinned") pinned.push(m.id);
    else missing.push(m.id);

    // The note hangs off the message, so it has to travel with it — dragging
    // a column left its note behind on the first live run.
    const note = byName.get(`note ${m.id}`);
    if (note && m.note) {
      note.x = m.note.x;
      note.y = m.note.y;
      unhide(note);
    }
  }

  for (const b of activations) {
    const bar = byName.get(`bar ${b.id}`);
    if (!bar) continue;
    bar.x = b.at.x;
    bar.y = b.at.y;
    if ("resize" in bar) (bar as RectangleNode).resize(b.at.w, b.at.h);
    unhide(bar);
  }

  for (const f of fragments) {
    // A fragment whose parties are ALL gone has nothing left to span; it is
    // hidden below rather than resized into a one-pixel sliver at x=0.
    if (!(fragParties.get(f.id) ?? []).some((id) => alive.has(id))) continue;
    const box = byName.get(`frag ${f.id}`);
    if (box) {
      box.x = f.at.x;
      box.y = f.at.y;
      if ("resize" in box) (box as FrameNode).resize(Math.max(1, f.at.w), Math.max(1, f.at.h));
      unhide(box);
    }
    const tab = byName.get(`frag-tab ${f.id}`);
    if (tab) {
      tab.x = f.at.x;
      tab.y = f.at.y;
      unhide(tab);
    }
    const divider = byName.get(`frag-else ${f.id}`);
    if (divider && divider.type === "VECTOR" && f.divider) {
      setPolyline(divider as VectorNode, [
        [f.at.x, f.divider.y],
        [f.at.x + f.at.w, f.divider.y],
      ], false);
      unhide(divider);
    }
    const elseLabel = byName.get(`frag-else-label ${f.id}`);
    if (elseLabel && f.divider) {
      elseLabel.x = f.at.x + 10;
      elseLabel.y = f.divider.y - 8;
      unhide(elseLabel);
    }
  }

  let hidden = 0;
  for (const id of dropped) {
    hidden += hideEdge(byName, id);
    // A message's note is a sibling of the line, not part of it — the line's
    // hide does not reach it on its own.
    hidden += hideLayer(byName, `note ${id}`);
  }

  // A participant that is gone takes its lifeline and the bars it carried
  // with it — hidden, not deleted, so an undone delete brings them back.
  for (const p of graph.participants) {
    if (alive.has(p.id)) continue;
    hidden += hideLayer(byName, `life ${p.id}`);
  }
  for (const b of graph.activations) {
    if (alive.has(b.participant)) continue;
    hidden += hideLayer(byName, `bar ${b.id}`);
  }
  for (const f of graph.fragments) {
    if (f.parties.some((id) => alive.has(id))) continue;
    for (const name of [`frag ${f.id}`, `frag-tab ${f.id}`, `frag-else ${f.id}`, `frag-else-label ${f.id}`]) {
      hidden += hideLayer(byName, name);
    }
  }

  if (opts?.grow !== false) growToFit(frame);

  return {
    frameId: frame.id,
    name: frame.name,
    kind: "sequence",
    changed,
    routed,
    hidden,
    missing,
    pinned,
    goneBoxes,
  };
}

// ------------------------------------------------------------- validation ----

const KINDS: MessageKind[] = ["sync", "async", "return"];
const CLASSES: FlowClass[] = ["happy", "error", "edge", "plain", "decision"];

function normalizeGraph(raw: unknown): SequenceGraph | null {
  if (!raw || typeof raw !== "object") return null;
  const g = raw as Record<string, unknown>;
  if (!Array.isArray(g.participants) || !Array.isArray(g.messages)) return null;

  const participants: SequenceGraph["participants"] = [];
  for (const item of g.participants) {
    if (!item || typeof item !== "object") continue;
    const p = item as Record<string, unknown>;
    const at = placement(p.at);
    if (typeof p.id !== "string" || !p.id || !at) continue;
    participants.push({
      id: p.id,
      at,
      lifelineH: typeof p.lifelineH === "number" ? p.lifelineH : 0,
    });
  }
  if (!participants.length) return null;

  const messages: SequenceGraph["messages"] = [];
  for (const item of g.messages) {
    if (!item || typeof item !== "object") continue;
    const m = item as Record<string, unknown>;
    if (typeof m.id !== "string" || typeof m.from !== "string" || typeof m.to !== "string") continue;
    messages.push({
      id: m.id,
      from: m.from,
      to: m.to,
      kind: KINDS.indexOf(m.kind as MessageKind) >= 0 ? (m.kind as MessageKind) : "sync",
      cls: CLASSES.indexOf(m.cls as FlowClass) >= 0 ? (m.cls as FlowClass) : "plain",
      y: typeof m.y === "number" ? m.y : 0,
      labelLines: strings(m.labelLines),
      lw: num(m.lw),
      lh: num(m.lh),
      noteLines: strings(m.noteLines),
      nw: num(m.nw),
      nh: num(m.nh),
    });
  }

  const activations: SequenceGraph["activations"] = [];
  if (Array.isArray(g.activations)) {
    for (const item of g.activations) {
      if (!item || typeof item !== "object") continue;
      const b = item as Record<string, unknown>;
      if (typeof b.id !== "string" || typeof b.participant !== "string") continue;
      activations.push({
        id: b.id,
        participant: b.participant,
        y: num(b.y),
        h: num(b.h),
        depth: num(b.depth),
      });
    }
  }

  const fragments: SequenceGraph["fragments"] = [];
  if (Array.isArray(g.fragments)) {
    for (const item of g.fragments) {
      if (!item || typeof item !== "object") continue;
      const f = item as Record<string, unknown>;
      if (typeof f.id !== "string") continue;
      const divider =
        f.divider && typeof f.divider === "object"
          ? (f.divider as Record<string, unknown>)
          : null;
      fragments.push({
        id: f.id,
        kind: typeof f.kind === "string" ? f.kind : "alt",
        label: typeof f.label === "string" ? f.label : "",
        parties: strings(f.parties),
        top: num(f.top),
        bottom: num(f.bottom),
        tabW: num(f.tabW),
        tabH: num(f.tabH),
        ...(divider && typeof divider.y === "number"
          ? { divider: { y: divider.y, label: typeof divider.label === "string" ? divider.label : "else" } }
          : {}),
      });
    }
  }

  return {
    kind: "sequence",
    liveRoute: g.liveRoute !== false,
    participants,
    messages,
    activations,
    fragments,
  };
}

function strings(raw: unknown): string[] {
  return Array.isArray(raw) ? (raw.filter((v) => typeof v === "string") as string[]) : [];
}

function num(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

function placement(raw: unknown): Placement | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (
    typeof p.x !== "number" ||
    typeof p.y !== "number" ||
    typeof p.w !== "number" ||
    typeof p.h !== "number"
  ) {
    return null;
  }
  return { x: p.x, y: p.y, w: p.w, h: p.h };
}
