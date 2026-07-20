import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateDesignMd } from "../../../src/plugin/handlers/design-system.js";
import { makeContext } from "../../../src/plugin/context.js";

describe("generate_design_md — document evidence", () => {
  beforeEach(() => {
    const page: any = { id: "0:1", name: "Desktop", type: "PAGE", children: [] };
    const component: any = {
      id: "10:1",
      key: "button-key",
      name: "Button",
      type: "COMPONENT",
      parent: page,
      remote: false,
      componentPropertyDefinitions: {
        "Label#10:2": { type: "TEXT", defaultValue: "Continue" },
      },
      children: [],
      layoutMode: "HORIZONTAL",
      itemSpacing: 8,
      paddingLeft: 16,
      paddingRight: 16,
      paddingTop: 12,
      paddingBottom: 12,
      primaryAxisSizingMode: "AUTO",
      counterAxisSizingMode: "AUTO",
      primaryAxisAlignItems: "CENTER",
      counterAxisAlignItems: "CENTER",
      clipsContent: false,
    };
    const screen: any = {
      id: "20:1",
      name: "Checkout",
      type: "FRAME",
      parent: page,
      width: 1440,
      height: 900,
      children: [],
      layoutMode: "VERTICAL",
      itemSpacing: 24,
      paddingLeft: 32,
      paddingRight: 32,
      paddingTop: 48,
      paddingBottom: 48,
      fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }],
    };
    const instance: any = {
      id: "I10:1;1:1",
      name: "Button",
      type: "INSTANCE",
      parent: screen,
      children: [],
      componentProperties: {
        "Label#10:2": { type: "TEXT", value: "Pay now" },
      },
      getMainComponentAsync: vi.fn(async () => component),
    };
    screen.children.push(instance);
    page.children.push(screen, component);

    const root: any = {
      id: "0:0",
      name: "Evidence File",
      type: "DOCUMENT",
      children: [page],
      findAllWithCriteria: ({ types }: { types: string[] }) => {
        if (types.includes("INSTANCE")) return [instance];
        if (types.includes("COMPONENT")) return [component];
        return [];
      },
    };

    (globalThis as any).figma = {
      root,
      currentPage: page,
      fileKey: "file-key",
      mixed: Symbol("mixed"),
      loadAllPagesAsync: vi.fn(async () => {}),
      getLocalPaintStylesAsync: vi.fn(async () => []),
      getLocalTextStylesAsync: vi.fn(async () => []),
      getLocalEffectStylesAsync: vi.fn(async () => []),
      getLocalGridStylesAsync: vi.fn(async () => []),
      variables: {
        getLocalVariableCollectionsAsync: vi.fn(async () => []),
        getVariableByIdAsync: vi.fn(async () => null),
      },
    };
  });

  it("binds components to Figma ids and grounds guidance in screen/usage evidence", async () => {
    const result = (await generateDesignMd(makeContext({ depth: 3, screenDepth: 4 }, () => {}))) as any;
    expect(result.markdown).toContain("Figma node ID: `10:1`");
    expect(result.markdown).toContain('await figma.instantiate("10:1"');
    expect(result.markdown).toContain("Desktop / Checkout");
    expect(result.markdown).toContain("Observed instances: 1");
    expect(result.markdown).toContain("`Label#10:2`: Pay now");
    expect(result.markdown).toContain("1440px (×1)");
    expect(result.markdown).toContain("24px (×1)");
    expect(result.markdown).toContain("#ffffff (×1)");
  });
});
