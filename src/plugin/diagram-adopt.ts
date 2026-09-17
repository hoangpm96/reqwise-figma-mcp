/// <reference types="@figma/plugin-typings" />
/**
 * Reading a hand-dragged arrow as an instruction.
 *
 * This is the draw.io behaviour: drag an arrow's end onto another part of a
 * box and the line RECONNECTS — it does not stay as you dropped it and it does
 * not spring back. What was dragged is a connection point, so that is what is
 * kept: the face and the position along it are written into the diagram's
 * stored graph, and the line is re-routed through them. Move the boxes
 * afterwards and the arrow still follows, from the point you chose.
 *
 * An edit that cannot be read as a connection point — a middle bend nudged,
 * the whole line parked somewhere — is left exactly as it is instead. Guessing
 * would throw away work somebody did on purpose.
 */
import { nearestPort, type Port } from "../shared/diagram/connector.js";
import type { Placement } from "../shared/diagram/types.js";
import { readEdgePath } from "./diagram-apply.js";

/** How far from a box's edge a dropped end still counts as attached to it. */
const ATTACH_TOLERANCE = 44;
/** Movement below this is our own rounding, not a person. */
const MOVED = 1.5;

export interface PortWish {
  fromPort?: Port;
  toPort?: Port;
}

export interface Adoption {
  /** edge id → the connection point(s) somebody set by dragging. */
  ports: Map<string, PortWish>;
  /** Edge ids whose edit says nothing about attachment: leave them alone. */
  unreadable: string[];
}

export function adoptHandEdits(input: {
  byName: Map<string, SceneNode>;
  /** Drawn edges in graph order: the id, and the boxes at either end. */
  edges: Array<{ id: string; from: string; to: string }>;
  boxes: Map<string, Placement>;
  /** The route we WOULD draw now, per edge id — the thing an edit differs from. */
  expected: Map<string, Array<[number, number]>>;
  edited: (id: string) => boolean;
}): Adoption {
  const ports = new Map<string, PortWish>();
  const unreadable: string[] = [];

  for (const e of input.edges) {
    if (!input.edited(e.id)) continue;
    const line = input.byName.get(`edge ${e.id}`);
    const from = input.boxes.get(e.from);
    const to = input.boxes.get(e.to);
    const path = line ? readEdgePath(line) : null;
    const expected = input.expected.get(e.id);
    if (!path || !expected || !from || !to || expected.length < 2) {
      if (line) unreadable.push(e.id);
      continue;
    }

    const movedStart = apart(path[0]!, expected[0]!);
    const movedEnd = apart(path[path.length - 1]!, expected[expected.length - 1]!);
    if (!movedStart && !movedEnd) {
      // The ends are where we put them, so the change is in the middle: that
      // is a shape somebody chose, and nothing here can improve on it.
      unreadable.push(e.id);
      continue;
    }

    const wish: PortWish = {};
    if (movedStart) {
      const port = nearestPort(from, path[0]!, ATTACH_TOLERANCE);
      if (!port) {
        unreadable.push(e.id);
        continue;
      }
      wish.fromPort = port;
    }
    if (movedEnd) {
      const port = nearestPort(to, path[path.length - 1]!, ATTACH_TOLERANCE);
      if (!port) {
        unreadable.push(e.id);
        continue;
      }
      wish.toPort = port;
    }
    ports.set(e.id, wish);
  }

  return { ports, unreadable };
}

function apart(a: [number, number], b: [number, number]): boolean {
  return Math.hypot(a[0] - b[0], a[1] - b[1]) > MOVED;
}
