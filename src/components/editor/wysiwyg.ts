/**
 * Markdown WYSIWYG decoration plugin for CodeMirror 6.
 *
 * 思路：用 `syntaxTree` 拿到 lezer 的 markdown AST，对每个语法节点
 * 生成 Decoration —— 给整行加 class（标题大字号、引用左边线…）、给行内
 * 段落加 mark（粗体 / 斜体 / 行内代码 / 链接 / 删除线）、把 markdown
 * 标记字符（# / ** / ` / > / [] / [x] / ![]() …）替换为隐藏 widget 或空。
 *
 * 光标在某行时，整行的 marker 全部"现形"以便编辑；离开则隐藏。
 */
import { syntaxTree } from "@codemirror/language";
import { type EditorState, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import DOMPurify from "dompurify";
import { cursorInsideRange, detectMathRanges } from "@/lib/math-ranges";
import {
  applyImageElementSizing,
  parseImageMarkdown,
  type ImageParts,
} from "@/lib/markdown-images";
import { parseWikiLinkBody, resolveWikiFile } from "@/lib/wikilinks";
import { renderChartBlock } from "@/lib/charts";
import { renderGraphvizBlock } from "@/lib/diagrams";
import { renderMermaidBlock } from "@/lib/mermaid";
import { useVaultIndex } from "@/stores/vaultIndex";
import { useWorkspace } from "@/stores/workspace";
import { useTabs } from "@/stores/tabs";
import { useUI } from "@/stores/ui";

type KatexModule = typeof import("katex");
let katexPromise: Promise<KatexModule> | null = null;
function getKatex(): Promise<KatexModule> {
  if (!katexPromise) katexPromise = import("katex");
  return katexPromise;
}

// 渲染失败时不让 widget 退化为空白 —— 显示带 ❗ 的灰字，让用户知道写错了。
function renderKatexInto(host: HTMLElement, source: string, display: boolean) {
  void getKatex()
    .then((katex) => {
      try {
        const html = katex.renderToString(source, {
          displayMode: display,
          throwOnError: false,
          strict: "ignore",
          output: "htmlAndMathml",
        });
        host.innerHTML = DOMPurify.sanitize(html, {
          USE_PROFILES: { html: true, mathMl: true, svg: true },
        });
      } catch (err) {
        host.classList.add("cm-md-math-error");
        host.textContent = `❗ ${(err as Error).message}`;
      }
    })
    .catch((err) => {
      host.classList.add("cm-md-math-error");
      host.textContent = `❗ KaTeX 加载失败：${(err as Error).message}`;
    });
}

class MathWidget extends WidgetType {
  constructor(
    private readonly source: string,
    private readonly display: boolean,
  ) {
    super();
  }
  eq(other: WidgetType): boolean {
    return (
      other instanceof MathWidget &&
      other.source === this.source &&
      other.display === this.display
    );
  }
  toDOM(): HTMLElement {
    const el = document.createElement(this.display ? "div" : "span");
    el.className = this.display ? "cm-md-math-block" : "cm-md-math-inline";
    el.dataset.mathDisplay = String(this.display);
    el.textContent = this.display ? `$$${this.source}$$` : `$${this.source}$`;
    renderKatexInto(el, this.source, this.display);
    return el;
  }
  ignoreEvent() {
    // Let mousedown bubble so the wysiwyg plugin can move the caret into the source.
    return false;
  }
}

// ─── Visual fenced-code widgets (mermaid / dot / chart) ────────────────────
// Match the conventions the preview render pipeline uses so we can reuse the
// per-block render helpers without duplicating logic.

type VisualLang = "mermaid" | "dot" | "chart";

// Rendering visual fenced blocks inside the editor runs on CodeMirror's startup
// decoration path. Keep the WYSIWYG editor lightweight; split/preview mode owns
// the expensive chart/diagram rendering pipeline.
const WYSIWYG_VISUAL_FENCES_ENABLED = true;

function detectVisualLang(lang: string): VisualLang | null {
  const lower = lang.toLowerCase();
  if (lower === "mermaid") return "mermaid";
  if (lower === "dot" || lower === "graphviz") return "dot";
  if (lower === "chart" || lower === "markio-chart" || lower === "charts") return "chart";
  return null;
}

async function renderVisualWidget(host: HTMLElement, kind: VisualLang, source: string) {
  const encoded = encodeURIComponent(source);
  try {
    if (kind === "mermaid") {
      host.classList.add("mermaid-block");
      host.setAttribute("data-mermaid", encoded);
      await renderMermaidBlock(host);
    } else if (kind === "dot") {
      host.classList.add("graphviz-block");
      host.setAttribute("data-graphviz", encoded);
      await renderGraphvizBlock(host);
    } else {
      host.classList.add("chart-block");
      host.setAttribute("data-chart", encoded);
      renderChartBlock(host);
    }
  } catch (err) {
    host.classList.add("cm-md-fenced-error");
    const pre = document.createElement("pre");
    pre.style.whiteSpace = "pre-wrap";
    pre.style.fontSize = "12px";
    pre.style.color = "var(--text-3)";
    pre.textContent = `${kind} 渲染失败：${(err as Error).message}\n\n${source}`;
    host.replaceChildren(pre);
  }
}

class VisualFenceWidget extends WidgetType {
  constructor(
    private readonly kind: VisualLang,
    private readonly source: string,
  ) {
    super();
  }
  eq(other: WidgetType): boolean {
    return (
      other instanceof VisualFenceWidget &&
      other.kind === this.kind &&
      other.source === this.source
    );
  }
  toDOM(): HTMLElement {
    const el = document.createElement("div");
    el.className = `cm-md-fenced-widget cm-md-fenced-${this.kind}`;
    el.dataset.kind = this.kind;
    void renderVisualWidget(el, this.kind, this.source);
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

function codeLines(raw: string): string[] {
  const withoutFinalNewline = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  return withoutFinalNewline.length === 0 ? [""] : withoutFinalNewline.split("\n");
}

function safeLanguageClass(lang: string): string {
  return lang.trim().toLowerCase().replace(/[^\w-]/g, "");
}

// 把 highlight.js core 和 13 个语言 grammar 改成按需 lazy：
//
// 旧实现把 hljs/lib/core 与 bash/css/go/java/js/json/markdown/python/rust/sql/
// ts/xml/yaml 13 个语言全部静态 top-level import，挂到 wysiwyg.ts；
// wysiwyg.ts 又被 SourceEditor 静态依赖 → 全部沉到主 chunk，每次 SourceEditor
// 启动都要解析 hljs + 全套词法（即使文档里没一个 fenced code）。
//
// 改成：core 一个独立 dynamic chunk；每个 grammar 自己 chunk，按 lang 首次
// 出现时拉一次。CodeFenceWidget.toDOM 先用 escape 后的明文渲染 → 拉完 grammar
// 再回填到同一个 <code>，眼里看到的是"代码块先以无色显示，几十毫秒后高亮亮起"。
//
// 一旦某语言加载过就缓存（langPromises Map）。

type HljsCore = typeof import("highlight.js/lib/core").default;

let hljsCorePromise: Promise<HljsCore> | null = null;
function loadHljsCore(): Promise<HljsCore> {
  if (!hljsCorePromise) {
    hljsCorePromise = import("highlight.js/lib/core").then((m) => m.default);
  }
  return hljsCorePromise;
}

// 一组工厂函数：value 必须是 () => import("...") 形式，让 Vite 各自切 chunk。
const LANG_LOADERS: Record<string, () => Promise<{ default: unknown }>> = {
  bash: () => import("highlight.js/lib/languages/bash"),
  sh: () => import("highlight.js/lib/languages/bash"),
  shell: () => import("highlight.js/lib/languages/bash"),
  zsh: () => import("highlight.js/lib/languages/bash"),
  css: () => import("highlight.js/lib/languages/css"),
  go: () => import("highlight.js/lib/languages/go"),
  golang: () => import("highlight.js/lib/languages/go"),
  java: () => import("highlight.js/lib/languages/java"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  js: () => import("highlight.js/lib/languages/javascript"),
  json: () => import("highlight.js/lib/languages/json"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  md: () => import("highlight.js/lib/languages/markdown"),
  python: () => import("highlight.js/lib/languages/python"),
  py: () => import("highlight.js/lib/languages/python"),
  rust: () => import("highlight.js/lib/languages/rust"),
  rs: () => import("highlight.js/lib/languages/rust"),
  sql: () => import("highlight.js/lib/languages/sql"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
  ts: () => import("highlight.js/lib/languages/typescript"),
  xml: () => import("highlight.js/lib/languages/xml"),
  html: () => import("highlight.js/lib/languages/xml"),
  svg: () => import("highlight.js/lib/languages/xml"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
  yml: () => import("highlight.js/lib/languages/yaml"),
};

const langPromises = new Map<string, Promise<string | null>>();

function ensureHighlightLanguage(lang: string): Promise<string | null> {
  const normalized = lang.trim().toLowerCase();
  if (!normalized) return Promise.resolve(null);
  const loader = LANG_LOADERS[normalized];
  if (!loader) return Promise.resolve(null);
  const cached = langPromises.get(normalized);
  if (cached) return cached;
  const p = (async () => {
    const hljs = await loadHljsCore();
    if (!hljs.getLanguage(normalized)) {
      const mod = await loader();
      // grammar 模块 default export 是 (hljs) => LanguageDefinition
      hljs.registerLanguage(normalized, mod.default as Parameters<typeof hljs.registerLanguage>[1]);
    }
    return normalized;
  })().catch(() => null);
  langPromises.set(normalized, p);
  return p;
}

function escapeCodeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function highlightCode(source: string, lang: string): Promise<string> {
  const normalized = await ensureHighlightLanguage(lang);
  if (!normalized) return escapeCodeHtml(source);
  try {
    const hljs = await loadHljsCore();
    return hljs.highlight(source, { language: normalized, ignoreIllegals: true }).value;
  } catch {
    return escapeCodeHtml(source);
  }
}

function codeFenceRangeFromHost(
  view: EditorView,
  host: HTMLElement,
): { from: number; to: number; source: string } | null {
  const from = view.posAtDOM(host);
  const len = Number(host.dataset.sourceLength);
  if (from == null || !Number.isFinite(len) || len <= 0) return null;
  const to = Math.min(view.state.doc.length, from + len);
  if (to <= from) return null;
  return { from, to, source: view.state.doc.sliceString(from, to) };
}

function fencedBodyRangeFromSource(
  from: number,
  source: string,
): { from: number; to: number } | null {
  const firstBreak = source.search(/\r?\n/);
  if (firstBreak < 0) return null;
  const breakLength = source[firstBreak] === "\r" ? 2 : 1;
  const bodyStart = from + firstBreak + breakLength;
  const closing = source.match(/\r?\n[ \t]*(`{3,}|~{3,})\s*$/);
  const bodyEnd = closing ? from + source.length - closing[0].length : from + source.length;
  return { from: bodyStart, to: Math.max(bodyStart, bodyEnd) };
}

function commitCodeFenceLang(view: EditorView, host: HTMLElement, value: string): boolean {
  const range = codeFenceRangeFromHost(view, host);
  if (!range) return false;
  const firstLine = view.state.doc.lineAt(range.from);
  const marker = firstLine.text.match(/^(\s*(`{3,}|~{3,}))[ \t]*/);
  if (!marker) return false;
  const lang = value.trim();
  const from = firstLine.from + marker[0].length;
  const to = firstLine.to;
  const current = view.state.doc.sliceString(from, to);
  if (current === lang) return false;
  view.dispatch({
    changes: { from, to, insert: lang },
    userEvent: "input",
  });
  return true;
}

function commitCodeFenceBody(view: EditorView, host: HTMLElement, value: string): boolean {
  const range = codeFenceRangeFromHost(view, host);
  if (!range) return false;
  const body = fencedBodyRangeFromSource(range.from, range.source);
  if (!body) return false;
  const next = value.replace(/\r\n/g, "\n").replace(/\n$/, "");
  const current = view.state.doc.sliceString(body.from, body.to);
  if (current === next) return false;
  view.dispatch({
    changes: { from: body.from, to: body.to, insert: next },
    userEvent: "input",
  });
  return true;
}

function resizeCodeFenceTextarea(textarea: HTMLTextAreaElement) {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.max(96, textarea.scrollHeight)}px`;
}

function startCodeFenceBodyEdit(view: EditorView, host: HTMLElement, source: string) {
  const body = host.querySelector<HTMLElement>(".cm-md-code-body");
  if (!body || body.querySelector(".cm-md-code-editor")) return;

  const textarea = document.createElement("textarea");
  textarea.className = "cm-md-code-editor";
  textarea.spellcheck = false;
  textarea.value = source;
  textarea.setAttribute("aria-label", "编辑代码块内容");

  const commit = () => {
    commitCodeFenceBody(view, host, textarea.value);
  };
  textarea.addEventListener("mousedown", (event) => event.stopPropagation());
  textarea.addEventListener("click", (event) => event.stopPropagation());
  textarea.addEventListener("input", () => resizeCodeFenceTextarea(textarea));
  textarea.addEventListener("blur", commit);
  textarea.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      textarea.blur();
    } else if (event.key === "Escape") {
      event.preventDefault();
      textarea.value = source;
      textarea.blur();
    }
  });

  body.replaceChildren(textarea);
  resizeCodeFenceTextarea(textarea);
  textarea.focus({ preventScroll: true });
}

function installCodeFenceDomHandlers(
  view: EditorView,
  host: HTMLElement,
  source: string,
) {
  const input = host.querySelector<HTMLInputElement>(".cm-md-code-lang-input");
  const edit = host.querySelector<HTMLButtonElement>(".cm-md-code-edit");
  const body = host.querySelector<HTMLElement>(".cm-md-code-body");

  if (input) {
    const commit = () => commitCodeFenceLang(view, host, input.value);
    input.addEventListener("mousedown", (event) => event.stopPropagation());
    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        input.blur();
      } else if (event.key === "Escape") {
        event.preventDefault();
        input.value = host.dataset.lang ?? "";
        input.blur();
      }
    });
  }

  edit?.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  edit?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    startCodeFenceBodyEdit(view, host, source);
  });

  body?.addEventListener("mousedown", (event) => {
    if (event.target instanceof HTMLTextAreaElement) return;
    event.preventDefault();
    event.stopPropagation();
    startCodeFenceBodyEdit(view, host, source);
  });
}

class CodeFenceWidget extends WidgetType {
  constructor(
    private readonly lang: string,
    private readonly source: string,
    private readonly sourceLength: number,
  ) {
    super();
  }
  eq(other: WidgetType): boolean {
    return (
      other instanceof CodeFenceWidget &&
      other.lang === this.lang &&
      other.source === this.source &&
      other.sourceLength === this.sourceLength
    );
  }
  toDOM(view: EditorView): HTMLElement {
    const lang = this.lang.trim();
    const safeLang = safeLanguageClass(lang);
    const figure = document.createElement("figure");
    figure.className = "cm-md-code-widget";
    figure.dataset.lang = lang;
    figure.dataset.sourceLength = String(this.sourceLength);

    const head = document.createElement("figcaption");
    head.className = "cm-md-code-head";

    const input = document.createElement("input");
    input.className = "cm-md-code-lang-input";
    input.value = lang;
    input.placeholder = "plain text";
    input.spellcheck = false;
    input.setAttribute("aria-label", "代码块语言");

    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "cm-md-code-edit";
    edit.textContent = "编辑";
    edit.setAttribute("aria-label", "编辑代码块内容");

    head.append(input, edit);

    const body = document.createElement("div");
    body.className = "cm-md-code-body";
    body.title = "点击编辑代码内容";

    const gutter = document.createElement("div");
    gutter.className = "cm-md-code-gutter";
    codeLines(this.source).forEach((_, index) => {
      const line = document.createElement("span");
      line.textContent = String(index + 1);
      gutter.append(line);
    });

    const pre = document.createElement("pre");
    pre.className = "cm-md-code-pre";
    const code = document.createElement("code");
    code.className = `hljs${safeLang ? ` language-${safeLang}` : ""}`;
    // 先用 escape 后的明文渲染，避免 toDOM 同步阻塞等待 hljs lazy chunk；
    // grammar 拉完后回填到同一个 <code>（CodeFenceWidget.eq 比对 source/lang，
    // 只要内容没变，DOM 会被 CodeMirror 复用，回填后高亮一直保留）。
    const sourceForHighlight = this.source;
    code.innerHTML = DOMPurify.sanitize(escapeCodeHtml(sourceForHighlight), {
      USE_PROFILES: { html: true },
    });
    void highlightCode(sourceForHighlight, lang).then((html) => {
      code.innerHTML = DOMPurify.sanitize(html, {
        USE_PROFILES: { html: true },
      });
    });
    pre.append(code);
    body.append(gutter, pre);

    figure.append(head, body);
    installCodeFenceDomHandlers(view, figure, this.source);
    return figure;
  }
  ignoreEvent() {
    return true;
  }
}

/**
 * Read the fenced-code body for a `n === "FencedCode"` node. The lezer node
 * spans both fences; we strip the first line (```lang) and the trailing
 * ``` line. Returns the inner source code (no trailing newline).
 */
function extractFencedBody(state: EditorState, from: number, to: number): string {
  const firstLine = state.doc.lineAt(from);
  const bodyStart = Math.min(firstLine.to + 1, state.doc.length);
  if (bodyStart >= to) return "";
  const slice = state.doc.sliceString(bodyStart, to);
  // strip a trailing ``` / ~~~ line if present
  const stripped = slice.replace(/\r?\n?[ \t]*(`{3,}|~{3,})\s*$/, "");
  return stripped;
}

function extractFenceLang(state: EditorState, from: number): string {
  const firstLine = state.doc.lineAt(from);
  const m = firstLine.text.match(/^\s*(`{3,}|~{3,})\s*([\w-]+)/);
  return m ? m[2]! : "";
}

// ─── Table widget ───────────────────────────────────────────────────────────

export interface ParsedTable {
  header: string[];
  aligns: Array<"left" | "center" | "right" | null>;
  rows: string[][];
}

function tableColumnCount(parsed: ParsedTable): number {
  return Math.max(1, parsed.header.length, parsed.aligns.length, ...parsed.rows.map((r) => r.length));
}

function normalizedTable(parsed: ParsedTable): ParsedTable {
  const cols = tableColumnCount(parsed);
  const header = parsed.header.slice();
  while (header.length < cols) header.push("");
  const aligns = parsed.aligns.slice();
  while (aligns.length < cols) aligns.push(null);
  const rows = parsed.rows.map((row) => {
    const next = row.slice();
    while (next.length < cols) next.push("");
    return next;
  });
  return { header, aligns, rows };
}

function buildAlignCell(align: "left" | "center" | "right" | null): string {
  if (align === "left") return ":---";
  if (align === "center") return ":---:";
  if (align === "right") return "---:";
  return "---";
}

function buildMarkdownRow(cells: string[]): string {
  return `| ${cells.map((cell) => cell.trim() || " ").join(" | ")} |`;
}

export function buildTableSource(parsed: ParsedTable): string {
  const table = normalizedTable(parsed);
  return [
    buildMarkdownRow(table.header),
    buildMarkdownRow(table.aligns.map(buildAlignCell)),
    ...table.rows.map(buildMarkdownRow),
  ].join("\n");
}

export type WysiwygTableAction =
  | "insertRowBelow"
  | "insertColRight"
  | "deleteRow"
  | "deleteCol";

export function applyWysiwygTableAction(
  parsed: ParsedTable,
  row: number,
  col: number,
  action: WysiwygTableAction,
): ParsedTable {
  const table = normalizedTable(parsed);
  const cols = tableColumnCount(table);
  const safeCol = Math.max(0, Math.min(cols - 1, col));
  const safeRow = Math.max(0, Math.min(table.rows.length, row));
  if (action === "insertRowBelow") {
    const insertAt = safeRow <= 0 ? 0 : Math.min(table.rows.length, safeRow);
    table.rows.splice(insertAt, 0, Array(cols).fill(""));
  } else if (action === "insertColRight") {
    const insertAt = safeCol + 1;
    table.header.splice(insertAt, 0, "");
    table.aligns.splice(insertAt, 0, null);
    for (const bodyRow of table.rows) bodyRow.splice(insertAt, 0, "");
  } else if (action === "deleteRow") {
    if (safeRow > 0 && table.rows.length > 0) table.rows.splice(safeRow - 1, 1);
  } else if (action === "deleteCol") {
    if (cols > 1) {
      table.header.splice(safeCol, 1);
      table.aligns.splice(safeCol, 1);
      for (const bodyRow of table.rows) bodyRow.splice(safeCol, 1);
    }
  }
  return normalizedTable(table);
}

export function parseTableSource(src: string): ParsedTable {
  const lines = src.split(/\r?\n/).filter((l) => l.trim().startsWith("|"));
  if (lines.length < 2) return { header: [], aligns: [], rows: [] };
  const splitRow = (line: string): string[] => {
    const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
    return inner.split("|").map((s) => s.trim());
  };
  const header = splitRow(lines[0]!);
  const alignRow = splitRow(lines[1]!);
  const aligns = alignRow.map((s) => {
    const left = s.startsWith(":");
    const right = s.endsWith(":");
    if (left && right) return "center" as const;
    if (left) return "left" as const;
    if (right) return "right" as const;
    return null;
  });
  const rows = lines.slice(2).map(splitRow);
  return normalizedTable({ header, aligns, rows });
}

function createTableCellEditor(value: string, row: number, col: number, label: string) {
  const editor = document.createElement("textarea");
  editor.className = "cm-md-table-cell";
  editor.spellcheck = false;
  editor.rows = 1;
  editor.value = value;
  editor.dataset.row = String(row);
  editor.dataset.col = String(col);
  editor.setAttribute("aria-label", label);
  return editor;
}

export function buildTableDom(parsed: ParsedTable): HTMLElement {
  const table = normalizedTable(parsed);
  const root = document.createElement("div");
  root.className = "cm-md-table-widget";
  root.setAttribute("contenteditable", "false");
  root.dataset.activeRow = "1";
  root.dataset.activeCol = "0";
  root.dataset.rowCount = String(table.rows.length);
  root.dataset.colCount = String(table.header.length);

  const tbl = document.createElement("table");

  const thead = document.createElement("thead");
  const trh = document.createElement("tr");
  table.header.forEach((cell, col) => {
    const th = document.createElement("th");
    const editor = createTableCellEditor(cell, 0, col, `表头 ${col + 1}`);
    th.dataset.row = "0";
    th.dataset.col = String(col);
    const align = table.aligns[col];
    if (align) th.style.textAlign = align;
    th.appendChild(editor);
    trh.appendChild(th);
  });
  thead.appendChild(trh);
  tbl.appendChild(thead);

  const tbody = document.createElement("tbody");
  table.rows.forEach((row, rowIdx) => {
    const tr = document.createElement("tr");
    row.forEach((cell, col) => {
      const td = document.createElement("td");
      const editor = createTableCellEditor(cell, rowIdx + 1, col, `第 ${rowIdx + 1} 行第 ${col + 1} 列`);
      td.dataset.row = String(rowIdx + 1);
      td.dataset.col = String(col);
      const align = table.aligns[col];
      if (align) td.style.textAlign = align;
      td.appendChild(editor);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  tbl.appendChild(tbody);

  root.appendChild(tbl);

  const addCol = document.createElement("button");
  addCol.type = "button";
  addCol.className = "cm-md-table-edge-action cm-md-table-add-col";
  addCol.dataset.action = "insertColRight";
  addCol.dataset.edge = "col-end";
  addCol.textContent = "+";
  addCol.title = "在末尾新增列";
  addCol.setAttribute("aria-label", "在末尾新增列");
  root.appendChild(addCol);

  const addRow = document.createElement("button");
  addRow.type = "button";
  addRow.className = "cm-md-table-edge-action cm-md-table-add-row";
  addRow.dataset.action = "insertRowBelow";
  addRow.dataset.edge = "row-end";
  addRow.textContent = "+";
  addRow.title = "在末尾新增行";
  addRow.setAttribute("aria-label", "在末尾新增行");
  root.appendChild(addRow);

  const menu = document.createElement("div");
  menu.className = "cm-md-table-menu";
  menu.hidden = true;
  root.appendChild(menu);
  return root;
}

class TableWidget extends WidgetType {
  constructor(private readonly source: string) {
    super();
  }
  eq(other: WidgetType): boolean {
    return other instanceof TableWidget && other.source === this.source;
  }
  toDOM(view: EditorView): HTMLElement {
    const dom = buildTableDom(parseTableSource(this.source));
    dom.dataset.sourceLength = String(this.source.length);
    installTableDomHandlers(view, dom);
    return dom;
  }
  ignoreEvent() {
    return true;
  }
}

class ListMarkerWidget extends WidgetType {
  constructor(
    private readonly label: string,
    private readonly ordered: boolean,
  ) {
    super();
  }
  eq(other: WidgetType): boolean {
    return (
      other instanceof ListMarkerWidget &&
      other.label === this.label &&
      other.ordered === this.ordered
    );
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = `cm-md-list-marker${this.ordered ? " ordered" : ""}`;
    span.textContent = this.label;
    return span;
  }
}

function tableRangeFromHost(
  view: EditorView,
  host: HTMLElement,
): { from: number; to: number; source: string } | null {
  const from = view.posAtDOM(host);
  const len = Number(host.dataset.sourceLength);
  if (from == null || !Number.isFinite(len) || len <= 0) return null;
  const to = Math.min(view.state.doc.length, from + len);
  if (to <= from) return null;
  return { from, to, source: view.state.doc.sliceString(from, to) };
}

function activeTableCell(host: HTMLElement): HTMLElement | null {
  const row = host.dataset.activeRow ?? "1";
  const col = host.dataset.activeCol ?? "0";
  const cells = Array.from(host.querySelectorAll<HTMLElement>(".cm-md-table-cell"));
  return (
    cells.find((cell) => cell.dataset.row === row && cell.dataset.col === col) ??
    cells[0] ??
    null
  );
}

function setActiveTableCell(host: HTMLElement, cell: HTMLElement) {
  host.dataset.activeRow = cell.dataset.row ?? "1";
  host.dataset.activeCol = cell.dataset.col ?? "0";
}

function tableCellText(cell: HTMLElement): string {
  if (cell instanceof HTMLTextAreaElement) return cell.value.replace(/\r?\n/g, " ").trim();
  return (cell.textContent ?? "").replace(/\r?\n/g, " ").trim();
}

function updateParsedTableCell(
  parsed: ParsedTable,
  row: number,
  col: number,
  value: string,
): ParsedTable {
  const table = normalizedTable(parsed);
  const cols = tableColumnCount(table);
  const safeCol = Math.max(0, Math.min(cols - 1, col));
  if (row <= 0) {
    table.header[safeCol] = value;
    return normalizedTable(table);
  }
  while (table.rows.length < row) table.rows.push(Array(cols).fill(""));
  table.rows[row - 1]![safeCol] = value;
  return normalizedTable(table);
}

function commitTableCellEdit(view: EditorView, cell: HTMLElement): boolean {
  const host = cell.closest<HTMLElement>(".cm-md-table-widget");
  if (!host) return false;
  const range = tableRangeFromHost(view, host);
  if (!range) return false;
  const row = Number(cell.dataset.row);
  const col = Number(cell.dataset.col);
  if (!Number.isFinite(row) || !Number.isFinite(col)) return false;
  const parsed = parseTableSource(range.source);
  const next = buildTableSource(updateParsedTableCell(parsed, row, col, tableCellText(cell)));
  if (next === range.source) return false;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: next },
    userEvent: "input",
  });
  return true;
}

function selectElementContents(el: HTMLElement) {
  const range = el.ownerDocument.createRange();
  range.selectNodeContents(el);
  const selection = el.ownerDocument.getSelection?.() ?? window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

type CaretDocument = Document & {
  caretPositionFromPoint?: (
    x: number,
    y: number,
  ) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

function focusTableCell(cell: HTMLElement, event?: MouseEvent) {
  if (cell instanceof HTMLTextAreaElement) {
    cell.focus({ preventScroll: true });
    void event;
    return;
  }
  const doc = cell.ownerDocument as CaretDocument;
  cell.focus({ preventScroll: true });
  const selection = doc.getSelection?.() ?? window.getSelection();
  if (!selection) return;

  let range: Range | null = null;
  if (event) {
    const caret = doc.caretPositionFromPoint?.(event.clientX, event.clientY);
    if (caret && cell.contains(caret.offsetNode)) {
      range = doc.createRange();
      range.setStart(caret.offsetNode, caret.offset);
      range.collapse(true);
    } else {
      const fallbackRange = doc.caretRangeFromPoint?.(event.clientX, event.clientY);
      if (fallbackRange && cell.contains(fallbackRange.startContainer)) {
        range = fallbackRange;
      }
    }
  }

  if (!range) {
    range = doc.createRange();
    range.selectNodeContents(cell);
    range.collapse(false);
  }

  selection.removeAllRanges();
  selection.addRange(range);
}

function hasSelectionInsideTableCell(cell: HTMLElement): boolean {
  if (cell instanceof HTMLTextAreaElement) {
    return cell.selectionStart !== cell.selectionEnd;
  }
  const selection = cell.ownerDocument.getSelection?.() ?? window.getSelection();
  if (!selection || selection.isCollapsed) return false;
  const { anchorNode, focusNode } = selection;
  return !!anchorNode && !!focusNode && cell.contains(anchorNode) && cell.contains(focusNode);
}

function resizeTableCellEditor(cell: HTMLElement) {
  if (!(cell instanceof HTMLTextAreaElement)) return;
  cell.style.height = "auto";
  cell.style.height = `${Math.max(24, cell.scrollHeight)}px`;
}

function eventElementTarget(event: Event): HTMLElement | null {
  const target = event.target;
  if (target instanceof HTMLElement) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
}

function focusAdjacentTableCell(cell: HTMLElement, direction: -1 | 1) {
  const host = cell.closest<HTMLElement>(".cm-md-table-widget");
  if (!host) return;
  const cells = Array.from(host.querySelectorAll<HTMLElement>(".cm-md-table-cell"));
  const current = cells.indexOf(cell);
  const next = cells[current + direction];
  if (!next) return;
  host.dataset.activeRow = next.dataset.row ?? "1";
  host.dataset.activeCol = next.dataset.col ?? "0";
  focusTableCell(next);
  selectElementContents(next);
}

function applyTableWidgetAction(
  view: EditorView,
  host: HTMLElement,
  row: number,
  col: number,
  action: WysiwygTableAction,
  pendingCell?: HTMLElement | null,
): boolean {
  const range = tableRangeFromHost(view, host);
  if (!range) return false;
  let parsed = parseTableSource(range.source);
  if (pendingCell) {
    const pendingRow = Number(pendingCell.dataset.row);
    const pendingCol = Number(pendingCell.dataset.col);
    if (Number.isFinite(pendingRow) && Number.isFinite(pendingCol)) {
      parsed = updateParsedTableCell(parsed, pendingRow, pendingCol, tableCellText(pendingCell));
    }
  }
  const next = buildTableSource(applyWysiwygTableAction(parsed, row, col, action));
  if (next === range.source) return false;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: next },
    userEvent: "input",
  });
  return true;
}

function hideTableMenu(host: HTMLElement) {
  const menu = host.querySelector<HTMLElement>(".cm-md-table-menu");
  if (menu) menu.hidden = true;
}

function tableActionCoordsFromButton(host: HTMLElement, button: HTMLElement) {
  const active = activeTableCell(host);
  let row = Number(host.dataset.activeRow ?? active?.dataset.row ?? 1);
  let col = Number(host.dataset.activeCol ?? active?.dataset.col ?? 0);
  if (button.dataset.row != null) row = Number(button.dataset.row);
  if (button.dataset.col != null) col = Number(button.dataset.col);
  if (button.dataset.edge === "col-end") {
    col = Math.max(0, Number(host.dataset.colCount ?? 1) - 1);
  }
  if (button.dataset.edge === "row-end") {
    row = Math.max(0, Number(host.dataset.rowCount ?? 0));
  }
  const menu = button.closest<HTMLElement>(".cm-md-table-menu");
  if (menu) {
    row = Number(menu.dataset.row ?? row);
    col = Number(menu.dataset.col ?? col);
  }
  return { row, col, active };
}

function runTableButtonAction(view: EditorView, host: HTMLElement, button: HTMLElement): boolean {
  const action = button.dataset.action as WysiwygTableAction | undefined;
  if (!action) return false;
  const { row, col, active } = tableActionCoordsFromButton(host, button);
  const ok = applyTableWidgetAction(view, host, row, col, action, active);
  hideTableMenu(host);
  return ok;
}

function appendTableMenuButton(
  menu: HTMLElement,
  action: WysiwygTableAction,
  label: string,
  row: number,
  col: number,
) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cm-md-table-menu-item";
  button.dataset.action = action;
  button.dataset.row = String(row);
  button.dataset.col = String(col);
  button.textContent = label;
  menu.appendChild(button);
}

function showTableMenu(host: HTMLElement, cell: HTMLElement, event: MouseEvent) {
  const menu = host.querySelector<HTMLElement>(".cm-md-table-menu");
  if (!menu) return;
  const row = Number(cell.dataset.row);
  const col = Number(cell.dataset.col);
  if (!Number.isFinite(row) || !Number.isFinite(col)) return;
  menu.replaceChildren();
  menu.dataset.row = String(row);
  menu.dataset.col = String(col);
  if (row <= 0) {
    appendTableMenuButton(menu, "insertColRight", "右侧插入列", row, col);
    appendTableMenuButton(menu, "deleteCol", "删除列", row, col);
  } else {
    appendTableMenuButton(menu, "insertRowBelow", "下方插入行", row, col);
    appendTableMenuButton(menu, "deleteRow", "删除行", row, col);
    appendTableMenuButton(menu, "insertColRight", "右侧插入列", row, col);
    appendTableMenuButton(menu, "deleteCol", "删除列", row, col);
  }
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;
  menu.hidden = false;
}

function installTableDomHandlers(view: EditorView, host: HTMLElement) {
  let pointerDown:
    | {
        cell: HTMLElement;
        x: number;
        y: number;
      }
    | null = null;
  let suppressNextCellClick = false;

  host.addEventListener("focusin", (event) => {
    const target = eventElementTarget(event);
    const cell = target?.closest<HTMLElement>(".cm-md-table-cell");
    if (!cell || !host.contains(cell)) return;
    setActiveTableCell(host, cell);
    resizeTableCellEditor(cell);
    event.stopPropagation();
  });

  host.addEventListener("focusout", (event) => {
    const target = eventElementTarget(event);
    const cell = target?.closest<HTMLElement>(".cm-md-table-cell");
    if (!cell || !host.contains(cell)) return;
    commitTableCellEdit(view, cell);
    event.stopPropagation();
  });

  host.addEventListener("keydown", (event) => {
    const target = eventElementTarget(event);
    const cell = target?.closest<HTMLElement>(".cm-md-table-cell");
    if (!cell || !host.contains(cell)) return;
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      commitTableCellEdit(view, cell);
      cell.blur();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      commitTableCellEdit(view, cell);
      focusAdjacentTableCell(cell, event.shiftKey ? -1 : 1);
    }
  });

  host.addEventListener("mousedown", (event) => {
    const target = eventElementTarget(event);
    const tool = target?.closest<HTMLButtonElement>(
      ".cm-md-table-edge-action[data-action], .cm-md-table-menu-item[data-action]",
    );
    if (tool && host.contains(tool)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const cell = target?.closest<HTMLElement>(".cm-md-table-cell");
    if (cell && host.contains(cell)) {
      setActiveTableCell(host, cell);
      hideTableMenu(host);
      pointerDown = { cell, x: event.clientX, y: event.clientY };
      event.stopPropagation();
    }
  });

  host.addEventListener("mouseup", (event) => {
    const target = eventElementTarget(event);
    const cell = target?.closest<HTMLElement>(".cm-md-table-cell");
    if (!cell || !host.contains(cell)) return;
    const moved =
      !pointerDown ||
      pointerDown.cell !== cell ||
      Math.abs(pointerDown.x - event.clientX) > 4 ||
      Math.abs(pointerDown.y - event.clientY) > 4;
    suppressNextCellClick = moved || hasSelectionInsideTableCell(cell);
    if (!suppressNextCellClick) {
      focusTableCell(cell, event);
    }
    pointerDown = null;
    event.stopPropagation();
  });

  host.addEventListener("click", (event) => {
    const target = eventElementTarget(event);
    const cell = target?.closest<HTMLElement>(".cm-md-table-cell");
    if (!cell || !host.contains(cell)) return;
    setActiveTableCell(host, cell);
    if (suppressNextCellClick) {
      suppressNextCellClick = false;
    } else if (cell.ownerDocument.activeElement !== cell) {
      focusTableCell(cell, event);
    }
    event.stopPropagation();
  });

  host.addEventListener("click", (event) => {
    const target = eventElementTarget(event);
    const tool = target?.closest<HTMLButtonElement>(
      ".cm-md-table-edge-action[data-action], .cm-md-table-menu-item[data-action]",
    );
    if (!tool || !host.contains(tool)) return;
    runTableButtonAction(view, host, tool);
    event.preventDefault();
    event.stopPropagation();
  });

  host.addEventListener("contextmenu", (event) => {
    const target = eventElementTarget(event);
    const cell = target?.closest<HTMLElement>(".cm-md-table-cell");
    if (!cell || !host.contains(cell)) return;
    setActiveTableCell(host, cell);
    showTableMenu(host, cell, event);
    event.preventDefault();
    event.stopPropagation();
  });

  host.addEventListener("input", (event) => {
    const target = eventElementTarget(event);
    const cell = target?.closest<HTMLElement>(".cm-md-table-cell");
    if (!cell || !host.contains(cell)) return;
    resizeTableCellEditor(cell);
    event.stopPropagation();
  });
}

// ─── Image widget ─────────────────────────────────────────────────────────

/** Allow only safe URL schemes; relative paths fall back to source. */
function isAbsoluteSafeUrl(url: string): boolean {
  return /^(https?:|data:image\/|file:|asset:|tauri:|markio-asset:|markio-resource:)/i.test(
    url,
  );
}

export { parseImageMarkdown };

// ─── Callout label widget ─────────────────────────────────────────────────

// Same canonical names as src/lib/callouts.ts so the in-editor preview matches
// the rendered preview (aliases like `caution` → `warning`).
const CALLOUT_ALIASES: Record<string, string> = {
  hint: "tip",
  important: "important",
  caution: "warning",
  attention: "warning",
  error: "danger",
  check: "success",
  done: "success",
  help: "question",
  faq: "question",
  abstract: "note",
  summary: "note",
  tldr: "note",
};

function normalizeCalloutType(raw: string): string {
  const lower = raw.toLowerCase();
  return CALLOUT_ALIASES[lower] ?? lower;
}

class CalloutLabelWidget extends WidgetType {
  constructor(private readonly type: string) {
    super();
  }
  eq(other: WidgetType): boolean {
    return other instanceof CalloutLabelWidget && other.type === this.type;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = `cm-md-callout-label cm-md-callout-label-${this.type}`;
    span.textContent = this.type.toUpperCase();
    return span;
  }
}

// ─── Wikilink widget ──────────────────────────────────────────────────────

const WIKI_LINK_RE = /\[\[([^\]\n]{1,200})\]\]/g;

interface WikilinkInfo {
  from: number;
  to: number;
  display: string;
  target: string;
  heading?: string;
  /** Resolved file path if the target was found in the vault, else undefined. */
  path?: string;
}

function detectWikilinks(state: EditorState): WikilinkInfo[] {
  const text = state.doc.toString();
  const ws = useWorkspace.getState();
  const activeWs = ws.workspaces.find((w) => w.id === ws.activeId);
  const files = activeWs
    ? useVaultIndex.getState().index[activeWs.path]?.files
    : undefined;
  const out: WikilinkInfo[] = [];
  WIKI_LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKI_LINK_RE.exec(text))) {
    const parts = parseWikiLinkBody(m[1]!);
    if (!parts) continue;
    const resolved = resolveWikiFile(files, parts.target);
    out.push({
      from: m.index,
      to: m.index + m[0].length,
      display: parts.display,
      target: parts.target,
      heading: parts.heading,
      path: resolved?.path,
    });
  }
  return out;
}

class WikilinkWidget extends WidgetType {
  constructor(private readonly info: WikilinkInfo) {
    super();
  }
  eq(other: WidgetType): boolean {
    return (
      other instanceof WikilinkWidget &&
      other.info.target === this.info.target &&
      other.info.display === this.info.display &&
      other.info.heading === this.info.heading &&
      other.info.path === this.info.path
    );
  }
  toDOM(): HTMLElement {
    const a = document.createElement("a");
    a.className = "cm-md-wikilink";
    a.href = "#";
    a.textContent = this.info.display;
    if (this.info.path) {
      a.dataset.path = this.info.path;
      a.title = `打开 ${this.info.target}${this.info.heading ? "#" + this.info.heading : ""}`;
    } else {
      a.classList.add("missing");
      a.title = `未找到笔记：${this.info.target}`;
    }
    if (this.info.heading) a.dataset.heading = this.info.heading;
    return a;
  }
  ignoreEvent() {
    return false;
  }
}

class ImageWidget extends WidgetType {
  constructor(
    private readonly parts: ImageParts,
    private readonly inlinePreview: boolean = false,
    private readonly sourceLength: number = 0,
  ) {
    super();
  }
  eq(other: WidgetType): boolean {
    return (
      other instanceof ImageWidget &&
      other.parts.alt === this.parts.alt &&
      other.parts.url === this.parts.url &&
      other.parts.title === this.parts.title &&
      other.inlinePreview === this.inlinePreview &&
      other.sourceLength === this.sourceLength
    );
  }
  toDOM(): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "cm-md-img-widget";
    if (this.inlinePreview) wrap.classList.add("cm-md-img-inline-preview");
    wrap.dataset.src = this.parts.url;
    wrap.dataset.alt = this.parts.alt;
    if (this.parts.title) wrap.dataset.title = this.parts.title;
    if (this.sourceLength > 0) wrap.dataset.sourceLength = String(this.sourceLength);
    const img = document.createElement("img");
    img.src = this.parts.url;
    img.alt = this.parts.alt;
    if (this.parts.title) img.title = this.parts.title;
    applyImageElementSizing(img, this.parts.title);
    img.loading = "lazy";
    img.draggable = false;
    img.addEventListener("error", () => {
      wrap.classList.add("cm-md-img-error");
      wrap.title = `图片加载失败：${this.parts.url}`;
    });
    wrap.appendChild(img);
    return wrap;
  }
  ignoreEvent() {
    return false;
  }
}

class TaskCheckbox extends WidgetType {
  constructor(private readonly checked: boolean) {
    super();
  }
  eq(other: WidgetType): boolean {
    return other instanceof TaskCheckbox && other.checked === this.checked;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-md-task " + (this.checked ? "checked" : "");
    el.setAttribute("role", "checkbox");
    el.setAttribute("aria-checked", String(this.checked));
    el.setAttribute("aria-label", this.checked ? "标记为未完成" : "标记为完成");
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

class HrWidget extends WidgetType {
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-md-hr-line";
    return el;
  }
  eq() {
    return true;
  }
}

class TableSepWidget extends WidgetType {
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-md-table-sep";
    return el;
  }
  eq() {
    return true;
  }
}

interface PendingDeco {
  from: number;
  to: number;
  deco: Decoration;
}

interface BuildResult {
  decorations: DecorationSet;
  /** 隐藏掉的 marker 字符范围，给 EditorView.atomicRanges 用 ——
   *  防止鼠标拖动选区时光标"落进"被隐藏的字符里、导致选区视觉上溢出到下方行 */
  atomic: DecorationSet;
  /** 受光标位置影响是否展示 widget 的所有判定范围。selection-only 的 tr 触发
   *  rebuild 时，先按这些范围在新旧选区下的命中变化判断；任何一个翻转才 rebuild，
   *  否则直接复用上次结果，避免大文档每次方向键 / 鼠标选中都跑全文 syntaxTree。 */
  sensitive: SensitiveRange[];
}

interface SensitiveRange {
  from: number;
  to: number;
  inclusive: boolean;
}

/** rangeHasCursor 的内核：把判断从 EditorState 解耦到 EditorSelection，
 *  让 fast-path 在 update() 里跨 prev / current selection 重放。 */
function selectionHitsRange(
  selection: { ranges: ReadonlyArray<{ head: number; from: number; to: number }> },
  range: SensitiveRange,
): boolean {
  for (const sel of selection.ranges) {
    const head = sel.head;
    const headInside = range.inclusive
      ? head >= range.from && head <= range.to
      : head >= range.from && head < range.to;
    if (headInside) return true;
    if (sel.from < range.to && sel.to > range.from) return true;
  }
  return false;
}

/** 任何 sensitive range 的命中在两个选区下结果不同 → 必须重新 build。 */
function anySensitiveRangeFlipped(
  ranges: SensitiveRange[],
  prevSel: { ranges: ReadonlyArray<{ head: number; from: number; to: number }> },
  newSel: { ranges: ReadonlyArray<{ head: number; from: number; to: number }> },
): boolean {
  for (const r of ranges) {
    if (selectionHitsRange(prevSel, r) !== selectionHitsRange(newSel, r)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether any selection (caret or range) overlaps `range`.
 *
 * `inclusive` controls boundary handling:
 *   true  — caret at `range.to` counts as "inside" (inline math: lets user
 *           place the caret right after `$` to edit the closing delimiter).
 *   false — caret at `range.to` is OUTSIDE (block widgets like fenced code
 *           or tables: pressing ArrowDown out of the block should re-render
 *           immediately, not stick on the boundary).
 */
// Keep cursorInsideRange import alive; used by other math helpers.
void cursorInsideRange;

function build(state: EditorState): BuildResult {
  const decos: PendingDeco[] = [];
  const atomic: PendingDeco[] = [];
  /** 把每个"是否生成 widget 由光标位置决定"的范围都登记进来，让 update()
   *  的 selection-only fast path 能判断"翻转"。 */
  const sensitive: SensitiveRange[] = [];
  const trackCursor = (
    from: number,
    to: number,
    inclusive: boolean = true,
  ): boolean => {
    sensitive.push({ from, to, inclusive });
    return selectionHitsRange(state.selection, { from, to, inclusive });
  };

  // Math regions: detect once over the full doc (regex-only, no AST since
  // lezer-markdown has no math node by default). Skip the widget when the
  // cursor is inside so the user can edit the source plainly.
  const mathRanges = detectMathRanges(state.doc.toString());
  for (const range of mathRanges) {
    if (trackCursor(range.from, range.to, true)) continue;
    decos.push({
      from: range.from,
      to: range.to,
      deco: Decoration.replace({
        widget: new MathWidget(range.source, range.display),
        block: range.display,
      }),
    });
    atomic.push({
      from: range.from,
      to: range.to,
      deco: Decoration.mark({}),
    });
  }

  // Wikilinks: same regex-based scan; rendered widget shows display text and
  // remembers the resolved vault path so clicks can open the target note.
  const wikilinkRanges = detectWikilinks(state);
  for (const info of wikilinkRanges) {
    if (trackCursor(info.from, info.to, true)) continue;
    decos.push({
      from: info.from,
      to: info.to,
      deco: Decoration.replace({ widget: new WikilinkWidget(info) }),
    });
    atomic.push({
      from: info.from,
      to: info.to,
      deco: Decoration.mark({}),
    });
  }

  /** 用 replace 把 [from,to) 之间的字符隐藏起来。
   *
   *  注意：之前实现"光标在本行时还原 marker"会导致行长度变化，drawSelection
   *  把 cursor 画到新的视觉位置上，看起来"鼠标点击位置和实际位置不符"——
   *  Typora / iA Writer 等成熟 WYSIWYG 都是稳定布局：marker 始终隐藏，靠
   *  快捷键 / 工具栏改样式。所以这里去掉 cursorOnSameLine 兜底，保证视觉稳定。
   *
   *  同时把范围登记进 atomic，CM 选区移动时整段跳过被隐藏的 marker。 */
  const hide = (from: number, to: number) => {
    if (from >= to) return;
    decos.push({ from, to, deco: Decoration.replace({}) });
    atomic.push({ from, to, deco: Decoration.mark({}) });
  };

  /** 给一个范围加 mark 装饰（行内文字样式） */
  const mark = (from: number, to: number, cls: string) => {
    if (from >= to) return;
    decos.push({ from, to, deco: Decoration.mark({ class: cls }) });
  };

  let visibleFrom = 0;
  let visibleTo = state.doc.length;

  /** 给一行加 class（标题 / 引用整行） */
  const lineMark = (pos: number, cls: string) => {
    if (pos < visibleFrom || pos > visibleTo) return;
    const line = state.doc.lineAt(pos);
    decos.push({
      from: line.from,
      to: line.from,
      deco: Decoration.line({ class: cls }),
    });
  };

  const markLines = (from: number, to: number, cls: string) => {
    const fromPos = Math.max(from, visibleFrom);
    const toPos = Math.min(to, visibleTo);
    if (fromPos > toPos) return;
    const startLine = state.doc.lineAt(fromPos).number;
    const endLine = state.doc.lineAt(toPos).number;
    for (let ln = startLine; ln <= endLine; ln++) {
      const line = state.doc.line(ln);
      decos.push({
        from: line.from,
        to: line.from,
        deco: Decoration.line({ class: cls }),
      });
    }
  };

  // 块级 decoration 必须从 StateField 提供 → 没有 view.visibleRanges，
  // 直接遍历整个 doc。lezer 解析是增量的，全树 iterate 对几千行也只是几 ms。
  const tree = syntaxTree(state);
  const ranges = [{ from: 0, to: state.doc.length }];
  for (const range of ranges) {
    visibleFrom = range.from;
    visibleTo = range.to;
    tree.iterate({
      from: visibleFrom,
      to: visibleTo,
      enter: (node) => {
      const n = node.name;

      // ─── 标题 ATX ───
      if (/^ATXHeading[1-6]$/.test(n)) {
        const lvl = Number(n.slice(-1));
        lineMark(node.from, `cm-md-line cm-md-h${lvl}`);
        return;
      }
      if (n === "SetextHeading1") {
        lineMark(node.from, "cm-md-line cm-md-h1");
        return;
      }
      if (n === "SetextHeading2") {
        lineMark(node.from, "cm-md-line cm-md-h2");
        return;
      }

      // ─── 引用 / Callout ───
      if (n === "Blockquote") {
        const firstLine = state.doc.lineAt(node.from);
        // `> [!type][+|-]?` marker on the first line of the quote → callout
        const marker = firstLine.text.match(
          /^(\s*>\s*)\[!([a-zA-Z][\w-]*)\]([+-])?/,
        );
        if (marker) {
          const rawType = marker[2]!;
          const type = normalizeCalloutType(rawType);
          const tokenStart = firstLine.from + marker[1]!.length;
          const tokenEnd = firstLine.from + marker[0].length;
          // 把 [!type] 这段隐藏起来，前面塞一个样式化的标签 widget
          if (!trackCursor(tokenStart, tokenEnd, true)) {
            decos.push({
              from: tokenStart,
              to: tokenEnd,
              deco: Decoration.replace({ widget: new CalloutLabelWidget(type) }),
            });
            atomic.push({
              from: tokenStart,
              to: tokenEnd,
              deco: Decoration.mark({}),
            });
          }
          markLines(
            node.from,
            node.to,
            `cm-md-line cm-md-quote-line cm-md-callout cm-md-callout-${type}`,
          );
          return;
        }
        markLines(node.from, node.to, "cm-md-line cm-md-quote-line");
        return;
      }

      // ─── 列表 ───
      if (n === "ListItem") {
        // 用父节点判断有序 / 无序，加不同 line class（CSS 给 .cm-md-list-ol 加序号样式）
        const parent = node.node.parent?.name;
        const isOrdered = parent === "OrderedList";
        lineMark(
          node.from,
          isOrdered ? "cm-md-line cm-md-list cm-md-list-ol" : "cm-md-line cm-md-list",
        );
        return;
      }
      // 列表标记（- / * / 1. ）光标不在本行时隐藏；本行时保留以便编辑
      if (n === "ListMark") {
        const line = state.doc.lineAt(node.from);
        const after = state.doc.sliceString(node.to, node.to + 1);
        const to = after === " " ? node.to + 1 : node.to;
        const rest = state.doc.sliceString(to, line.to);
        const isTask = /^\s*\[[ xX]\]/i.test(rest);
        if (isTask) {
          hide(node.from, to);
          return;
        }
        const marker = state.doc.sliceString(node.from, node.to).trim();
        const ordered = /^\d+\./.test(marker);
        decos.push({
          from: node.from,
          to,
          deco: Decoration.replace({
            widget: new ListMarkerWidget(ordered ? marker : "•", ordered),
          }),
        });
        atomic.push({ from: node.from, to, deco: Decoration.mark({}) });
        return;
      }

      // ─── 表格 ───
      if (n === "Table") {
        const source = state.doc.sliceString(node.from, node.to);
        decos.push({
          from: node.from,
          to: node.to,
          deco: Decoration.replace({
            widget: new TableWidget(source),
            block: true,
          }),
        });
        atomic.push({
          from: node.from,
          to: node.to,
          deco: Decoration.mark({}),
        });
        return false;
      }
      // TableDelimiter 在 lezer-markdown 里有两种用法：
      //   * 单字符 `|`（每行内的 cell 分隔符）—— 此时 to-from === 1，保留显示
      //   * 整行 `|---|---|` 的对齐分隔行 —— 此时长度 > 1，替换成一条细线
      if (n === "TableDelimiter") {
        if (node.to - node.from > 1) {
          decos.push({
            from: node.from,
            to: node.to,
            deco: Decoration.replace({ widget: new TableSepWidget() }),
          });
          atomic.push({ from: node.from, to: node.to, deco: Decoration.mark({}) });
        }
        return;
      }

      // ─── 水平线 ───
      if (n === "HorizontalRule") {
        const line = state.doc.lineAt(node.from);
        decos.push({
          from: line.from,
          to: line.from,
          deco: Decoration.line({ class: "cm-md-line cm-md-hr" }),
        });
        // 始终把 --- 替换为视觉横线（稳定布局，不依赖 cursor）
        decos.push({
          from: node.from,
          to: node.to,
          deco: Decoration.replace({ widget: new HrWidget() }),
        });
        atomic.push({ from: node.from, to: node.to, deco: Decoration.mark({}) });
        return;
      }

      // ─── Marker 隐藏 ───
      if (n === "HeaderMark") {
        // 包括 # 后面那个空格也吃掉
        const after = state.doc.sliceString(node.to, node.to + 1);
        const to = after === " " ? node.to + 1 : node.to;
        hide(node.from, to);
        return;
      }
      if (n === "QuoteMark") {
        const after = state.doc.sliceString(node.to, node.to + 1);
        const to = after === " " ? node.to + 1 : node.to;
        hide(node.from, to);
        return;
      }
      if (n === "EmphasisMark" || n === "StrikethroughMark" || n === "CodeMark") {
        hide(node.from, node.to);
        return;
      }
      if (n === "LinkMark") {
        // [ ] ( ) 这些
        hide(node.from, node.to);
        return;
      }
      if (n === "URL") {
        // 链接 URL 部分隐藏，留 label 显形
        hide(node.from, node.to);
        return;
      }

      // ─── 行内样式包裹 ───
      if (n === "StrongEmphasis") {
        mark(node.from, node.to, "cm-md-bold");
        return;
      }
      if (n === "Emphasis") {
        mark(node.from, node.to, "cm-md-italic");
        return;
      }
      if (n === "Strikethrough") {
        mark(node.from, node.to, "cm-md-strike");
        return;
      }
      if (n === "InlineCode") {
        mark(node.from, node.to, "cm-md-code");
        return;
      }
      if (n === "Link") {
        mark(node.from, node.to, "cm-md-link");
        return;
      }
      if (n === "Image") {
        const text = state.doc.sliceString(node.from, node.to);
        const parts = parseImageMarkdown(text);
        const canRender = !!parts && isAbsoluteSafeUrl(parts.url);
        if (trackCursor(node.from, node.to, true)) {
          mark(node.from, node.to, "cm-md-image cm-md-image-active");
          if (canRender) {
            decos.push({
              from: node.to,
              to: node.to,
              deco: Decoration.widget({
                widget: new ImageWidget(parts, true),
                side: 1,
              }),
            });
          }
          return false;
        }
        // 默认渲染图片；未聚焦时隐藏 markdown 源码。
        if (canRender) {
            decos.push({
              from: node.from,
              to: node.to,
              deco: Decoration.replace({
                widget: new ImageWidget(parts, false, node.to - node.from),
              }),
            });
            atomic.push({
              from: node.from,
              to: node.to,
              deco: Decoration.mark({}),
            });
            return;
        }
        mark(node.from, node.to, "cm-md-image");
        return false;
      }

      // ─── 任务列表 ───
      if (n === "TaskMarker") {
        const text = state.doc.sliceString(node.from, node.to);
        const checked = /x/i.test(text);
        // 始终用 □ / ☑ 替代 [ ] / [x]，点击 widget 切换；保持布局稳定
        decos.push({
          from: node.from,
          to: node.to,
          deco: Decoration.replace({
            widget: new TaskCheckbox(checked),
          }),
        });
        atomic.push({ from: node.from, to: node.to, deco: Decoration.mark({}) });
        // 标记整行
        lineMark(node.from, `cm-md-line cm-md-task-line${checked ? " done" : ""}`);
        return;
      }

      // ─── 代码块 ───
      if (n === "FencedCode") {
        const lang = extractFenceLang(state, node.from);
        const cursorInBlock = trackCursor(node.from, node.to, false);
        if (!cursorInBlock) {
          const source = extractFencedBody(state, node.from, node.to);
          const visualKind = detectVisualLang(lang);
          if (!visualKind || source.trim().length > 0) {
            const widget =
              WYSIWYG_VISUAL_FENCES_ENABLED && visualKind && source.trim().length > 0
                ? new VisualFenceWidget(visualKind, source)
                : new CodeFenceWidget(lang, source, node.to - node.from);
            decos.push({
              from: node.from,
              to: node.to,
              deco: Decoration.replace({ widget, block: true }),
            });
            atomic.push({
              from: node.from,
              to: node.to,
              deco: Decoration.mark({}),
            });
            return;
          }
        }
        markLines(node.from, node.to, "cm-md-line cm-md-codeblock");
        return;
      }
      if (n === "CodeBlock") {
        markLines(node.from, node.to, "cm-md-line cm-md-codeblock");
        return;
      }
    },
    });
  }

  decos.sort((a, b) => a.from - b.from || a.to - b.to);
  atomic.sort((a, b) => a.from - b.from || a.to - b.to);
  return {
    decorations: Decoration.set(
      decos.map((d) => d.deco.range(d.from, d.to)),
      true,
    ),
    atomic: Decoration.set(
      atomic.map((d) => d.deco.range(d.from, d.to)),
      true,
    ),
    sensitive,
  };
}

// CodeMirror 禁止 ViewPlugin 提供 block 类型的 Decoration.replace（block: true）。
// math display / 表格 / mermaid 等都是 block widget —— 必须从 StateField 拿。
// 这里把整个 wysiwyg deco 集合放进 StateField：
//   - docChanged / selection 变化时 build()
//   - decorations 通过 EditorView.decorations.from 提供
//   - atomicRanges 通过 EditorView.atomicRanges.of 提供
//   - mousedown 行为独立放进 EditorView.domEventHandlers，不依赖 plugin 上下文
const wysiwygField = StateField.define<BuildResult>({
  create(state) {
    return build(state);
  },
  update(prev, tr) {
    // 文档变了 → 必须完整重算（widget 位置 / 内容都可能动）
    if (tr.docChanged) {
      return build(tr.state);
    }
    // 选区变了 → 只在某个"现形/隐藏"边界被跨过时才 rebuild；
    // 否则方向键 / 鼠标拖选 / 简单点击不再触发整文档 syntaxTree iterate。
    if (tr.selection) {
      if (
        anySensitiveRangeFlipped(
          prev.sensitive,
          tr.startState.selection,
          tr.state.selection,
        )
      ) {
        return build(tr.state);
      }
    }
    return prev;
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(f).atomic),
  ],
});

const wysiwygMousedown = EditorView.domEventHandlers({
  mousedown(e, view) {
    const target = eventElementTarget(e);
    if (!target) return;
    // 点击数学公式 widget → 把光标移到公式源码起点，下一次 build 自动还原源码
    const mathHost = target.closest<HTMLElement>(
      ".cm-md-math-inline, .cm-md-math-block",
    );
    if (mathHost) {
      const pos = view.posAtDOM(mathHost);
      if (pos != null) {
        view.dispatch({ selection: { anchor: pos + 1 } });
        view.focus();
        e.preventDefault();
      }
      return;
    }
    // 点击 wikilink widget：
    //   - 已解析 + 普通点击 → 打开目标笔记（与 preview 一致）
    //   - Alt/Option + 点击 OR 未解析 → 把光标移到源码起点编辑
    const wikiHost = target.closest<HTMLElement>(".cm-md-wikilink");
    if (wikiHost) {
      const path = wikiHost.dataset.path;
      if (path && !e.altKey) {
        e.preventDefault();
        void useTabs.getState().openPath(path);
        return;
      }
      const pos = view.posAtDOM(wikiHost);
      if (pos != null) {
        view.dispatch({ selection: { anchor: pos + 2 } }); // 跳过 [[
        view.focus();
        e.preventDefault();
      }
      if (!path) {
        useUI
          .getState()
          .setToast({ stage: "error", message: `未找到笔记：${wikiHost.textContent}` });
        window.setTimeout(() => useUI.getState().setToast(null), 1800);
      }
      return;
    }
    // 点击图片 widget → 把光标移到 markdown 源码起点（!）
    const imgHost = target.closest<HTMLElement>(".cm-md-img-widget");
    if (imgHost) {
      const pos = view.posAtDOM(imgHost);
      if (pos == null) return;
      view.dispatch({ selection: { anchor: pos } });
      view.focus();
      e.preventDefault();
      return;
    }
    // 点击 mermaid / dot / chart widget → 把光标移进 fenced code 第二行（源码体）
    const fencedHost = target.closest<HTMLElement>(".cm-md-fenced-widget");
    if (fencedHost) {
      const pos = view.posAtDOM(fencedHost);
      if (pos != null) {
        const firstLine = view.state.doc.lineAt(pos);
        const innerStart = Math.min(firstLine.to + 1, view.state.doc.length);
        view.dispatch({ selection: { anchor: innerStart } });
        view.focus();
        e.preventDefault();
      }
      return;
    }
    // 点击任务复选框时切换 - [ ] / - [x]
    if (!target.classList?.contains("cm-md-task")) return;
    const pos = view.posAtDOM(target);
    if (pos == null) return;
    const line = view.state.doc.lineAt(pos);
    const text = line.text;
    const m = text.match(/^(\s*[-*+]\s+\[)([ xX])(\])/);
    if (!m) return;
    const insert = m[2]!.toLowerCase() === "x" ? " " : "x";
    const from = line.from + m[1]!.length;
    const to = from + 1;
    view.dispatch({ changes: { from, to, insert } });
    e.preventDefault();
    },
  },
);

export const wysiwygMarkdown = [wysiwygField, wysiwygMousedown];
