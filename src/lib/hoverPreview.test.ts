import { describe, expect, it } from "vitest";
import { previewSnippet } from "./hoverPreview";

describe("previewSnippet", () => {
  it("returns short docs whole (trimmed)", () => {
    expect(previewSnippet("# Hi\n\nbody")).toBe("# Hi\n\nbody");
  });

  it("strips leading frontmatter", () => {
    const md = "---\ntitle: X\ntags: [a]\n---\n# Real\nbody";
    expect(previewSnippet(md)).toBe("# Real\nbody");
  });

  it("truncates long docs and appends ellipsis", () => {
    const md = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const out = previewSnippet(md, 5);
    expect(out.startsWith("line 0\nline 1\nline 2\nline 3\nline 4")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toContain("line 6");
  });

  it("does not strip a non-leading --- block", () => {
    const md = "text\n---\nmore";
    expect(previewSnippet(md)).toBe("text\n---\nmore");
  });
});
