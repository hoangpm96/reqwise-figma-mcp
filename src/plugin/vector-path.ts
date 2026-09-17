/// <reference types="@figma/plugin-typings" />
/**
 * The one place that turns `[[x,y], ...]` in PARENT space into a VECTOR's
 * node-local path plus its x/y offset. `create` uses it to draw a polyline;
 * the userflow reflow uses it to MOVE one that is already on the canvas, and
 * both must agree on the conversion or a re-routed arrow would land somewhere
 * other than where the layout put it.
 */

export type Point = [number, number];

/** Coerce `[[x,y],...]` / `[{x,y},...]` into plain pairs, dropping junk. */
export function toPoints(raw: unknown): Point[] {
  const pts: Point[] = [];
  if (!Array.isArray(raw)) return pts;
  for (const item of raw) {
    // isFinite, not just typeof number: NaN/Infinity are numbers too, and one
    // would put "M NaN NaN" into the path (or NaN onto the node's x) and the
    // write would throw — "dropping junk" has to mean it.
    if (Array.isArray(item) && Number.isFinite(item[0]) && Number.isFinite(item[1])) {
      pts.push([item[0] as number, item[1] as number]);
    } else if (item && typeof item === "object") {
      const o = item as { x?: unknown; y?: unknown };
      if (Number.isFinite(o.x) && Number.isFinite(o.y)) pts.push([o.x as number, o.y as number]);
    }
  }
  return pts;
}

/**
 * Write a polyline into an existing VECTOR. Assigning `vectorPaths` re-bases
 * the node's box, so x/y is set AFTERWARDS — the ordering is the whole reason
 * this lives in one function.
 */
export function setPolyline(vector: VectorNode, pts: Point[], closed: boolean): void {
  // Nothing to write — with no points, minX/minY would stay Infinity and land
  // on the node's x/y. Callers already warn on too-few points; this is the
  // same no-op setStrokeGroup makes for an empty group.
  if (!pts.length) return;
  let minX = Infinity;
  let minY = Infinity;
  for (const [x, y] of pts) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
  }
  const parts: string[] = [];
  pts.forEach(([x, y], i) => {
    parts.push(`${i === 0 ? "M" : "L"} ${round2(x - minX)} ${round2(y - minY)}`);
  });
  if (closed) parts.push("Z");
  vector.vectorPaths = [{ windingRule: closed ? "NONZERO" : "NONE", data: parts.join(" ") }];
  vector.x = minX;
  vector.y = minY;
}

/**
 * Write a polyline whose LAST point carries the arrow head, as a stroke cap on
 * the line itself rather than a separate triangle beside it.
 *
 * This is what makes an arrow behave like a connector when a person edits it:
 * one layer, so dragging the end drags the head with it. It has to go through
 * `setVectorNetworkAsync` because a per-vertex cap only exists in the vector
 * NETWORK, and under `documentAccess: "dynamic-page"` the network is read-only
 * — hence the only async writer in this file.
 */
export async function setArrowPolyline(
  vector: VectorNode,
  pts: Point[],
  cap: StrokeCap = "ARROW_EQUILATERAL",
): Promise<void> {
  // Nothing to write — see setPolyline: an empty list writes an empty network
  // and then x/y = Infinity.
  if (!pts.length) return;
  let minX = Infinity;
  let minY = Infinity;
  for (const [x, y] of pts) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
  }
  const last = pts.length - 1;
  await vector.setVectorNetworkAsync({
    vertices: pts.map(([x, y], i) => ({
      x: round2(x - minX),
      y: round2(y - minY),
      strokeCap: i === last ? cap : "NONE",
      strokeJoin: "ROUND",
    })),
    segments: pts.slice(1).map((_p, i) => ({ start: i, end: i + 1 })),
    regions: [],
  });
  // Assigning geometry re-bases the node box, so position it afterwards.
  vector.x = minX;
  vector.y = minY;
}

/**
 * Several separate strokes in ONE vector — a crow's foot is two or three
 * little lines that belong together and must move together.
 */
export async function setStrokeGroup(vector: VectorNode, strokes: Point[][]): Promise<void> {
  const flat: Point[] = [];
  for (const s of strokes) for (const p of s) flat.push(p);
  if (!flat.length) return;
  let minX = Infinity;
  let minY = Infinity;
  for (const [x, y] of flat) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
  }
  const vertices: Array<{ x: number; y: number; strokeCap: StrokeCap }> = [];
  const segments: Array<{ start: number; end: number }> = [];
  for (const stroke of strokes) {
    const base = vertices.length;
    for (const [x, y] of stroke) {
      vertices.push({ x: round2(x - minX), y: round2(y - minY), strokeCap: "NONE" });
    }
    for (let i = 1; i < stroke.length; i++) segments.push({ start: base + i - 1, end: base + i });
  }
  await vector.setVectorNetworkAsync({ vertices, segments, regions: [] });
  vector.x = minX;
  vector.y = minY;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
