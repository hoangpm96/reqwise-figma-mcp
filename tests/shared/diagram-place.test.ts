import { describe, it, expect } from "vitest";
import { findFreeSpot, PLACE_GUTTER } from "../../src/shared/diagram/place.js";

/**
 * The live report this exists for: "gen mấy này mà đè lên UI cũ không ổn đâu".
 * Every diagram kind defaults to 0,0 and a working file almost always has a
 * screen at its origin, so the first diagram drawn into somebody's real file
 * covered their work.
 */
const screen = (over: Partial<{ x: number; y: number; w: number; h: number; name: string }> = {}) => ({
  x: 0,
  y: 0,
  w: 1024,
  h: 1000,
  name: "01 · leads-list",
  ...over,
});

describe("findFreeSpot", () => {
  it("leaves an empty page alone", () => {
    expect(findFreeSpot([], { x: 0, y: 0, w: 800, h: 600 })).toEqual({ x: 0, y: 0 });
  });

  it("leaves a spot that is already clear alone", () => {
    const spot = findFreeSpot([screen()], { x: 0, y: 4000, w: 800, h: 600 });
    expect(spot).toEqual({ x: 0, y: 4000 });
  });

  it("slides below the screen sitting at the origin", () => {
    const spot = findFreeSpot([screen()], { x: 0, y: 0, w: 1114, h: 772 });
    expect(spot.moved).toBe(true);
    expect(spot.y).toBe(1000 + PLACE_GUTTER);
    // The x is kept: a caller who asked for a column gets a column.
    expect(spot.x).toBe(0);
  });

  it("names what was in the way, so the warning can be acted on", () => {
    expect(findFreeSpot([screen()], { x: 0, y: 0, w: 100, h: 100 }).blockedBy).toBe("01 · leads-list");
  });

  it("clears a stack of obstacles in one go, not one gutter at a time", () => {
    const stack = [
      screen({ y: 0, h: 500, name: "a" }),
      screen({ y: 700, h: 500, name: "b" }),
      screen({ y: 1400, h: 500, name: "c" }),
    ];
    const spot = findFreeSpot(stack, { x: 0, y: 0, w: 800, h: 300 });
    expect(spot.y).toBe(1900 + PLACE_GUTTER);
  });

  it("keeps a gutter, so the diagram does not sit flush against the work above it", () => {
    const spot = findFreeSpot([screen({ h: 100 })], { x: 0, y: 0, w: 800, h: 300 });
    expect(spot.y - 100).toBe(PLACE_GUTTER);
  });

  it("does not move for something beside it, only for something under it", () => {
    // A neighbour a full gutter to the right is not in the way.
    const beside = screen({ x: 1024 + PLACE_GUTTER + 1, w: 400 });
    expect(findFreeSpot([beside], { x: 0, y: 0, w: 1000, h: 300 }).moved).toBeUndefined();
  });

  it("ignores a zero-area layer, which covers nothing", () => {
    expect(findFreeSpot([screen({ w: 0, h: 0 })], { x: 0, y: 0, w: 800, h: 600 })).toEqual({
      x: 0,
      y: 0,
    });
  });

  it("puts a second diagram under the first rather than on top of it", () => {
    // Re-running the same draw is the common case, and the old behaviour
    // stacked them exactly on top of each other at 0,0.
    const first = findFreeSpot([screen()], { x: 0, y: 0, w: 1114, h: 772 });
    const drawn = { x: first.x, y: first.y, w: 1114, h: 772, name: "Journey · A" };
    const second = findFreeSpot([screen(), drawn], { x: 0, y: 0, w: 1114, h: 772 });
    expect(second.y).toBe(first.y + 772 + PLACE_GUTTER);
  });
});
