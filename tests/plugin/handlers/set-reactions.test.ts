import { beforeEach, describe, expect, it, vi } from "vitest";
import { setReactions } from "../../../src/plugin/handlers/paint-edit.js";
import { normalizeReactions } from "../../../src/plugin/edit-util.js";
import { makeContext } from "../../../src/plugin/context.js";

/**
 * set_reactions — prototype wiring (click → navigate). The contract mirrors
 * setEffects: the array REPLACES node.reactions, [] clears, and any enum or
 * destination mistake throws INVALID_PARAMS instead of silently no-op'ing
 * (same spirit as the textAlign fix).
 */

function fakeFrame(id: string, extra: Record<string, unknown> = {}): any {
  return {
    id,
    type: "FRAME",
    name: `Frame ${id}`,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    reactions: [],
    ...extra,
  };
}

function ctx(params: Record<string, unknown>) {
  return makeContext(params, () => {});
}

const CLICK_NAVIGATE = (destinationId: string) => ({
  trigger: { type: "ON_CLICK" },
  action: { type: "NODE", navigation: "NAVIGATE", destinationId },
});

describe("setReactions handler", () => {
  let button: any;
  let dashboard: any;
  let nodes: Record<string, any>;

  beforeEach(() => {
    button = fakeFrame("1:1");
    dashboard = fakeFrame("2:2");
    nodes = { [button.id]: button, [dashboard.id]: dashboard };
    (globalThis as any).figma = {
      getNodeByIdAsync: vi.fn(async (id: string) => nodes[id] ?? null),
    };
  });

  it("sets one ON_CLICK→NAVIGATE reaction", async () => {
    const res: any = await setReactions(
      ctx({ nodeId: button.id, reactions: [CLICK_NAVIGATE(dashboard.id)] }),
    );
    expect(button.reactions).toHaveLength(1);
    expect(button.reactions[0].trigger).toEqual({ type: "ON_CLICK" });
    expect(button.reactions[0].actions[0]).toMatchObject({
      type: "NODE",
      destinationId: dashboard.id,
      navigation: "NAVIGATE",
    });
    expect(res.reactions).toBe(1);
    expect(res.id).toBe(button.id);
  });

  it("prefers setReactionsAsync when the runtime provides it", async () => {
    const setAsync = vi.fn(async (r: unknown) => {
      button.reactions = r;
    });
    button.setReactionsAsync = setAsync;
    await setReactions(
      ctx({ nodeId: button.id, reactions: [CLICK_NAVIGATE(dashboard.id)] }),
    );
    expect(setAsync).toHaveBeenCalledTimes(1);
    expect(button.reactions).toHaveLength(1);
  });

  it("throws INVALID_PARAMS when destinationId does not exist", async () => {
    await expect(
      setReactions(
        ctx({ nodeId: button.id, reactions: [CLICK_NAVIGATE("9:99")] }),
      ),
    ).rejects.toMatchObject({
      code: "INVALID_PARAMS",
      message: expect.stringContaining("9:99"),
    });
    // Nothing was written.
    expect(button.reactions).toHaveLength(0);
  });

  it("throws INVALID_PARAMS on a bad trigger enum instead of no-op'ing", async () => {
    await expect(
      setReactions(
        ctx({
          nodeId: button.id,
          reactions: [
            {
              trigger: { type: "ON_TAP" },
              action: { type: "NODE", destinationId: dashboard.id },
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({
      code: "INVALID_PARAMS",
      message: expect.stringContaining("ON_TAP"),
    });
    expect(button.reactions).toHaveLength(0);
  });

  it("throws INVALID_PARAMS on a bad navigation enum", async () => {
    await expect(
      setReactions(
        ctx({
          nodeId: button.id,
          reactions: [
            {
              trigger: { type: "ON_CLICK" },
              action: {
                type: "NODE",
                destinationId: dashboard.id,
                navigation: "TELEPORT",
              },
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  });

  it("fills the default SMART_ANIMATE transition when omitted", async () => {
    await setReactions(
      ctx({ nodeId: button.id, reactions: [CLICK_NAVIGATE(dashboard.id)] }),
    );
    expect(button.reactions[0].actions[0].transition).toEqual({
      type: "SMART_ANIMATE",
      easing: { type: "EASE_IN_AND_OUT" },
      duration: 0.3,
    });
  });

  it("keeps transition: null (instant)", async () => {
    await setReactions(
      ctx({
        nodeId: button.id,
        reactions: [
          {
            trigger: { type: "ON_CLICK" },
            action: {
              type: "NODE",
              destinationId: dashboard.id,
              transition: null,
            },
          },
        ],
      }),
    );
    expect(button.reactions[0].actions[0].transition).toBeNull();
  });

  it("throws INVALID_PARAMS when the node does not support reactions", async () => {
    nodes["3:3"] = { id: "3:3", type: "SLICE", name: "Slice" }; // no reactions key
    await expect(
      setReactions(
        ctx({ nodeId: "3:3", reactions: [CLICK_NAVIGATE(dashboard.id)] }),
      ),
    ).rejects.toMatchObject({
      code: "INVALID_PARAMS",
      message: expect.stringContaining("SLICE"),
    });
  });

  it("clears all reactions with []", async () => {
    button.reactions = [
      { trigger: { type: "ON_CLICK" }, actions: [{ type: "BACK" }] },
    ];
    const res: any = await setReactions(
      ctx({ nodeId: button.id, reactions: [] }),
    );
    expect(button.reactions).toEqual([]);
    expect(res.reactions).toBe(0);
  });

  it("accepts the `destination` alias (string or node object)", async () => {
    await setReactions(
      ctx({
        nodeId: button.id,
        reactions: [
          {
            trigger: { type: "ON_CLICK" },
            action: { type: "NODE", destination: { id: dashboard.id } },
          },
        ],
      }),
    );
    expect(button.reactions[0].actions[0].destinationId).toBe(dashboard.id);
  });

  it("supports CLOSE actions (dialog dismiss) without a destination", async () => {
    await setReactions(
      ctx({
        nodeId: button.id,
        reactions: [{ trigger: { type: "ON_CLICK" }, action: { type: "CLOSE" } }],
      }),
    );
    expect(button.reactions[0].actions[0]).toEqual({ type: "CLOSE" });
  });
});

describe("normalizeReactions (pure)", () => {
  it("defaults AFTER_TIMEOUT timeout to 0.8s — stored as 800ms", () => {
    const r = normalizeReactions([
      { trigger: { type: "AFTER_TIMEOUT" }, action: { type: "BACK" } },
    ])[0]!;
    // Figma's AFTER_TIMEOUT.timeout is milliseconds; the spec is seconds.
    expect(r.trigger).toEqual({ type: "AFTER_TIMEOUT", timeout: 800 });
  });

  it("converts AFTER_TIMEOUT seconds to stored milliseconds", () => {
    const r = normalizeReactions([
      { trigger: { type: "AFTER_TIMEOUT", timeout: 1.5 }, action: { type: "BACK" } },
    ])[0]!;
    expect(r.trigger).toEqual({ type: "AFTER_TIMEOUT", timeout: 1500 });
  });

  it("carries delay (ms) and deprecatedVersion on MOUSE_ENTER", () => {
    const r = normalizeReactions([
      { trigger: { type: "MOUSE_ENTER", delay: 0.25 }, action: { type: "CLOSE" } },
    ])[0]!;
    expect(r.trigger).toEqual({ type: "MOUSE_ENTER", delay: 250, deprecatedVersion: false });
  });

  it("mirrors actions[0] into the legacy `action` field", () => {
    const r = normalizeReactions([
      { trigger: { type: "ON_CLICK" }, action: { type: "NODE", destinationId: "2:2" } },
    ])[0]!;
    expect(r.action).toBe(r.actions[0]);
  });

  it("throws on a missing action", () => {
    expect(() =>
      normalizeReactions([{ trigger: { type: "ON_CLICK" } }]),
    ).toThrow(/requires an action/);
  });

  it("throws on a bad transition type", () => {
    expect(() =>
      normalizeReactions([
        {
          trigger: { type: "ON_CLICK" },
          action: {
            type: "NODE",
            destinationId: "2:2",
            transition: { type: "WARP" },
          },
        },
      ]),
    ).toThrow(/Unknown transition type/);
  });

  it("throws on undefined instead of clearing", () => {
    expect(() => normalizeReactions(undefined)).toThrow(/reactions array/);
  });
});
