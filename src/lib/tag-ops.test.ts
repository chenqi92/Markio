import { describe, expect, it } from "vitest";
import { buildRenameRegex } from "./tag-ops";

function apply(text: string, oldTag: string, newTag: string): string {
  return text.replace(buildRenameRegex(oldTag), `#${newTag}`);
}

describe("buildRenameRegex", () => {
  it("replaces the tag in plain text", () => {
    expect(apply("see #design today", "design", "ux")).toBe("see #ux today");
  });

  it("does not touch headings (## heading)", () => {
    expect(apply("## design", "design", "ux")).toBe("## design");
    expect(apply("### design notes", "design", "ux")).toBe("### design notes");
  });

  it("does not touch a longer tag (#designer)", () => {
    expect(apply("ping #designer for #design", "design", "ux")).toBe(
      "ping #designer for #ux",
    );
  });

  it("does not touch a sub-tag (#design/system)", () => {
    expect(apply("see #design/system", "design", "ux")).toBe("see #design/system");
  });

  it("handles Chinese tags", () => {
    expect(apply("会议 #设计 主题", "设计", "产品")).toBe("会议 #产品 主题");
  });

  it("replaces multiple occurrences in a single line", () => {
    expect(apply("#design and #design", "design", "ux")).toBe("#ux and #ux");
  });

  it("works at start / end of string", () => {
    expect(apply("#design at start", "design", "ux")).toBe("#ux at start");
    expect(apply("end with #design", "design", "ux")).toBe("end with #ux");
  });

  it("does not match inside an email", () => {
    // # 通常不出现在邮箱里，但若出现也别错改。本测试主要确认 word boundary。
    expect(apply("foo@bar#design", "design", "ux")).toBe("foo@bar#design");
  });

  it("does not match a tag with dot suffix like #design.com", () => {
    expect(apply("#design.com here", "design", "ux")).toBe("#design.com here");
  });
});
