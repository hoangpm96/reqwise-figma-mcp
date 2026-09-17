import { describe, expect, it } from "vitest";
import {
  SIDES,
  connectPorts,
  nearestPort,
  outward,
  portPoint,
  type Side,
} from "../../src/shared/diagram/connector.js";

/**
 * The connector that runs between two CHOSEN points. Everything here is about
 * one promise: whatever faces somebody picks, the line leaves that face, comes
 * into the other one, and every segment stays axis-aligned. That promise is
 * what makes a dragged arrow head reconnect instead of dangling.
 */

const A = { x: 0, y: 0, w: 120, h: 60 };
const near = (a: number, b: number) => Math.abs(a - b) < 0.01;

describe("portPoint", () => {
  it("puts a port on the face it names", () => {
    expect(portPoint(A, { side: "top", at: 0 })).toEqual([0, 0]);
    expect(portPoint(A, { side: "top", at: 1 })).toEqual([120, 0]);
    expect(portPoint(A, { side: "bottom", at: 0.5 })).toEqual([60, 60]);
    expect(portPoint(A, { side: "left", at: 0.5 })).toEqual([0, 30]);
    expect(portPoint(A, { side: "right", at: 1 })).toEqual([120, 60]);
  });

  it("treats a nonsense position as the middle", () => {
    expect(portPoint(A, { side: "top", at: NaN })).toEqual([60, 0]);
    expect(portPoint(A, { side: "top", at: 5 })).toEqual([120, 0]);
  });
});

describe("connectPorts", () => {
  /** Every arrangement of two boxes worth routing between. */
  const layouts: Array<{ name: string; to: typeof A }> = [
    { name: "target to the right", to: { x: 300, y: 0, w: 120, h: 60 } },
    { name: "target to the left", to: { x: -300, y: 0, w: 120, h: 60 } },
    { name: "target below", to: { x: 0, y: 250, w: 120, h: 60 } },
    { name: "target above", to: { x: 0, y: -250, w: 120, h: 60 } },
    { name: "target down-right", to: { x: 320, y: 240, w: 120, h: 60 } },
    { name: "target up-left", to: { x: -320, y: -240, w: 120, h: 60 } },
    { name: "target overlapping in x", to: { x: 40, y: 220, w: 120, h: 60 } },
  ];

  for (const layout of layouts) {
    for (const fromSide of SIDES) {
      for (const toSide of SIDES) {
        it(`${layout.name}: ${fromSide} → ${toSide}`, () => {
          const from = { box: A, port: { side: fromSide as Side, at: 0.5 } };
          const to = { box: layout.to, port: { side: toSide as Side, at: 0.5 } };
          const pts = connectPorts(from, to);

          // Starts and ends exactly on the two chosen points.
          expect(pts[0]).toEqual(portPoint(A, from.port));
          expect(pts[pts.length - 1]).toEqual(portPoint(layout.to, to.port));
          expect(pts.length).toBeGreaterThanOrEqual(2);

          // Orthogonal throughout.
          for (let i = 1; i < pts.length; i++) {
            const p = pts[i - 1]!;
            const q = pts[i]!;
            expect(near(p[0], q[0]) || near(p[1], q[1])).toBe(true);
          }

          // Leaves the source's face outwards…
          const [ox, oy] = outward(fromSide as Side);
          const first: [number, number] = [pts[1]![0] - pts[0]![0], pts[1]![1] - pts[0]![1]];
          expect(first[0] * ox + first[1] * oy).toBeGreaterThan(0);

          // …and arrives at the target's face heading INTO it.
          const [ix, iy] = outward(toSide as Side);
          const last = pts.length - 1;
          const tail: [number, number] = [
            pts[last]![0] - pts[last - 1]![0],
            pts[last]![1] - pts[last - 1]![1],
          ];
          expect(tail[0] * -ix + tail[1] * -iy).toBeGreaterThan(0);
        });
      }
    }
  }

  it("draws one straight line when the two ports face each other", () => {
    const to = { x: 300, y: 0, w: 120, h: 60 };
    const pts = connectPorts(
      { box: A, port: { side: "right", at: 0.5 } },
      { box: to, port: { side: "left", at: 0.5 } },
    );
    expect(pts).toEqual([
      [120, 30],
      [300, 30],
    ]);
  });
});

describe("nearestPort", () => {
  it("reads a point dropped on a face as that face", () => {
    expect(nearestPort(A, [0, 30], 44)).toEqual({ side: "left", at: 0.5 });
    expect(nearestPort(A, [60, 60], 44)).toEqual({ side: "bottom", at: 0.5 });
  });

  it("reads a point dropped inside the box as its nearest face", () => {
    expect(nearestPort(A, [60, 8], 44)!.side).toBe("top");
    expect(nearestPort(A, [110, 30], 44)!.side).toBe("right");
  });

  it("refuses a point that is nowhere near the box", () => {
    // Not an attachment: a line somebody parked, which must be left alone.
    expect(nearestPort(A, [600, 600], 44)).toBeNull();
  });

  it("clamps to the face it lands on", () => {
    expect(nearestPort(A, [-20, -12], 44)).toMatchObject({ at: 0 });
  });
});
