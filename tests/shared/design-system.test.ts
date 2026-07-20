import { describe, expect, it } from "vitest";
import { renderDesignMarkdown, type DesignSystemKit } from "../../src/shared/design-system.js";

describe("renderDesignMarkdown", () => {
  it("renders a useful empty-state document", () => {
    const md = renderDesignMarkdown({ file: { name: "Empty File" } });
    expect(md).toContain("# Empty File Design System");
    expect(md).toContain("_No local variables found._");
    expect(md).toContain("_No local styles found._");
    expect(md).toContain("_No local components found._");
  });

  it("renders variables, rich styles and component properties for design.md", () => {
    const kit: DesignSystemKit = {
      file: { name: "Reqwise UI", page: { name: "Components" } },
      variables: {
        collections: [
          {
            name: "Colors",
            modes: [{ name: "Light" }, { name: "Dark" }],
            variables: [
              { name: "color/bg/default", type: "COLOR", values: { Light: "#ffffff", Dark: "#111111" } },
              { name: "spacing/2", type: "FLOAT", values: { Light: 8, Dark: 8 } },
            ],
          },
        ],
      },
      styles: {
        paint: [{ name: "Surface/Default", paints: [{ type: "SOLID", color: "#ffffff" }] }],
        text: [{ name: "Body/Medium", fontName: { family: "Inter", style: "Medium" }, fontSize: 14 }],
      },
      components: [
        {
          id: "1:1",
          name: "Button",
          type: "COMPONENT_SET",
          layout: { layoutMode: "HORIZONTAL", itemSpacing: 8 },
          shape: { cornerRadius: 8 },
          componentPropertyDefinitions: {
            Size: { type: "VARIANT", defaultValue: "Medium", variantOptions: ["Small", "Medium"] },
            "Label#1:2": { type: "TEXT", defaultValue: "Save" },
            "IconVisible#1:3": { type: "BOOLEAN", defaultValue: true },
          },
          variants: [
            { name: "Size=Small", variantProperties: { Size: "Small" } },
            { name: "Size=Medium", variantProperties: { Size: "Medium" } },
          ],
          textLayers: [{ name: "Label", path: "Button/Label", characters: "Save" }],
          anatomy: {
            name: "Button",
            type: "COMPONENT_SET",
            w: 120,
            h: 40,
            layoutMode: "HORIZONTAL",
            children: [
              { name: "Label", type: "TEXT", characters: "Save" },
            ],
          },
        },
      ],
    };

    const md = renderDesignMarkdown(kit);
    expect(md).toContain("# Reqwise UI Design System");
    expect(md).toContain("## Overview");
    expect(md).toContain("## Colors");
    expect(md).toContain("## Typography");
    expect(md).toContain("## Layout");
    expect(md).toContain("## Shapes");
    expect(md).toContain("## Agent Rules");
    expect(md).toContain("`color/bg/default`");
    expect(md).toContain("Surface/Default");
    expect(md).toContain("### Button");
    expect(md).toContain("`Label#1:2`: TEXT");
    expect(md).toContain("Size=Small");
    expect(md).toContain("Button/Label");
    expect(md).toContain("- Anatomy:");
    expect(md).toContain("`Button/Label` (TEXT");
    expect(md).toContain("## Do's and Don'ts");
    expect(md).toContain("## Responsive Evidence");
    expect(md).toContain("## Known Gaps");
    expect(md).toContain("Figma node ID: `1:1`");
    expect(md).toContain('await figma.instantiate("1:1"');
  });

  it("can explicitly shorten output with a visible limit marker", () => {
    const md = renderDesignMarkdown(
      {
        file: { name: "Large File" },
        components: Array.from({ length: 20 }, (_, i) => ({
          id: `1:${i}`,
          name: `Component ${i}`,
          type: "COMPONENT",
        })),
      },
      { maxOutputChars: 900 },
    );
    expect(md.length).toBeLessThanOrEqual(950);
    expect(md).toContain("## Output Limit");
    expect(md).not.toMatch(/```[^`]*$/);
  });

  it("renders extraction coverage, screen evidence, observed patterns and remote bindings", () => {
    const md = renderDesignMarkdown({
      file: {
        name: "Evidence File",
        page: { name: "Desktop" },
        pages: [{ name: "Components" }, { name: "Desktop" }],
      },
      extraction: {
        scope: "document",
        pagesScanned: 2,
        totalComponents: 1,
        returnedComponents: 1,
        totalScreens: 1,
        returnedScreens: 1,
        totalInstances: 3,
        inspectedInstances: 3,
        componentDepth: 3,
        screenDepth: 4,
        includesScreens: true,
        includesComponentUsage: true,
      },
      components: [{
        id: "10:1",
        key: "local-key",
        name: "Button",
        type: "COMPONENT_SET",
        defaultVariantId: "10:2",
        variants: [{ id: "10:2", key: "variant-key", name: "State=Default" }],
        usageStats: { instanceCount: 3, pages: ["Desktop"], screens: ["Desktop / Checkout"] },
      }],
      externalComponents: [{
        id: "20:1",
        key: "remote-key",
        name: "Icon",
        type: "COMPONENT",
        source: "remote-library",
        instanceCount: 1,
      }],
      screens: [{
        id: "30:1",
        name: "Checkout",
        pageName: "Desktop",
        type: "FRAME",
        width: 1440,
        height: 900,
        instanceCount: 3,
        components: ["Button"],
      }],
      observedPatterns: { spacing: [{ value: 16, count: 8 }], screenWidths: [{ value: 1440, count: 1 }] },
    });
    expect(md).toContain("## Extraction Coverage");
    expect(md).toContain("Screens summarized: 1/1");
    expect(md).toContain("Default variant ID: `10:2`");
    expect(md).toContain("State=Default — id `10:2`, key `variant-key`");
    expect(md).toContain("## External & Library Components");
    expect(md).toContain("Library key: `remote-key`");
    expect(md).toContain("Desktop / Checkout");
    expect(md).toContain("16px (×8)");
  });

  it("does not hide layout/shape entries behind an implicit 60-item cap", () => {
    const components = Array.from({ length: 65 }, (_, i) => ({
      id: `1:${i}`,
      name: `Component ${i}`,
      type: "COMPONENT",
      layout: { layoutMode: "VERTICAL" },
      shape: { cornerRadius: i },
    }));
    const md = renderDesignMarkdown({ file: { name: "Many Components" }, components });
    expect(md).toContain("`Component 64`: layoutMode=VERTICAL");
    expect(md).toContain("`Component 64`: cornerRadius=64");
    expect(md).not.toContain("more component layout patterns");
    expect(md).not.toContain("more component radii");
  });

  it("keeps variant nodes in JSON but avoids duplicating them as full Markdown entries", () => {
    const md = renderDesignMarkdown({
      components: [
        { id: "1:0", name: "Button", type: "COMPONENT_SET", variants: [{ id: "1:1", name: "State=Default" }] },
        { id: "1:1", name: "State=Default", type: "COMPONENT", componentSetId: "1:0", componentSetName: "Button" },
      ],
    });
    expect(md.match(/^### Button$/gm)).toHaveLength(1);
    expect(md).toContain("State=Default — id `1:1`");
    expect(md).not.toContain("### State=Default");
  });
});
