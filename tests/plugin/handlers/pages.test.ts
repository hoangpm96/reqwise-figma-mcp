import { beforeEach, describe, expect, it, vi } from "vitest";
import { setCurrentPage } from "../../../src/plugin/handlers/assets.js";
import { makeContext } from "../../../src/plugin/context.js";
import { HandlerError } from "../../../src/plugin/errors.js";
import { ErrorCode } from "../../../src/shared/protocol.js";

describe("set_current_page", () => {
  let desktop: any;
  let mobile: any;

  beforeEach(() => {
    desktop = { id: "0:1", name: "Desktop", type: "PAGE" };
    mobile = { id: "0:2", name: "Mobile", type: "PAGE" };
    (globalThis as any).figma = {
      currentPage: desktop,
      root: { children: [desktop, mobile] },
      loadAllPagesAsync: vi.fn(async () => {}),
      getNodeByIdAsync: vi.fn(async (id: string) => [desktop, mobile].find((page) => page.id === id) ?? null),
    };
  });

  it("switches by page id", async () => {
    const result = await setCurrentPage(makeContext({ pageId: "0:2" }, () => {}));
    expect((globalThis as any).figma.currentPage).toBe(mobile);
    expect(result).toEqual({ id: "0:2", name: "Mobile", current: true });
  });

  it("switches by unique exact name", async () => {
    await setCurrentPage(makeContext({ name: "mobile" }, () => {}));
    expect((globalThis as any).figma.currentPage).toBe(mobile);
  });

  it("reports a missing page cleanly", async () => {
    const error = await setCurrentPage(makeContext({ pageId: "9:9" }, () => {})).catch((e) => e) as HandlerError;
    expect(error.code).toBe(ErrorCode.NODE_NOT_FOUND);
  });
});
