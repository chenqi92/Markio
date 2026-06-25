import { describe, expect, it } from "vitest";
import { extractHeadingSection } from "./noteEmbed";

const DOC = `# 标题

引言段落

## 小节 A

A 的内容
更多 A

## 小节 B

B 的内容

### B 子节

子节内容

## 小节 C

C 的内容
`;

describe("extractHeadingSection", () => {
  it("extracts a section up to the next same-level heading", () => {
    const out = extractHeadingSection(DOC, "小节 A");
    expect(out).toBe("## 小节 A\n\nA 的内容\n更多 A\n");
  });

  it("includes deeper subheadings within the section", () => {
    const out = extractHeadingSection(DOC, "小节 B");
    expect(out).toContain("### B 子节");
    expect(out).toContain("子节内容");
    expect(out).not.toContain("## 小节 C");
  });

  it("case-insensitive match", () => {
    expect(extractHeadingSection("# Hello\nbody\n", "hello")).toBe(
      "# Hello\nbody\n",
    );
  });

  it("last section runs to EOF", () => {
    const out = extractHeadingSection(DOC, "小节 C");
    expect(out).toBe("## 小节 C\n\nC 的内容\n");
  });

  it("returns null when heading not found", () => {
    expect(extractHeadingSection(DOC, "不存在")).toBeNull();
  });

  it("ignores headings inside code fences", () => {
    const doc = "# 真标题\n\n\`\`\`\n# 假标题\n\`\`\`\n内容\n";
    expect(extractHeadingSection(doc, "假标题")).toBeNull();
    expect(extractHeadingSection(doc, "真标题")).toContain("内容");
  });
});
