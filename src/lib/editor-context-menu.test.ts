// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { detectContext } from "./editor-context-menu";

function makeView(source: string): EditorView {
  const state = EditorState.create({
    doc: source,
    extensions: [markdown()],
  });
  // EditorView is fine without DOM mount for detectContext (it only walks syntaxTree)
  return new EditorView({ state });
}

describe("detectContext", () => {
  it("detects a link at the cursor", () => {
    const src = "see [GitHub](https://github.com) for more";
    const view = makeView(src);
    const pos = src.indexOf("GitHub") + 1;
    const ctx = detectContext(view, pos);
    expect(ctx.link).not.toBeNull();
    expect(ctx.link?.href).toBe("https://github.com");
    expect(ctx.link?.text).toBe("GitHub");
  });

  it("detects an image at the cursor", () => {
    const src = "![alt text](https://x/y.png) trailing";
    const view = makeView(src);
    const pos = src.indexOf("alt") + 1;
    const ctx = detectContext(view, pos);
    expect(ctx.image).not.toBeNull();
    expect(ctx.image?.src).toBe("https://x/y.png");
    expect(ctx.image?.alt).toBe("alt text");
  });

  it("detects a fenced code block and its language", () => {
    const src = "```ts\nconst a = 1;\nconst b = 2;\n```\n";
    const view = makeView(src);
    const pos = src.indexOf("const a") + 1;
    const ctx = detectContext(view, pos);
    expect(ctx.inCodeBlock).not.toBeNull();
    expect(ctx.inCodeBlock?.lang).toBe("ts");
  });

  it("detects heading level", () => {
    const src = "## Section title\n\nbody";
    const view = makeView(src);
    const pos = src.indexOf("Section") + 1;
    const ctx = detectContext(view, pos);
    expect(ctx.headingLevel).toBe(2);
  });

  it("reports selection text when a range is selected", () => {
    const src = "hello world";
    const view = makeView(src);
    view.dispatch({ selection: EditorSelection.single(0, 5) });
    const ctx = detectContext(view, 2);
    expect(ctx.hasSelection).toBe(true);
    expect(ctx.selectionText).toBe("hello");
  });

  it("returns no link / image / code when in plain text", () => {
    const src = "just some plain words here";
    const view = makeView(src);
    const ctx = detectContext(view, 5);
    expect(ctx.link).toBeNull();
    expect(ctx.image).toBeNull();
    expect(ctx.inCodeBlock).toBeNull();
    expect(ctx.inInlineCode).toBeNull();
    expect(ctx.headingLevel).toBeNull();
  });
});
