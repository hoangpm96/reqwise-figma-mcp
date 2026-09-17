/**
 * Coordinate primitives every diagram router needs: the (along, cross) axis
 * projection that lets one implementation serve both rank directions, the
 * quarter-pixel grid the layout snaps to, path simplification, and the arrow
 * head.
 *
 * `along` runs WITH the rank direction, `cross` across it. A userflow spends
 * cross on its side gutters; an activity diagram spends it on lanes. Writing
 * both routers in (along, cross) means TB and LR are the same code.
 */
import type { DrawEdge, Placement } from "./types.js";

export type Pt = [number, number];

/** Rough length of the arrow head Figma draws as a cap, for bounds padding. */
export const ARROW = 10;

/** Quarter-pixel grid: Figma stores floats, a diagram reads better snapped. */
export const r2 = (v: number): number => Math.round(v * 4) / 4;

/** Axis projection: `along` runs with the ranks, `cross` across them. */
export class Axis {
  constructor(readonly vertical: boolean) {}
  a0(n: Placement): number {
    return this.vertical ? n.y : n.x;
  }
  aLen(n: Placement): number {
    return this.vertical ? n.h : n.w;
  }
  a1(n: Placement): number {
    return this.a0(n) + this.aLen(n);
  }
  aMid(n: Placement): number {
    return this.a0(n) + this.aLen(n) / 2;
  }
  c0(n: Placement): number {
    return this.vertical ? n.x : n.y;
  }
  cLen(n: Placement): number {
    return this.vertical ? n.w : n.h;
  }
  c1(n: Placement): number {
    return this.c0(n) + this.cLen(n);
  }
  cMid(n: Placement): number {
    return this.c0(n) + this.cLen(n) / 2;
  }
  /** (along, cross) → (x, y). */
  pt(a: number, c: number): Pt {
    return this.vertical ? [c, a] : [a, c];
  }
  /** A box from (along, cross) extents. */
  box(a: number, c: number, aLen: number, cLen: number): Placement {
    return this.vertical ? { x: c, y: a, w: cLen, h: aLen } : { x: a, y: c, w: aLen, h: cLen };
  }
  ofA(p: { x: number; y: number }): number {
    return this.vertical ? p.y : p.x;
  }
  ofC(p: { x: number; y: number }): number {
    return this.vertical ? p.x : p.y;
  }
}

/** Drop duplicate and collinear points so the vector path stays small. */
export function simplify(points: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - p[0]) < 0.25 && Math.abs(last[1] - p[1]) < 0.25) continue;
    out.push(p);
  }
  const kept: Pt[] = [];
  for (let i = 0; i < out.length; i++) {
    const prev = kept[kept.length - 1];
    const next = out[i + 1];
    const cur = out[i]!;
    if (prev && next) {
      const collinearX = Math.abs(prev[0] - cur[0]) < 0.25 && Math.abs(cur[0] - next[0]) < 0.25;
      const collinearY = Math.abs(prev[1] - cur[1]) < 0.25 && Math.abs(cur[1] - next[1]) < 0.25;
      if (collinearX || collinearY) continue;
    }
    kept.push(cur);
  }
  return kept;
}


/**
 * One routed polyline → draw data: snap to the grid and place the label pill.
 * Both routers end here, so a userflow and an activity diagram cannot drift
 * apart on arrow geometry. The head is a stroke cap the plugin puts on the
 * last point, so there is nothing to trim off the end here.
 */
export function emitEdge(e: {
  id: string;
  points: Pt[];
  color: string;
  dashed: boolean;
  label?: { at: Pt; w: number; h: number; text: string; muted: boolean } | null;
}): DrawEdge | null {
  if (e.points.length < 2) return null;
  const points: Pt[] = simplify(e.points.map((p) => [r2(p[0]), r2(p[1])] as Pt));
  if (points.length < 2) return null;
  const l = e.label;
  return {
    id: e.id,
    points,
    color: e.color,
    dashed: e.dashed,
    ...(l && l.text
      ? {
          label: {
            x: r2(l.at[0] - l.w / 2),
            y: r2(l.at[1] - l.h / 2),
            w: l.w,
            h: l.h,
            text: l.text,
            muted: l.muted,
          },
        }
      : {}),
  };
}

// ---------------------------------------------------------------- labels ----

export interface LabelledPath {
  points: Pt[];
  /** Label size; 0 means this edge has no label. */
  lw: number;
  lh: number;
  labelAt: Pt | null;
}

/** How much clear space a label claims around itself. */
const LABEL_MARGIN = 3;
/** Fractions along a straight run to try, nearest the middle first. */
const SPOTS = [0.5, 0.35, 0.65, 0.2, 0.8];

/**
 * Move a label off anything it is sitting on.
 *
 * A label pill is opaque, so lying on its OWN arrow is fine — that is how it
 * reads as belonging to it. Lying on somebody else's arrow is not: it hides a
 * line the reader is trying to follow, and looks like a mistake. Each label
 * that collides is walked along its own path until it finds a clear spot.
 *
 * The order of preference matters more than it looks. Leaving the line is the
 * LAST resort, not the second: a label a step off its arrow, in a flow where
 * three arrows leave one diamond, no longer says which branch it names — and
 * that reverses the meaning rather than merely looking untidy. So a spot that
 * merely crosses another LINE is taken before any off-line spot, because the
 * pill masks that line cleanly; only a spot on a BOX or on another label is
 * refused outright.
 */
export function clearLabelOverlaps(edges: LabelledPath[], boxes: Placement[] = []): void {
  const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
  const solid = boxes.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h }));

  edges.forEach((e, index) => {
    if (!e.labelAt || e.lw <= 0 || e.lh <= 0) return;

    const rectAt = (at: Pt): { x: number; y: number; w: number; h: number } => ({
      x: at[0] - e.lw / 2 - LABEL_MARGIN,
      y: at[1] - e.lh / 2 - LABEL_MARGIN,
      w: e.lw + LABEL_MARGIN * 2,
      h: e.lh + LABEL_MARGIN * 2,
    });
    /** A label lying on a BOX hides what the box says; on another label, both. */
    const hitsSolid = (at: Pt): boolean => {
      const rect = rectAt(at);
      for (const other of placed) if (overlaps(rect, other)) return true;
      for (const box of solid) if (overlaps(rect, box)) return true;
      return false;
    };
    /** Somebody else's arrow, which the reader is trying to follow. */
    const hitsOtherLine = (at: Pt): boolean => {
      const rect = rectAt(at);
      for (let i = 0; i < edges.length; i++) {
        if (i === index) continue;
        const pts = edges[i]!.points;
        for (let k = 1; k < pts.length; k++) {
          if (segmentHitsRect(pts[k - 1]!, pts[k]!, rect)) return true;
        }
      }
      return false;
    };

    let chosen = e.labelAt;
    if (hitsSolid(chosen) || hitsOtherLine(chosen)) {
      const runs = e.points
        .slice(1)
        .map((q, i) => ({ p: e.points[i]!, q }))
        .sort(
          (a, b) =>
            Math.abs(b.p[0] - b.q[0]) + Math.abs(b.p[1] - b.q[1]) -
            (Math.abs(a.p[0] - a.q[0]) + Math.abs(a.p[1] - a.q[1])),
        );
      // Beside the line, close enough that the pill still TOUCHES it — a
      // label a whole pill-height away has stopped naming that arrow.
      const beside = e.lh / 2 + 2;
      const off = e.lh + 8;
      // In the order the reader pays for: clear ON the line; on the line but
      // crossing another line (the pill masks it cleanly); just beside the
      // line; and only if the whole path is impossible, clear of it.
      const passes: Array<{ nudge: number; allowLines: boolean }> = [
        { nudge: 0, allowLines: false },
        { nudge: 0, allowLines: true },
        { nudge: beside, allowLines: false },
        { nudge: -beside, allowLines: false },
        { nudge: beside, allowLines: true },
        { nudge: -beside, allowLines: true },
        { nudge: off, allowLines: false },
        { nudge: -off, allowLines: false },
      ];
      outer: for (const pass of passes) {
        for (const run of runs) {
          const vertical = Math.abs(run.p[0] - run.q[0]) < 0.5;
          for (const t of SPOTS) {
            const at: Pt = [
              run.p[0] + (run.q[0] - run.p[0]) * t + (vertical ? pass.nudge : 0),
              run.p[1] + (run.q[1] - run.p[1]) * t + (vertical ? 0 : pass.nudge),
            ];
            if (hitsSolid(at)) continue;
            if (!pass.allowLines && hitsOtherLine(at)) continue;
            chosen = at;
            break outer;
          }
        }
      }
    }

    e.labelAt = chosen;
    placed.push({
      x: chosen[0] - e.lw / 2 - LABEL_MARGIN,
      y: chosen[1] - e.lh / 2 - LABEL_MARGIN,
      w: e.lw + LABEL_MARGIN * 2,
      h: e.lh + LABEL_MARGIN * 2,
    });
  });
}

function overlaps(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Axis-aligned segment against a rect — the segment's own box IS the test. */
function segmentHitsRect(p: Pt, q: Pt, r: { x: number; y: number; w: number; h: number }): boolean {
  const box = {
    x: Math.min(p[0], q[0]),
    y: Math.min(p[1], q[1]),
    w: Math.abs(p[0] - q[0]),
    h: Math.abs(p[1] - q[1]),
  };
  return (
    box.x <= r.x + r.w && box.x + box.w >= r.x && box.y <= r.y + r.h && box.y + box.h >= r.y
  );
}
