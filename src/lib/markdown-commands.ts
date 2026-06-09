import {
  insertBlock,
  prefixLine,
  replaceSelection,
  runRegisteredMarkdownCommand,
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
  const header = padded[0]!;
  const body = padded.length > 1 ? padded.slice(1) : [Array(cols).fill("")];
  const separator = Array(cols).fill("---");
  return [header, separator, ...body]
    .map((row) => `| ${row.map((cell) => cell || " ").join(" | ")} |`)
    .join("\n");
}

export interface ChartTypeSpec {
  id: "bar" | "line" | "area" | "scatter" | "pie" | "donut";
  label: string;
  /** 对应 Icon 组件里的图标名。 */
  icon: "chart" | "chart-line" | "chart-area" | "chart-scatter" | "chart-pie" | "chart-donut";
  sub: string;
}

// 图表类型注册表：工具栏的二次选择 + Slash 菜单都从这里生成。以后新增类型
// （雷达 / 漏斗 …）只要往这里加一项 + 在 chartTemplate 里补模板，并在 charts.ts
// 的渲染器里支持对应 type 即可。
export const CHART_TYPES: ChartTypeSpec[] = [
  { id: "bar", label: "柱状图", icon: "chart", sub: "分类对比 bar" },
  { id: "line", label: "折线图", icon: "chart-line", sub: "趋势变化 line" },
  { id: "area", label: "面积图", icon: "chart-area", sub: "累积趋势 area" },
  { id: "scatter", label: "散点图", icon: "chart-scatter", sub: "分布相关 scatter" },
  { id: "pie", label: "饼图", icon: "chart-pie", sub: "占比分布 pie" },
  { id: "donut", label: "环形图", icon: "chart-donut", sub: "占比分布 donut" },
];

function chartTemplate(id: ChartTypeSpec["id"]): { template: string; select: string } {
  if (id === "line" || id === "area") {
    return {
      select: "周访问量",
      template: [
        "```chart",
        "{",
        `  "type": "${id}",`,
        '  "title": "周访问量",',
        '  "labels": ["周一", "周二", "周三", "周四", "周五"],',
        '  "series": [',
        '    { "name": "访问", "data": [120, 200, 150, 280, 240] }',
        "  ]",
        "}",
        "```",
      ].join("\n"),
    };
  }
  if (id === "scatter") {
    return {
      select: "样本分布",
      template: [
        "```chart",
        "{",
        '  "type": "scatter",',
        '  "title": "样本分布",',
        '  "labels": ["1", "2", "3", "4", "5", "6"],',
        '  "series": [',
        '    { "name": "样本", "data": [12, 28, 9, 33, 21, 40] }',
        "  ]",
        "}",
        "```",
      ].join("\n"),
    };
  }
  if (id === "pie" || id === "donut") {
    return {
      select: "占比分布",
      template: [
        "```chart",
        "{",
        `  "type": "${id}",`,
        '  "title": "占比分布",',
        '  "labels": ["移动端", "桌面端", "其它"],',
        '  "values": [62, 31, 7]',
        "}",
        "```",
      ].join("\n"),
    };
  }
  return {
    select: "月度趋势",
    template: [
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
  };
}

/** 按类型插入图表模板（工具栏 / Slash 的二次选择都走它）。 */
export function insertChart(id: ChartTypeSpec["id"] = "bar") {
  const { template, select } = chartTemplate(id);
  insertBlock(template, {
    atLineStart: true,
    ensureBlankLines: true,
    selectText: select,
  });
}

export const markdownCommands = {
  h1: () => runRegisteredMarkdownCommand("h1") || prefixLine("# "),
  h2: () => runRegisteredMarkdownCommand("h2") || prefixLine("## "),
  h3: () => runRegisteredMarkdownCommand("h3") || prefixLine("### "),
  h4: () => runRegisteredMarkdownCommand("h4") || prefixLine("#### "),
  h5: () => runRegisteredMarkdownCommand("h5") || prefixLine("##### "),
  bold: () =>
    runRegisteredMarkdownCommand("bold") ||
    wrapSelection("**", "**", "加粗文字"),
  italic: () =>
    runRegisteredMarkdownCommand("italic") ||
    wrapSelection("*", "*", "斜体"),
  strike: () =>
    runRegisteredMarkdownCommand("strike") ||
    wrapSelection("~~", "~~", "删除"),
  mark: () =>
    runRegisteredMarkdownCommand("mark") ||
    wrapSelection("==", "==", "高亮"),
  inlineCode: () =>
    runRegisteredMarkdownCommand("inlineCode") ||
    wrapSelection("`", "`", "code"),
  underline: () =>
    runRegisteredMarkdownCommand("underline") ||
    wrapSelection("<u>", "</u>", "下划线"),
  link: async () => {
    if (runRegisteredMarkdownCommand("link")) return;
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
  wikiLink: () =>
    runRegisteredMarkdownCommand("wikiLink") ||
    wrapSelection("[[", "]]", "笔记名"),
  image: async () => {
    if (runRegisteredMarkdownCommand("image")) return;
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
  bulletList: () =>
    runRegisteredMarkdownCommand("bulletList") || prefixLine("- "),
  orderedList: () =>
    runRegisteredMarkdownCommand("orderedList") || prefixLine("1. "),
  taskList: () =>
    runRegisteredMarkdownCommand("taskList") || prefixLine("- [ ] "),
  quote: () => runRegisteredMarkdownCommand("quote") || prefixLine("> "),
  insertTable: (rows = 3, cols = 3) =>
    runRegisteredMarkdownCommand("insertTable", [rows, cols]) ||
    insertBlock(buildTableMarkdown(rows, cols), {
      atLineStart: true,
      ensureBlankLines: true,
      // 把光标落在表头第一个单元格的空格内，方便直接打字命名列
      cursorOffset: 2,
    }),
  table: () => markdownCommands.insertTable(3, 3),
  selectionToTable: () => {
    if (runRegisteredMarkdownCommand("selectionToTable")) return;
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
    runRegisteredMarkdownCommand("codeBlock") ||
    insertBlock("```ts\n代码\n```", {
      atLineStart: true,
      ensureBlankLines: true,
      selectText: "代码",
    }),
  mathBlock: () =>
    runRegisteredMarkdownCommand("mathBlock") ||
    insertBlock("$$\n公式\n$$", {
      atLineStart: true,
      ensureBlankLines: true,
      selectText: "公式",
    }),
  mermaid: () =>
    runRegisteredMarkdownCommand("mermaid") ||
    insertBlock("```mermaid\ngraph LR\n  A --> B\n```", {
      atLineStart: true,
      ensureBlankLines: true,
      selectText: "graph LR",
    }),
  chart: () => runRegisteredMarkdownCommand("chart") || insertChart("bar"),
  /** 指定类型插入图表（工具栏 / Slash 二次选择用）。 */
  chartType: (id: ChartTypeSpec["id"]) => insertChart(id),
  serverBlock: () =>
    runRegisteredMarkdownCommand("serverBlock") ||
    insertBlock(
      [
        "```server",
        "name: 生产数据库",
        "type: mysql",
        "host: 192.168.1.10",
        "port: 3306",
        "user: root",
        "password: change-me",
        "lan: 10.0.0.10",
        "note: 仅内网访问",
        "---",
        "name: 后台管理",
        "type: web",
        "url: https://admin.example.com",
        "user: admin",
        "password: change-me",
        "```",
      ].join("\n"),
      {
        atLineStart: true,
        ensureBlankLines: true,
        selectText: "生产数据库",
      },
    ),
  graphviz: () =>
    runRegisteredMarkdownCommand("graphviz") ||
    insertBlock("```dot\ndigraph G {\n  A -> B\n}\n```", {
      atLineStart: true,
      ensureBlankLines: true,
      selectText: "A -> B",
    }),
  plantuml: () =>
    runRegisteredMarkdownCommand("plantuml") ||
    insertBlock("```plantuml\n@startuml\nA -> B: message\n@enduml\n```", {
      atLineStart: true,
      ensureBlankLines: true,
      selectText: "A -> B: message",
    }),
  callout: () =>
    runRegisteredMarkdownCommand("callout") ||
    insertBlock("> [!TIP]\n> 提示内容", {
      atLineStart: true,
      ensureBlankLines: true,
      selectText: "提示内容",
    }),
  footnote: () =>
    runRegisteredMarkdownCommand("footnote") ||
    insertBlock("[^1]: 脚注内容", {
      atLineStart: true,
      ensureBlankLines: true,
      selectText: "脚注内容",
    }),
  horizontalRule: () =>
    runRegisteredMarkdownCommand("horizontalRule") ||
    insertBlock("---", {
      atLineStart: true,
      ensureBlankLines: true,
    }),
};

export type MarkdownCommandName = keyof typeof markdownCommands;
