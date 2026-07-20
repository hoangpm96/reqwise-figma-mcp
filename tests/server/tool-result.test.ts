import { describe, it, expect } from "vitest";
import { toToolResult } from "../../src/server/index.js";

describe("toToolResult", () => {
  it("emits a PNG screenshot as an MCP image block, not a base64 text dump", () => {
    const res = toToolResult({ format: "PNG", scale: 0.6, nodeId: "1:2", base64: "AAAABBBB" });
    const image = res.content.find((c) => c.type === "image");
    expect(image).toBeDefined();
    expect((image as { data: string }).data).toBe("AAAABBBB");
    expect((image as { mimeType: string }).mimeType).toBe("image/png");
    // Metadata text carries nodeId/scale but NOT the base64 payload.
    const text = res.content.find((c) => c.type === "text") as { text: string };
    expect(text.text).toContain("1:2");
    expect(text.text).not.toContain("AAAABBBB");
  });

  it("maps JPG to image/jpeg", () => {
    const res = toToolResult({ format: "JPG", nodeId: "1:2", base64: "ZZ" });
    const image = res.content.find((c) => c.type === "image") as { mimeType: string };
    expect(image.mimeType).toBe("image/jpeg");
  });

  it("keeps SVG/PDF as data (not previewable image blocks)", () => {
    const svg = toToolResult({ format: "SVG", nodeId: "1:2", base64: "PHN2Zz4=" });
    expect(svg.content.some((c) => c.type === "image")).toBe(false);
    expect((svg.content[0] as { text: string }).text).toContain("PHN2Zz4=");
  });

  it("unwraps a warnings-wrapped image result and preserves warnings", () => {
    const res = toToolResult({
      result: { format: "PNG", nodeId: "1:2", base64: "IMG" },
      warnings: ["heads up"],
    });
    expect(res.content.some((c) => c.type === "image")).toBe(true);
    const texts = res.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text);
    expect(texts.join(" ")).toContain("heads up");
  });

  it("serializes non-image JSON compactly (no pretty-print whitespace)", () => {
    const res = toToolResult({ a: 1, b: { c: 2 } });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toBe('{"a":1,"b":{"c":2}}');
    expect(text).not.toContain("\n");
  });

  it("passes a plain string through untouched", () => {
    const res = toToolResult("# Markdown");
    expect((res.content[0] as { text: string }).text).toBe("# Markdown");
  });
});
