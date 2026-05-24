// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";

import { build } from "./build";
import { MathWidget } from "./math";
import { CodeFenceWidget } from "./codeFence";
import { VisualFenceWidget } from "./visualFence";
import { TableWidget } from "./table";
import { CalloutLabelWidget } from "./inlineWidgets";

function makeState(src: string): EditorState {
  return EditorState.create({
    doc: src,
    extensions: [markdown({ base: markdownLanguage })],
  });
}

function widgetTypes(src: string): string[] {
  const { decorations } = build(makeState(src));
  const out: string[] = [];
  const iter = decorations.iter();
  while (iter.value) {
    const spec = (iter.value as { spec?: { widget?: unknown } }).spec;
    const w = spec?.widget;
    if (w) out.push((w as object).constructor.name);
    iter.next();
  }
  return out;
}

describe("wysiwyg build — list-nested block elements", () => {
  it("renders $$ block math inside an ordered list item", () => {
    const src =
      "1. 列表 + 数学\n\n" +
      "   $$\n" +
      "   \\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\n" +
      "   $$\n";
    const types = widgetTypes(src);
    expect(types).toContain(MathWidget.name);
  });

  it("renders fenced code inside a list item", () => {
    const src =
      "1. 列表 + 代码\n\n" +
      "   ```js\n" +
      "   console.log(1);\n" +
      "   ```\n";
    const types = widgetTypes(src);
    // Either a plain CodeFenceWidget (js) or VisualFenceWidget (mermaid/dot/chart)
    expect(
      types.includes(CodeFenceWidget.name) || types.includes(VisualFenceWidget.name),
    ).toBe(true);
  });

  it("renders mermaid fence inside a list item as a visual widget", () => {
    const src =
      "1. 列表 + Mermaid\n\n" +
      "   ```mermaid\n" +
      "   graph TD\n" +
      "   A --> B\n" +
      "   ```\n";
    const types = widgetTypes(src);
    expect(types).toContain(VisualFenceWidget.name);
  });

  it("renders a table inside a list item", () => {
    const src =
      "1. 列表 + 表格\n\n" +
      "   | A | B |\n" +
      "   |---|---|\n" +
      "   | 1 | 2 |\n";
    const types = widgetTypes(src);
    expect(types).toContain(TableWidget.name);
  });

  it("renders a callout label inside a list item", () => {
    const src =
      "1. 列表 + Callout\n\n" +
      "   > [!NOTE]\n" +
      "   > Callout 在列表里\n";
    const types = widgetTypes(src);
    expect(types).toContain(CalloutLabelWidget.name);
  });

  it("renders $$ block math nested two levels deep", () => {
    const src =
      "1. 外层\n\n" +
      "   - 内层\n\n" +
      "     $$\n" +
      "     x^2\n" +
      "     $$\n";
    const types = widgetTypes(src);
    expect(types).toContain(MathWidget.name);
  });

  it("renders $$ block math with tab indent in a list item", () => {
    const src = "1. 列表\n\n\t$$\n\tx + y\n\t$$\n";
    const types = widgetTypes(src);
    expect(types).toContain(MathWidget.name);
  });

  it("renders mermaid fence with 4-space indent in a list item", () => {
    const src =
      "1. 列表\n\n" +
      "    ```mermaid\n" +
      "    graph TD\n" +
      "    A --> B\n" +
      "    ```\n";
    const types = widgetTypes(src);
    expect(types).toContain(VisualFenceWidget.name);
  });
});
