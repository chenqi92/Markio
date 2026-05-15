import {
  insertBlock,
  prefixLine,
  replaceSelection,
  selectedText,
  wrapSelection,
} from "@/lib/editor-bridge";

const URL_RE = /^(https?:\/\/|mailto:|\/|\.{1,2}\/|#)/i;

function buildTableMarkdown(rows: number, cols: number): string {
  const safeRows = Math.max(1, Math.min(20, Math.floor(rows)));
  const safeCols = Math.max(1, Math.min(12, Math.floor(cols)));
  const header = Array.from({ length: safeCols }, (_, i) => `列 ${i + 1}`);
  const separator = Array.from({ length: safeCols }, () => "---");
  const bodyRows = Array.from({ length: safeRows }, () =>
    Array.from({ length: safeCols }, () => "内容"),
  );
  return [header, separator, ...bodyRows]
    .map((row) => `| ${row.join(" | ")} |`)
    .join("\n");
}

export const markdownCommands = {
  h1: () => prefixLine("# "),
  h2: () => prefixLine("## "),
  h3: () => prefixLine("### "),
  h4: () => prefixLine("#### "),
  bold: () => wrapSelection("**", "**", "加粗文字"),
  italic: () => wrapSelection("*", "*", "斜体"),
  strike: () => wrapSelection("~~", "~~", "删除"),
  mark: () => wrapSelection("==", "==", "高亮"),
  inlineCode: () => wrapSelection("`", "`", "code"),
  underline: () => wrapSelection("<u>", "</u>", "下划线"),
  link: () => {
    const current = selectedText().trim();
    const url = window.prompt("链接 URL", URL_RE.test(current) ? current : "https://");
    if (!url) return;
    if (URL_RE.test(current)) {
      replaceSelection(`[链接文本](${url})`, { selectText: "链接文本" });
      return;
    }
    wrapSelection("[", `](${url})`, "链接文本");
  },
  wikiLink: () => wrapSelection("[[", "]]", "笔记名"),
  image: () => {
    const current = selectedText().trim();
    const url = window.prompt("图片 URL", URL_RE.test(current) ? current : "https://");
    if (!url) return;
    if (URL_RE.test(current)) {
      replaceSelection(`![alt](${url})`, { selectText: "alt" });
      return;
    }
    wrapSelection("![", `](${url})`, "alt");
  },
  bulletList: () => prefixLine("- "),
  orderedList: () => prefixLine("1. "),
  taskList: () => prefixLine("- [ ] "),
  quote: () => prefixLine("> "),
  insertTable: (rows = 3, cols = 3) =>
    insertBlock(buildTableMarkdown(rows, cols), {
      atLineStart: true,
      ensureBlankLines: true,
      selectText: "列 1",
    }),
  table: () => markdownCommands.insertTable(3, 3),
  codeBlock: () =>
    insertBlock("```ts\n代码\n```", {
      atLineStart: true,
      ensureBlankLines: true,
      selectText: "代码",
    }),
  mathBlock: () =>
    insertBlock("$$\n公式\n$$", {
      atLineStart: true,
      ensureBlankLines: true,
      selectText: "公式",
    }),
  mermaid: () =>
    insertBlock("```mermaid\ngraph LR\n  A --> B\n```", {
      atLineStart: true,
      ensureBlankLines: true,
      selectText: "graph LR",
    }),
  callout: () =>
    insertBlock("> [!TIP]\n> 提示内容", {
      atLineStart: true,
      ensureBlankLines: true,
      selectText: "提示内容",
    }),
  footnote: () =>
    insertBlock("[^1]: 脚注内容", {
      atLineStart: true,
      ensureBlankLines: true,
      selectText: "脚注内容",
    }),
  horizontalRule: () =>
    insertBlock("---", {
      atLineStart: true,
      ensureBlankLines: true,
    }),
};

export type MarkdownCommandName = keyof typeof markdownCommands;
