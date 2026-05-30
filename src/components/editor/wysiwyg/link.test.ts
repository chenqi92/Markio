// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";

import { build } from "./build";

function makeState(src: string): EditorState {
  return EditorState.create({
    doc: src,
    extensions: [markdown({ base: markdownLanguage })],
  });
}

interface LinkMark {
  from: number;
  to: number;
  text: string;
  href?: string;
}

function linkMarks(src: string): LinkMark[] {
  const state = makeState(src);
  const { decorations } = build(state);
  const out: LinkMark[] = [];
  const iter = decorations.iter();
  while (iter.value) {
    const spec = (
      iter.value as {
        spec?: { class?: string; attributes?: Record<string, string> };
      }
    ).spec;
    if (spec?.class?.split(/\s+/).includes("cm-md-link")) {
      out.push({
        from: iter.from,
        to: iter.to,
        text: state.doc.sliceString(iter.from, iter.to),
        href: spec.attributes?.["data-href"],
      });
    }
    iter.next();
  }
  return out;
}

describe("wysiwyg link decorations carry data-href", () => {
  it("inline [text](url) → cm-md-link span with the url", () => {
    const marks = linkMarks("[GitHub](https://github.com)");
    expect(marks).toHaveLength(1);
    expect(marks[0]!.href).toBe("https://github.com");
  });

  it("url with parentheses keeps the full href", () => {
    const marks = linkMarks(
      "[x](https://en.wikipedia.org/wiki/Markdown_(disambiguation))",
    );
    expect(marks[0]!.href).toBe(
      "https://en.wikipedia.org/wiki/Markdown_(disambiguation)",
    );
  });

  it("relative link keeps the relative href", () => {
    const marks = linkMarks("[rel](../README.md)");
    expect(marks[0]!.href).toBe("../README.md");
  });

  it("<https://…> autolink stays visible and clickable", () => {
    const marks = linkMarks("<https://example.com>");
    expect(marks).toHaveLength(1);
    expect(marks[0]!.text).toBe("https://example.com");
    expect(marks[0]!.href).toBe("https://example.com");
  });

  it("<email> autolink becomes a mailto link", () => {
    const marks = linkMarks("<user@example.com>");
    expect(marks[0]!.href).toBe("mailto:user@example.com");
  });

  it("bare GFM url is visible and clickable", () => {
    const marks = linkMarks("see https://www.rust-lang.org here");
    expect(marks).toHaveLength(1);
    expect(marks[0]!.href).toBe("https://www.rust-lang.org");
  });

  it("image url is NOT turned into a link", () => {
    const marks = linkMarks("![alt](https://host/pic.png)");
    expect(marks).toHaveLength(0);
  });

  it("reference definition url is NOT turned into a link", () => {
    const marks = linkMarks("[gh]: https://github.com \"GitHub\"");
    expect(marks).toHaveLength(0);
  });
});
