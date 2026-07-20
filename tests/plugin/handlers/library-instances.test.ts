import { describe, it, expect, beforeEach, vi } from "vitest";
import { getLibraryComponent } from "../../../src/plugin/handlers/design-system.js";
import {
  detachInstance,
  resetInstanceOverrides,
} from "../../../src/plugin/handlers/instance-overrides.js";
import { makeContext, HandlerContext } from "../../../src/plugin/context.js";
import { HandlerError } from "../../../src/plugin/errors.js";
import { ErrorCode } from "../../../src/shared/protocol.js";

type FakeNode = Record<string, any>;

let nodes: Map<string, FakeNode>;

function ctx(params: Record<string, unknown>): HandlerContext {
  return makeContext(params, () => {});
}

beforeEach(() => {
  nodes = new Map();
  (globalThis as any).figma = {
    getNodeByIdAsync: async (id: string) => nodes.get(id) ?? null,
    importComponentByKeyAsync: vi.fn(async () => {
      throw new Error("not published");
    }),
    importComponentSetByKeyAsync: vi.fn(async () => {
      throw new Error("not published");
    }),
    mixed: Symbol("mixed"),
  };
});

describe("get_library_component — import by key", () => {
  const libButton: FakeNode = {
    id: "100:1",
    name: "Button/Primary",
    type: "COMPONENT",
    key: "abc123",
    remote: true,
  };

  it("imports a COMPONENT by key", async () => {
    const fig = (globalThis as any).figma;
    fig.importComponentByKeyAsync = vi.fn(async () => libButton);
    const res = (await getLibraryComponent(
      ctx({ key: "abc123", detail: "compact", includeAnatomy: false }),
    )) as any;
    expect(fig.importComponentByKeyAsync).toHaveBeenCalledWith("abc123");
    expect(res.imported).toBe(true);
    expect(res.remote).toBe(true);
    expect(res.component).toMatchObject({ id: "100:1", key: "abc123", type: "COMPONENT" });
  });

  it("falls back to a COMPONENT_SET import when the component import fails", async () => {
    const fig = (globalThis as any).figma;
    const libSet: FakeNode = { id: "100:0", name: "Button", type: "COMPONENT_SET", key: "set9" };
    fig.importComponentSetByKeyAsync = vi.fn(async () => libSet);
    const res = (await getLibraryComponent(
      ctx({ key: "set9", detail: "compact", includeAnatomy: false }),
    )) as any;
    expect(res.component.type).toBe("COMPONENT_SET");
  });

  it("type: 'component' skips the set fallback", async () => {
    const fig = (globalThis as any).figma;
    const e = (await getLibraryComponent(
      ctx({ key: "abc123", type: "component" }),
    ).catch((x) => x)) as HandlerError;
    expect(e).toBeInstanceOf(HandlerError);
    expect(e.code).toBe(ErrorCode.NODE_NOT_FOUND);
    expect(fig.importComponentSetByKeyAsync).not.toHaveBeenCalled();
  });

  it("both imports failing → NODE_NOT_FOUND with a published-library hint", async () => {
    const e = (await getLibraryComponent(ctx({ key: "nope" })).catch((x) => x)) as HandlerError;
    expect(e).toBeInstanceOf(HandlerError);
    expect(e.code).toBe(ErrorCode.NODE_NOT_FOUND);
    expect(e.message).toContain("nope");
    expect(e.hint).toContain("PUBLISHED");
  });

  it("a HANGING import (unpublished key) is raced to a clean error, not a bridge timeout", async () => {
    const fig = (globalThis as any).figma;
    const never = new Promise(() => {});
    fig.importComponentByKeyAsync = vi.fn(() => never);
    fig.importComponentSetByKeyAsync = vi.fn(() => never);
    const e = (await getLibraryComponent(
      ctx({ key: "unpublished", importTimeoutMs: 20 }),
    ).catch((x) => x)) as HandlerError;
    expect(e).toBeInstanceOf(HandlerError);
    expect(e.code).toBe(ErrorCode.NODE_NOT_FOUND);
    expect(e.message).toContain("did not respond within 20ms");
    expect(e.hint).toContain("unpublished");
  });

  it("missing key → INVALID_PARAMS", async () => {
    const e = (await getLibraryComponent(ctx({})).catch((x) => x)) as HandlerError;
    expect(e).toBeInstanceOf(HandlerError);
    expect(e.code).toBe(ErrorCode.INVALID_PARAMS);
  });
});

describe("detach_instance / reset_instance_overrides", () => {
  it("detaches a batch with per-target results", async () => {
    nodes.set("10:1", {
      id: "10:1",
      type: "INSTANCE",
      detachInstance: vi.fn(() => ({ id: "20:1", name: "Button" })),
    });
    nodes.set("10:2", { id: "10:2", type: "FRAME" });
    const res = (await detachInstance(
      ctx({ nodeIds: ["10:1", "10:2", "10:3"] }),
    )) as any;
    expect(res.detached).toBe(1);
    expect(res.failCount).toBe(2);
    expect(res.results).toEqual([
      { id: "10:1", ok: true, detachedId: "20:1", name: "Button" },
      { id: "10:2", ok: false, error: "is FRAME, not INSTANCE" },
      { id: "10:3", ok: false, error: "not found" },
    ]);
  });

  it("accepts a single nodeId and reports a detach failure", async () => {
    nodes.set("10:1", {
      id: "10:1",
      type: "INSTANCE",
      detachInstance: vi.fn(() => {
        throw new Error("locked");
      }),
    });
    const res = (await detachInstance(ctx({ nodeId: "10:1" }))) as any;
    expect(res.detached).toBe(0);
    expect(res.results[0]).toMatchObject({ ok: false, error: "locked" });
  });

  it("resets overrides per target", async () => {
    const reset = vi.fn();
    nodes.set("10:1", { id: "10:1", type: "INSTANCE", resetOverrides: reset });
    const res = (await resetInstanceOverrides(ctx({ nodeId: "10:1" }))) as any;
    expect(reset).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ reset: 1, failCount: 0 });
  });

  it("empty target list → INVALID_PARAMS", async () => {
    for (const fn of [detachInstance, resetInstanceOverrides]) {
      const e = (await fn(ctx({})).catch((x: unknown) => x)) as HandlerError;
      expect(e).toBeInstanceOf(HandlerError);
      expect(e.code).toBe(ErrorCode.INVALID_PARAMS);
    }
  });
});
