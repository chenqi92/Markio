import { describe, expect, it } from "vitest";
import {
  formatForJike,
  formatForMarkdownPaste,
  formatForXhs,
  markdownToPlain,
  splitForTwitter,
} from "./MultiCopySheet";

describe("multi copy formatters", () => {
  it("converts markdown to readable plain text", () => {
    expect(markdownToPlain("# Title\n\n- **hello** [site](https://a.test)")).toBe(
      "Title\n\n· hello site",
    );
  });

  it("splits long twitter text into numbered parts", () => {
    const text = splitForTwitter("a".repeat(12), 5);
    expect(text).toContain("1/3");
    expect(text).toContain("3/3");
  });

  it("keeps jike markdown emphasis while expanding links", () => {
    const text = formatForJike("## Note\n\n**bold** [link](https://a.test)");
    expect(text).toContain("# Note");
    expect(text).toContain("**bold**");
    expect(text).toContain("link https://a.test");
  });

  it("formats xhs copy as title, body, and unique tags", () => {
    const text = formatForXhs("# My Note\n\nBody #tag #tag #笔记", "Fallback");
    expect(text).toBe("My Note\n\nBody #tag #tag #笔记\n\n#tag #笔记");
  });

  it("keeps markdown paste targets as markdown", () => {
    expect(formatForMarkdownPaste("  # Title\n\n```ts\nx\n```  ")).toBe(
      "# Title\n\n```ts\nx\n```",
    );
  });
});
