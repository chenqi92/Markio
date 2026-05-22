import { describe, expect, it } from "vitest";
import { parseImageMarkdown } from "./wysiwyg";
import {
  imageWidthFromTitle,
  setImageMarkdownWidth,
} from "@/lib/markdown-images";

describe("parseImageMarkdown", () => {
  it("parses bare image", () => {
    expect(parseImageMarkdown("![pic](https://example.com/a.png)")).toEqual({
      alt: "pic",
      url: "https://example.com/a.png",
      title: undefined,
    });
  });
  it("parses image with double-quoted title", () => {
    expect(
      parseImageMarkdown('![pic](https://x.test/a.png "Caption")'),
    ).toEqual({ alt: "pic", url: "https://x.test/a.png", title: "Caption" });
  });
  it("parses image with single-quoted title", () => {
    expect(
      parseImageMarkdown("![](https://x.test/a.png 'cap')"),
    ).toEqual({ alt: "", url: "https://x.test/a.png", title: "cap" });
  });
  it("parses relative path (caller filters absolute)", () => {
    expect(parseImageMarkdown("![logo](./img/logo.png)")).toEqual({
      alt: "logo",
      url: "./img/logo.png",
      title: undefined,
    });
  });
  it("returns null on malformed source", () => {
    expect(parseImageMarkdown("![alt](unclosed")).toBeNull();
    expect(parseImageMarkdown("not an image")).toBeNull();
    expect(parseImageMarkdown("[link](url)")).toBeNull();
  });
  it("rejects whitespace-only url", () => {
    // url group requires \S+ — empty / whitespace url does not match
    expect(parseImageMarkdown("![alt](   )")).toBeNull();
  });
  it("reads and updates image width metadata in title", () => {
    expect(imageWidthFromTitle("width=50%")).toBe("50%");
    expect(imageWidthFromTitle("caption width=320px")).toBe("320px");
    expect(setImageMarkdownWidth("![pic](https://x.test/a.png)", "50%")).toBe(
      '![pic](https://x.test/a.png "width=50%")',
    );
    expect(
      setImageMarkdownWidth('![pic](https://x.test/a.png "caption width=50%")', "75%"),
    ).toBe('![pic](https://x.test/a.png "caption width=75%")');
    expect(
      setImageMarkdownWidth('![pic](https://x.test/a.png "caption width=75%")', null),
    ).toBe('![pic](https://x.test/a.png "caption")');
  });
});
