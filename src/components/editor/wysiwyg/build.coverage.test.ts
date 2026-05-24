// @vitest-environment happy-dom
//
// wysiwyg 渲染覆盖测试 —— 给每类 markdown 元素一份"它有没有被 wysiwyg 处理"的
// 真值表。失败用例 = 当前未渲染或错渲染的 case。

import { describe, expect, it } from "vitest";
import { EditorState, RangeSetBuilder } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Decoration } from "@codemirror/view";

import { build } from "./build";
import { MathWidget } from "./math";
import { CodeFenceWidget } from "./codeFence";
import { VisualFenceWidget } from "./visualFence";
import { TableWidget } from "./table";
import {
  CalloutLabelWidget,
  HrWidget,
  ImageWidget,
  ListMarkerWidget,
  TaskCheckbox,
} from "./inlineWidgets";
import { WikilinkWidget } from "./wikilink";

function makeState(src: string): EditorState {
  // 选区放到文档末尾：很多 widget 在 cursor-inside 时退化成源码（block code、
  // block math 等），用末尾选区模拟"用户已经把光标移开"的稳态视图。
  return EditorState.create({
    doc: src,
    selection: { anchor: src.length },
    extensions: [markdown({ base: markdownLanguage })],
  });
}

interface Inspect {
  widgets: string[];
  /** mark / line decoration 的 class 集合 */
  classes: string[];
}

function inspect(src: string): Inspect {
  const { decorations } = build(makeState(src));
  const widgets: string[] = [];
  const classes: string[] = [];
  const iter = decorations.iter();
  while (iter.value) {
    const spec = (iter.value as { spec?: { widget?: unknown; class?: string } }).spec;
    if (spec?.widget) widgets.push((spec.widget as object).constructor.name);
    if (spec?.class) classes.push(spec.class);
    iter.next();
  }
  return { widgets, classes };
}

// keep RangeSetBuilder import referenced; vitest tree-shake otherwise warns
void RangeSetBuilder;
void Decoration;

describe("wysiwyg coverage — block elements", () => {
  it("ATX headings H1-H6 each get a line class", () => {
    for (let lvl = 1; lvl <= 6; lvl++) {
      const src = `${"#".repeat(lvl)} hello\n`;
      const { classes } = inspect(src);
      expect(classes.some((c) => c.includes(`cm-md-h${lvl}`))).toBe(true);
    }
  });

  it("Setext H1/H2 get line classes", () => {
    expect(
      inspect("Title\n=====\n").classes.some((c) => c.includes("cm-md-h1")),
    ).toBe(true);
    expect(
      inspect("Title\n-----\n").classes.some((c) => c.includes("cm-md-h2")),
    ).toBe(true);
  });

  it("blockquote line is styled", () => {
    const { classes } = inspect("> quoted\n");
    expect(classes.some((c) => c.includes("cm-md-quote-line"))).toBe(true);
  });

  it("callout `> [!NOTE]` gets a label widget", () => {
    const { widgets, classes } = inspect("> [!NOTE]\n> body\n");
    expect(widgets).toContain(CalloutLabelWidget.name);
    expect(classes.some((c) => c.includes("cm-md-callout"))).toBe(true);
  });

  it("horizontal rule `---` becomes HrWidget", () => {
    const { widgets } = inspect("para\n\n---\n\nafter\n");
    expect(widgets).toContain(HrWidget.name);
  });

  it("ordered list marker becomes ListMarkerWidget", () => {
    const { widgets } = inspect("1. one\n2. two\n");
    expect(widgets).toContain(ListMarkerWidget.name);
  });

  it("unordered list marker becomes ListMarkerWidget", () => {
    const { widgets } = inspect("- one\n- two\n");
    expect(widgets).toContain(ListMarkerWidget.name);
  });

  it("task list `- [ ]` / `- [x]` becomes TaskCheckbox", () => {
    const { widgets } = inspect("- [ ] todo\n- [x] done\n");
    expect(widgets).toContain(TaskCheckbox.name);
  });

  it("GFM table becomes a TableWidget", () => {
    const src = "| A | B |\n|---|---|\n| 1 | 2 |\n";
    const { widgets } = inspect(src);
    expect(widgets).toContain(TableWidget.name);
  });

  it("fenced code becomes CodeFenceWidget", () => {
    const { widgets } = inspect("```js\nconsole.log(1)\n```\n");
    expect(widgets).toContain(CodeFenceWidget.name);
  });

  it("mermaid fence becomes VisualFenceWidget", () => {
    const { widgets } = inspect("```mermaid\ngraph TD\nA --> B\n```\n");
    expect(widgets).toContain(VisualFenceWidget.name);
  });

  it("dot/graphviz fence becomes VisualFenceWidget", () => {
    const { widgets } = inspect("```dot\ndigraph { A -> B }\n```\n");
    expect(widgets).toContain(VisualFenceWidget.name);
  });

  it("chart fence becomes VisualFenceWidget", () => {
    const { widgets } = inspect("```chart\n{\"type\":\"bar\"}\n```\n");
    expect(widgets).toContain(VisualFenceWidget.name);
  });

  it("inline math `$x$` becomes MathWidget", () => {
    const { widgets } = inspect("公式 $x^2$ 后面\n");
    expect(widgets).toContain(MathWidget.name);
  });

  it("block math `$$...$$` becomes MathWidget", () => {
    // 末尾加段文字，让选区可以落在公式之外（MathWidget cursor-sensitive
    // 是 inclusive=true，文档纯公式时光标在 end 也会被算作"在 widget 内"）
    const { widgets } = inspect("$$\nx^2\n$$\n\nafter\n");
    expect(widgets).toContain(MathWidget.name);
  });

  it("wikilink `[[Note]]` becomes WikilinkWidget", () => {
    const { widgets } = inspect("see [[My Note]] for more\n");
    expect(widgets).toContain(WikilinkWidget.name);
  });

  it("image `![alt](https://example.com/a.png)` becomes ImageWidget", () => {
    const { widgets } = inspect("![cat](https://example.com/a.png)\n");
    expect(widgets).toContain(ImageWidget.name);
  });
});

describe("wysiwyg coverage — corner cases / known risks", () => {
  it("YAML frontmatter `---` is NOT rendered as a horizontal rule", () => {
    // 风险：文档开头的 frontmatter delimiter 不能当 HR 渲染，否则视觉错乱
    const src = "---\ntitle: Foo\n---\n\nbody\n";
    const { widgets } = inspect(src);
    expect(widgets.filter((w) => w === HrWidget.name)).toEqual([]);
  });

  it("inline math inside `inline code` is not picked up", () => {
    const { widgets } = inspect("`$not math$` and `$$also not$$`\n");
    expect(widgets.filter((w) => w === MathWidget.name)).toEqual([]);
  });

  it("escaped \\$ is not a math delimiter", () => {
    const { widgets } = inspect("price is \\$5 not math\n");
    expect(widgets.filter((w) => w === MathWidget.name)).toEqual([]);
  });

  it("multiple inline maths on the same line each become widgets", () => {
    const { widgets } = inspect("set $a$ and $b$ are vars\n");
    const count = widgets.filter((w) => w === MathWidget.name).length;
    expect(count).toBe(2);
  });

  it("block math inside fenced code is NOT picked up as math", () => {
    const src = "```\n$$\nx\n$$\n```\n";
    const { widgets } = inspect(src);
    expect(widgets.filter((w) => w === MathWidget.name)).toEqual([]);
  });

  it("wikilink inside fenced code is NOT picked up", () => {
    const src = "```\nsee [[Note]] reference\n```\n";
    const { widgets } = inspect(src);
    expect(widgets.filter((w) => w === WikilinkWidget.name)).toEqual([]);
  });

  it("GFM strikethrough is parsed (no widget but a `cm-md-strike` mark)", () => {
    const { classes } = inspect("~~删除线~~\n");
    expect(classes.some((c) => c.includes("cm-md-strike"))).toBe(true);
  });

  it("empty fenced code block produces a CodeFenceWidget anyway", () => {
    const { widgets } = inspect("```js\n```\n");
    expect(widgets).toContain(CodeFenceWidget.name);
  });

  it("empty mermaid fence falls back to CodeFenceWidget (visual needs body)", () => {
    const { widgets } = inspect("```mermaid\n```\n");
    expect(widgets).toContain(CodeFenceWidget.name);
    expect(widgets).not.toContain(VisualFenceWidget.name);
  });
});
