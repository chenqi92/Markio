import {
  insertBlock,
  prefixLine,
  replaceSelection,
  selectedText,
  wrapSelection,
} from "@/lib/editor-bridge";
import { useDialog } from "@/stores/dialog";

const URL_RE = /^(https?:\/\/|mailto:|\/|\.{1,2}\/|#)/i;

/** 生成空 GFM 表格：所有单元格为单空格占位（保证 markdown table 解析成立） */
function buildTableMarkdown(rows: number, cols: number): string {
  const safeRows = Math.max(1, Math.min(20, Math.floor(rows)));
  const safeCols = Math.max(1, Math.min(12, Math.floor(cols)));
  const emptyRow = "| " + Array(safeCols).fill(" ").join(" | ") + " |";
  const sepRow = "| " + Array(safeCols).fill("---").join(" | ") + " |";
  return [emptyRow, sepRow, ...Array(safeRows).fill(emptyRow)].join("\n");
}

function splitDelimitedLine(line: string): string[] {
  if (line.includes("\t")) return line.split("\t").map((cell) => cell.trim());
  if (line.includes("|")) {
    return line
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((cell) => cell.trim());
  }
  return line.split(/[,，]/).map((cell) => cell.trim());
}

function buildTableFromText(input: string): string | null {
  const lines = input
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  const rows = lines
    .map(splitDelimitedLine)
    .filter((row) => row.length > 0 && row.some(Boolean));
  if (rows.length === 0) return null;
  const cols = Math.max(...rows.map((row) => row.length));
  if (cols < 2) return null;
  const padded = rows.map((row) => {
    const next = row.slice();
    while (next.length < cols) next.push("");
    return next;
  });
  const header = padded[0];
  const body = padded.length > 1 ? padded.slice(1) : [Array(cols).fill("")];
  const separator = Array(cols).fill("---");
  return [header, separator, ...body]
    .map((row) => `| ${row.map((cell) => cell || " ").join(" | ")} |`)
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
  link: async () => {
    const current = selectedText().trim();
    const url = await useDialog.getState().prompt({
      title: "链接 URL",
      defaultValue: URL_RE.test(current) ? current : "https://",
      confirmLabel: "插入",
    });
    if (!url) return;
    if (URL_RE.test(current)) {
      replaceSelection(`[链接文本](${url})`, { selectText: "链接文本" });
      return;
    }
    wrapSelection("[", `](${url})`, "链接文本");
  },
  wikiLink: () => wrapSelection("[[", "]]", "笔记名"),
  image: async () => {
    const current = selectedText().trim();
    const url = await useDialog.getState().prompt({
      title: "图片 URL",
      defaultValue: URL_RE.test(current) ? current : "https://",
      confirmLabel: "插入",
    });
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
      // 把光标落在表头第一个单元格的空格内，方便直接打字命名列
      cursorOffset: 2,
    }),
  table: () => markdownCommands.insertTable(3, 3),
  selectionToTable: () => {
    const table = buildTableFromText(selectedText());
    if (!table) {
      markdownCommands.table();
      return;
    }
    const firstCell = table.split("|")[1]?.trim();
    if (firstCell) replaceSelection(table, { selectText: firstCell });
    else replaceSelection(table, { cursorOffset: 2 });
  },
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
  chart: () =>
    insertBlock(
      [
        "```chart",
        "{",
        '  "type": "bar",',
        '  "title": "月度趋势",',
        '  "labels": ["一月", "二月", "三月"],',
        '  "series": [',
        '    { "name": "收入", "data": [12, 18, 24] },',
        '    { "name": "成本", "data": [8, 11, 14] }',
        "  ]",
        "}",
        "```",
      ].join("\n"),
      {
        atLineStart: true,
        ensureBlankLines: true,
        selectText: "月度趋势",
      },
    ),
  graphviz: () =>
    insertBlock("```dot\ndigraph G {\n  A -> B\n}\n```", {
      atLineStart: true,
      ensureBlankLines: true,
      selectText: "A -> B",
    }),
  plantuml: () =>
    insertBlock("```plantuml\n@startuml\nA -> B: message\n@enduml\n```", {
      atLineStart: true,
      ensureBlankLines: true,
      selectText: "A -> B: message",
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
