import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSequence } from "../../src/plugin/handlers/sequence.js";
import { createState } from "../../src/plugin/handlers/state.js";
import { createErd } from "../../src/plugin/handlers/erd.js";
import { createSitemap } from "../../src/plugin/handlers/sitemap.js";
import { createUserflow } from "../../src/plugin/handlers/userflow.js";
import { createActivity } from "../../src/plugin/handlers/activity.js";
import { makeContext } from "../../src/plugin/context.js";
import {
  ACTIVITY_MARKER,
  ERD_MARKER,
  SEQUENCE_MARKER,
  SITEMAP_MARKER,
  STATE_MARKER,
} from "../../src/plugin/diagram-mark.js";
import { FLOW_MARKER } from "../../src/plugin/flow-mark.js";

/**
 * Redrawing in place (intoFrameId) empties the frame as it opens it. The draw
 * data used to be turned into layer specs only AFTER that, so a malformed
 * piece of it — fragments missing, a state without a body, a table without
 * attributes, a page without a title — threw with the user's diagram already
 * wiped and nothing drawn back. It must fail while the frame is untouched.
 */

let page: any;
let frame: any;

beforeEach(() => {
  page = { id: "0:1", type: "PAGE", children: [] as any[] };
  const kept = { id: "5:2", type: "RECTANGLE", name: "state:kept", parent: null as any, remove: vi.fn() };
  frame = {
    id: "5:1",
    type: "FRAME",
    name: "diagram",
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    parent: page,
    children: [kept],
    pluginData: {} as Record<string, string>,
    getPluginData(k: string) { return this.pluginData[k] ?? ""; },
    setPluginData(k: string, v: string) { this.pluginData[k] = v; },
    resize: vi.fn(),
  };
  kept.parent = frame;
  kept.remove = vi.fn(() => {
    frame.children.splice(frame.children.indexOf(kept), 1);
  });
  page.children.push(frame);
  (globalThis as any).figma = {
    currentPage: page,
    mixed: Symbol("mixed"),
    loadFontAsync: vi.fn(async () => {}),
    listAvailableFontsAsync: vi.fn(async () => [{ fontName: { family: "Inter", style: "Regular" } }]),
    getNodeByIdAsync: vi.fn(async (id: string) => (id === "5:1" ? frame : null)),
  };
});

const common = { name: "d", title: "T", x: 0, y: 0, w: 800, h: 600, intoFrameId: "5:1" };

const cases: Array<[string, string, (c: any) => Promise<unknown>, Record<string, unknown>]> = [
  ["sequence without fragments/activations", SEQUENCE_MARKER, createSequence, { participants: [], messages: [] }],
  [
    "state whose state has no body",
    STATE_MARKER,
    createState,
    { edges: [], states: [{ id: "a", title: "A", kind: "state", at: { x: 0, y: 0, w: 100, h: 40 } }] },
  ],
  [
    "erd whose table has no attributes",
    ERD_MARKER,
    createErd,
    { edges: [], markers: [], entities: [{ id: "a", title: "A", at: { x: 0, y: 0, w: 100, h: 40 }, badgeW: 0 }] },
  ],
  [
    "sitemap whose page has no title lines",
    SITEMAP_MARKER,
    createSitemap,
    { edges: [], pages: [{ id: "a", at: { x: 0, y: 0, w: 100, h: 40 } }] },
  ],
  // The same hole in the other five kinds, which were still opening the frame
  // first.
  ["userflow without diamonds", FLOW_MARKER, createUserflow, { boxes: [], edges: [] }],
  [
    "activity whose step has no placement",
    ACTIVITY_MARKER,
    createActivity,
    { lanes: [], edges: [], steps: [{ id: "a", name: "step:a", title: "A" }] },
  ],
];

describe("malformed draw data with intoFrameId", () => {
  for (const [label, marker, handler, data] of cases) {
    it(`${label}: refuses before emptying the frame`, async () => {
      frame.pluginData[marker] = JSON.stringify({ kind: marker.split(".")[1] });
      const ctx = makeContext({ ...common, ...data } as any, () => {});
      const thrown = await handler(ctx).then(() => null, (e: unknown) => e);
      // The frame first: that is the damage. The error code only says the
      // caller is told it was their data, not a crash.
      expect(frame.children.map((c: any) => c.id)).toEqual(["5:2"]);
      expect(thrown).toMatchObject({ code: "INVALID_PARAMS" });
    });
  }
});
