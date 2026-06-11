// GFM 表格的轻量级在线编辑助手。
//
// 设计：
//   * 不引入额外 CM6 widget；只暴露纯函数 + 对外的「detect / mutate」API
//   * 表格识别：连续 ≥ 2 行、每行以 `|` 开头 / 结尾、且第 2 行是分隔行（`|----|----|`）
//   * 列对齐通过分隔行的 `:----`、`----:`、`:---:` 表达
//
// EditorArea / TableToolbar 在选区变化时调用 `detectTable`；
// 工具栏按钮调用 `withTable` 拿到 mutated content 再 dispatch。

import type { EditorView } from "@codemirror/view";
import { EditorSelection, type SelectionRange } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

/**
 * pos 是否落在 fenced code / 缩进代码块里。代码块里的 `| a | b |` 是代码文本，
 * 不是 GFM 表格 —— 不能套用单元格选区 / Tab 切格 / Backspace 清格那套交互，
 * 否则用户没法对「卡在 ``` 里的表格」做普通文本选中与删除。取不到语法树时
 * 当作不在代码块里（退回原有表格识别）。
 */
function isInsideCodeBlock(view: EditorView, pos: number): boolean {
  try {
    let node: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null =
      syntaxTree(view.state).resolveInner(pos, 0);
    while (node) {
      if (node.name === "FencedCode" || node.name === "CodeBlock") return true;
      node = node.parent;
    }
  } catch {
    // ignore：无语法树时按非代码块处理
  }
  return false;
}

export interface TableInfo {
  /** 表格在 doc 中的 [from, to) 字符范围（含分隔行 + 数据行，含尾部换行） */
  from: number;
  to: number;
  /** 整张表格的原始文本（保留原换行） */
  text: string;
  /** 解析出的二维矩阵：cells[row][col]；row 0 是表头 */
  cells: string[][];
  /** 列对齐方式："left" | "center" | "right" | null */
  aligns: Array<"left" | "center" | "right" | null>;
  /** 光标所在行（0 = 表头），可能为 -1（如分隔行） */
  cursorRow: number;
  /** 光标所在列 */
  cursorCol: number;
  /** 表格起始行号（CodeMirror 1-based） */
  topLine: number;
}

export type TableClipboardMode = "cell" | "row" | "col" | "table";
export type TableMoveDirection = "next" | "prev" | "down" | "up";
export type TableCellCoord = { row: number; col: number };
export type TableSelectionRect = {
  tableFrom: number;
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
};

/** 给定 doc 的整个表格 cells[][] 与一个 (row, col)，返回 cursor 应当落在
 *  源码中的字符位置（cell 内容的开头，跳过 "| "）。row 0 = 表头，1+ = 数据行。
 *  分隔行不计入 row。 */
export function tableCellSourcePos(
  view: EditorView,
  tableTopLine: number,
  row: number,
  col: number,
): number | null {
  const lineNum = row === 0 ? tableTopLine : tableTopLine + 1 + row;
  if (lineNum < 1 || lineNum > view.state.doc.lines) return null;
  const line = view.state.doc.line(lineNum);
  const text = line.text;
  const pipes: number[] = [];
  for (let i = 0; i < text.length; i++) if (text[i] === "|") pipes.push(i);
  const fromIdx = pipes[col];
  const toIdx = pipes[col + 1];
  if (fromIdx == null || toIdx == null) return null;
  return Math.min(line.from + fromIdx + 2, line.from + toIdx);
}

/** 扫描整个 markdown 源码，按文档顺序列出所有 GFM 表格。
 *  规则与 detectTable 相同：连续 ≥ 2 行、首尾以 `|` 包裹、第二行是分隔行。
 *  返回每张表格的字符 from/to 与首个数据行的 1-based 行号 —— Preview
 *  侧 hover 第 N 个 <table> 时可借此把 cursor 移到对应源码位置。 */
export function findAllTablesInText(doc: string): Array<{
  from: number;
  to: number;
  topLine: number;
  dataRowLine: number;
}> {
  const lines = doc.split("\n");
  const result: Array<{ from: number; to: number; topLine: number; dataRowLine: number }> = [];
  // 预计算每行的字符起始偏移（含换行）
  const offsets: number[] = new Array(lines.length);
  let acc = 0;
  for (let i = 0; i < lines.length; i++) {
    offsets[i] = acc;
    acc += lines[i]!.length + 1; // +1 for "\n"
  }
  let i = 0;
  while (i < lines.length) {
    const head = lines[i]!.trim();
    if (
      head.startsWith("|") &&
      head.endsWith("|") &&
      i + 1 < lines.length &&
      isSeparatorRow(lines[i + 1]!)
    ) {
      let end = i + 2;
      while (end < lines.length) {
        const t = lines[end]!.trim();
        if (!t.startsWith("|") || !t.endsWith("|")) break;
        end++;
      }
      const from = offsets[i]!;
      // 到表格最后一行内容结尾，**不含**其后的换行符。旧实现非文末时取 offsets[end]
      // （下一行起点）会把表格后的 \n 也纳入替换范围，而 buildTable 输出无尾换行，
      // 导致每次文本路径编辑吃掉一个换行，最终把后面的行并进表格末行损坏文档。
      const to = offsets[end - 1]! + lines[end - 1]!.length;
      result.push({
        from,
        to,
        topLine: i + 1,
        dataRowLine: Math.min(i + 3, lines.length), // 1-based first data row
      });
      i = end;
    } else {
      i++;
    }
  }
  return result;
}

function isSeparatorRow(line: string): boolean {
  // |:----|----:| 之类；至少要有 ---
  const inner = line.trim().replace(/^\||\|$/g, "");
  if (!/-/.test(inner)) return false;
  return inner.split("|").every((seg) => /^\s*:?-{3,}:?\s*$/.test(seg));
}

function parseAlign(seg: string): "left" | "center" | "right" | null {
  const t = seg.trim();
  const left = t.startsWith(":");
  const right = t.endsWith(":");
  if (left && right) return "center";
  if (left) return "left";
  if (right) return "right";
  return null;
}

function splitRow(line: string): string[] {
  // 去掉首尾 |，按 | 分；保留单元内的转义 \\|
  // 简化：不处理 \\|，绝大多数表格不会用到
  const trimmed = line.trim().replace(/^\||\|$/g, "");
  return trimmed.split("|").map((c) => c.trim());
}

function buildAlignRow(aligns: Array<"left" | "center" | "right" | null>, cols: number): string {
  const cells: string[] = [];
  for (let i = 0; i < cols; i++) {
    const a = aligns[i] ?? null;
    if (a === "center") cells.push(":---:");
    else if (a === "left") cells.push(":---");
    else if (a === "right") cells.push("---:");
    else cells.push("---");
  }
  return "| " + cells.join(" | ") + " |";
}

function buildRow(cells: string[]): string {
  return "| " + cells.map((c) => c || " ").join(" | ") + " |";
}

function buildTable(cells: string[][], aligns: Array<"left" | "center" | "right" | null>): string {
  const cols = Math.max(1, ...cells.map((r) => r.length), aligns.length);
  const padded = cells.map((row) => {
    const out = row.slice();
    while (out.length < cols) out.push("");
    return out;
  });
  const lines: string[] = [];
  lines.push(buildRow(padded[0]!));
  lines.push(buildAlignRow(aligns, cols));
  for (let i = 1; i < padded.length; i++) {
    lines.push(buildRow(padded[i]!));
  }
  return lines.join("\n");
}

function padCell(value: string, width: number, align: "left" | "center" | "right" | null) {
  const text = value || "";
  const gap = Math.max(0, width - text.length);
  if (align === "right") return " ".repeat(gap) + text;
  if (align === "center") {
    const left = Math.floor(gap / 2);
    return " ".repeat(left) + text + " ".repeat(gap - left);
  }
  return text + " ".repeat(gap);
}

function buildPrettyTable(
  cells: string[][],
  aligns: Array<"left" | "center" | "right" | null>,
): string {
  const cols = Math.max(1, ...cells.map((r) => r.length), aligns.length);
  const padded = cells.map((row) => {
    const out = row.slice();
    while (out.length < cols) out.push("");
    return out;
  });
  const widths = Array.from({ length: cols }, (_, col) =>
    Math.max(3, ...padded.map((row) => (row[col] || "").length)),
  );
  const rowLine = (row: string[]) =>
    `| ${row.map((cell, col) => padCell(cell, widths[col]!, aligns[col] ?? null)).join(" | ")} |`;
  const separator = widths.map((width, col) => {
    const dashes = "-".repeat(Math.max(3, width));
    const align = aligns[col] ?? null;
    if (align === "center") return `:${dashes}:`;
    if (align === "left") return `:${dashes}`;
    if (align === "right") return `${dashes}:`;
    return dashes;
  });
  return [rowLine(padded[0]!), `| ${separator.join(" | ")} |`, ...padded.slice(1).map(rowLine)]
    .join("\n");
}

function cellRangeInLine(lineText: string, lineFrom: number, col: number): { from: number; to: number } {
  const pipes: number[] = [];
  for (let i = 0; i < lineText.length; i++) {
    if (lineText[i] === "|") pipes.push(i);
  }
  if (pipes.length < 2) return { from: lineFrom, to: lineFrom };
  const startPipe = pipes[Math.max(0, Math.min(col, pipes.length - 2))]!;
  const endPipe = pipes[Math.max(1, Math.min(col + 1, pipes.length - 1))]!;
  let from = startPipe + 1;
  let to = endPipe;
  while (from < to && /\s/.test(lineText[from]!)) from++;
  while (to > from && /\s/.test(lineText[to - 1]!)) to--;
  return { from: lineFrom + from, to: lineFrom + to };
}

function cellRangeInBuiltTable(table: string, tableFrom: number, row: number, col: number) {
  const lines = table.split("\n");
  const lineIndex = row === 0 ? 0 : row + 1;
  const before = lines.slice(0, lineIndex).join("\n");
  const lineFrom = tableFrom + (before ? before.length + 1 : 0);
  const range = cellRangeInLine(lines[lineIndex] ?? "", lineFrom, col);
  return { anchor: range.from, head: range.to };
}

function rowLineNumber(info: TableInfo, row: number): number {
  return info.topLine + (row === 0 ? 0 : row + 1);
}

function clampRect(info: TableInfo, rect: TableSelectionRect): TableSelectionRect {
  const maxRow = Math.max(0, info.cells.length - 1);
  const maxCol = Math.max(0, (info.cells[0]?.length ?? 1) - 1);
  return {
    tableFrom: info.from,
    startRow: Math.max(0, Math.min(maxRow, rect.startRow)),
    endRow: Math.max(0, Math.min(maxRow, rect.endRow)),
    startCol: Math.max(0, Math.min(maxCol, rect.startCol)),
    endCol: Math.max(0, Math.min(maxCol, rect.endCol)),
  };
}

function normalizeRect(info: TableInfo, anchor: TableCellCoord, head: TableCellCoord): TableSelectionRect {
  return clampRect(info, {
    tableFrom: info.from,
    startRow: Math.min(anchor.row, head.row),
    endRow: Math.max(anchor.row, head.row),
    startCol: Math.min(anchor.col, head.col),
    endCol: Math.max(anchor.col, head.col),
  });
}

function normalizeCursor(info: TableInfo) {
  const row =
    info.cursorRow < 0
      ? Math.min(1, info.cells.length - 1)
      : Math.max(0, Math.min(info.cells.length - 1, info.cursorRow));
  const col = Math.max(0, Math.min(info.aligns.length - 1, info.cursorCol));
  return { row, col };
}

function replaceTable(
  view: EditorView,
  info: TableInfo,
  cells: string[][],
  aligns: Array<"left" | "center" | "right" | null>,
  targetRow: number,
  targetCol: number,
) {
  const next = buildTable(cells, aligns);
  view.dispatch({
    changes: { from: info.from, to: info.to, insert: next },
    selection: cellRangeInBuiltTable(next, info.from, targetRow, targetCol),
    scrollIntoView: true,
    userEvent: "input",
  });
}

export function parseTabularText(text: string): string[][] | null {
  const trimmed = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n$/, "");
  if (!trimmed) return null;
  const lines = trimmed.split("\n");

  if (lines.length >= 2 && /^\s*\|/.test(lines[0]!) && isSeparatorRow(lines[1]!)) {
    return lines
      .filter((line, index) => index !== 1 && /^\s*\|/.test(line))
      .map(splitRow)
      .filter((row) => row.length > 0);
  }

  if (!trimmed.includes("\t") && lines.length < 2) return null;
  return lines.map((line) => line.split("\t").map((cell) => cell.trim()));
}

export function tableCellTextFromText(
  source: string,
  tableIndex: number,
  cursor: TableCellCoord,
): string | null {
  const table = findAllTablesInText(source)[tableIndex];
  if (!table) return null;
  const parsed = parseTableText(source.slice(table.from, table.to));
  if (!parsed) return null;
  const row = Math.max(0, Math.min(parsed.cells.length - 1, cursor.row));
  const col = Math.max(0, Math.min(parsed.aligns.length - 1, cursor.col));
  return parsed.cells[row]?.[col] ?? "";
}

export function pasteTableTextToText(
  source: string,
  tableIndex: number,
  cursor: TableCellCoord,
  text: string,
): string | null {
  const data = parseTabularText(text);
  if (!data || data.length === 0) return null;
  const table = findAllTablesInText(source)[tableIndex];
  if (!table) return null;
  const parsed = parseTableText(source.slice(table.from, table.to));
  if (!parsed) return null;

  const cells = parsed.cells.map((r) => r.slice());
  const aligns = parsed.aligns.slice();
  const startRow = Math.max(0, Math.min(cells.length - 1, cursor.row));
  const startCol = Math.max(0, Math.min(aligns.length - 1, cursor.col));
  const requiredRows = startRow + data.length;
  const requiredCols = startCol + Math.max(...data.map((r) => r.length));

  while (cells.length < requiredRows) {
    cells.push(Array(aligns.length).fill(""));
  }
  while (aligns.length < requiredCols) {
    aligns.push(null);
    for (const row of cells) row.push("");
  }
  for (let r = 0; r < data.length; r++) {
    for (let c = 0; c < data[r]!.length; c++) {
      cells[startRow + r]![startCol + c] = data[r]![c]!;
    }
  }

  const next = buildTable(cells, aligns);
  return source.slice(0, table.from) + next + source.slice(table.to);
}

export function tableClipboardText(view: EditorView, mode: TableClipboardMode): string | null {
  const info = detectTable(view);
  if (!info) return null;
  const { row, col } = normalizeCursor(info);
  if (mode === "cell") return info.cells[row]?.[col] ?? "";
  if (mode === "row") return (info.cells[row] ?? []).join("\t");
  if (mode === "col") return info.cells.map((r) => r[col] ?? "").join("\n");
  return info.cells.map((r) => r.join("\t")).join("\n");
}

export function pasteTableText(view: EditorView, text: string, start?: TableCellCoord): boolean {
  const data = parseTabularText(text);
  if (!data || data.length === 0) return false;
  const info = detectTable(view);
  if (!info) return false;

  const cells = info.cells.map((r) => r.slice());
  const aligns = info.aligns.slice();
  const cursor = normalizeCursor(info);
  const startRow = Math.max(0, Math.min(cells.length - 1, start?.row ?? cursor.row));
  const startCol = Math.max(0, Math.min(aligns.length - 1, start?.col ?? cursor.col));
  const requiredRows = startRow + data.length;
  const requiredCols = startCol + Math.max(...data.map((r) => r.length));

  while (cells.length < requiredRows) {
    cells.push(Array(aligns.length).fill(""));
  }
  while (aligns.length < requiredCols) {
    aligns.push(null);
    for (const row of cells) row.push("");
  }
  for (let r = 0; r < data.length; r++) {
    for (let c = 0; c < data[r]!.length; c++) {
      cells[startRow + r]![startCol + c] = data[r]![c]!;
    }
  }

  replaceTable(
    view,
    info,
    cells,
    aligns,
    startRow + data.length - 1,
    startCol + data[data.length - 1]!.length - 1,
  );
  return true;
}

export function moveTableCell(view: EditorView, direction: TableMoveDirection): boolean {
  const info = detectTable(view);
  if (!info) return false;
  const cells = info.cells.map((r) => r.slice());
  const aligns = info.aligns.slice();
  const { row, col } = normalizeCursor(info);
  let nextRow = row;
  let nextCol = col;

  if (direction === "next") {
    nextCol += 1;
    if (nextCol >= aligns.length) {
      nextCol = 0;
      nextRow += 1;
    }
  } else if (direction === "prev") {
    nextCol -= 1;
    if (nextCol < 0) {
      nextRow -= 1;
      nextCol = aligns.length - 1;
    }
  } else if (direction === "down") {
    nextRow += 1;
  } else {
    nextRow -= 1;
  }

  if (nextRow < 0) return false;
  if (nextRow >= cells.length) {
    cells.push(Array(aligns.length).fill(""));
    replaceTable(view, info, cells, aligns, cells.length - 1, nextCol);
    return true;
  }

  const line = view.state.doc.line(rowLineNumber(info, nextRow));
  const range = cellRangeInLine(line.text, line.from, nextCol);
  view.dispatch({
    selection: { anchor: range.from, head: range.to },
    scrollIntoView: true,
  });
  return true;
}

function detectTableAtPosition(view: EditorView, head: number): TableInfo | null {
  const doc = view.state.doc;
  const curLine = doc.lineAt(head);

  // 当前行必须以 `|` 开头（去掉 leading space 后）才考虑
  if (!/^\s*\|/.test(curLine.text)) return null;

  // ``` 围栏 / 缩进代码块里的 `| … |` 是代码，不当表格处理（否则单元格选区 /
  // Tab 切格 / 退格清格会拦截普通文本选中与删除）。
  if (isInsideCodeBlock(view, head)) return null;

  // 向上找表格起点
  let topLine = curLine.number;
  while (topLine > 1) {
    const prev = doc.line(topLine - 1);
    if (!/^\s*\|/.test(prev.text)) break;
    topLine -= 1;
  }
  // 向下找表格终点
  let bottomLine = curLine.number;
  while (bottomLine < doc.lines) {
    const next = doc.line(bottomLine + 1);
    if (!/^\s*\|/.test(next.text)) break;
    bottomLine += 1;
  }

  if (bottomLine - topLine + 1 < 2) return null;

  // 第二行必须是分隔行（GFM 表格的硬性要求）
  const sepLine = doc.line(topLine + 1);
  if (!isSeparatorRow(sepLine.text)) return null;

  const rawLines: string[] = [];
  for (let i = topLine; i <= bottomLine; i++) {
    rawLines.push(doc.line(i).text);
  }

  const headerCells = splitRow(rawLines[0]!);
  const colCount = headerCells.length;
  const aligns: Array<"left" | "center" | "right" | null> = splitRow(rawLines[1]!).map(parseAlign);
  // pad aligns to colCount
  while (aligns.length < colCount) aligns.push(null);

  const cells: string[][] = [headerCells];
  for (let i = 2; i < rawLines.length; i++) {
    const row = splitRow(rawLines[i]!);
    while (row.length < colCount) row.push("");
    cells.push(row);
  }

  const from = doc.line(topLine).from;
  const to = doc.line(bottomLine).to;

  // 计算 cursorRow / cursorCol
  const cursorLineNum = curLine.number;
  let cursorRow: number;
  if (cursorLineNum === topLine) cursorRow = 0;
  else if (cursorLineNum === topLine + 1)
    cursorRow = -1; // 分隔行
  else cursorRow = cursorLineNum - topLine - 1;

  // 列：根据 head - lineFrom 在文本里数有几个 `|`
  const before = curLine.text.slice(0, head - curLine.from);
  const pipeCount = (before.match(/\|/g) ?? []).length;
  const cursorCol = Math.max(0, Math.min(colCount - 1, pipeCount - 1));

  return {
    from,
    to,
    text: rawLines.join("\n"),
    cells,
    aligns,
    cursorRow,
    cursorCol,
    topLine,
  };
}

export function detectTable(view: EditorView): TableInfo | null {
  return detectTableAtPosition(view, view.state.selection.main.head);
}

export function tableCellAtPosition(
  view: EditorView,
  pos: number,
): (TableCellCoord & { info: TableInfo }) | null {
  const info = detectTableAtPosition(view, pos);
  if (!info) return null;
  const { row, col } = normalizeCursor(info);
  return { info, row, col };
}

export function tableCellFromCoords(
  view: EditorView,
  coords: { x: number; y: number },
): (TableCellCoord & { info: TableInfo }) | null {
  const pos = view.posAtCoords(coords);
  if (pos == null) return null;
  return tableCellAtPosition(view, pos);
}

export function selectTableRect(
  view: EditorView,
  info: TableInfo,
  anchor: TableCellCoord,
  head: TableCellCoord,
): TableSelectionRect | null {
  const rect = normalizeRect(info, anchor, head);
  if (rect.tableFrom !== info.from) return null;

  const ranges: SelectionRange[] = [];
  for (let row = rect.startRow; row <= rect.endRow; row++) {
    const line = view.state.doc.line(rowLineNumber(info, row));
    for (let col = rect.startCol; col <= rect.endCol; col++) {
      const range = cellRangeInLine(line.text, line.from, col);
      ranges.push(EditorSelection.range(range.from, range.to));
    }
  }
  if (ranges.length === 0) return null;
  view.dispatch({
    selection: EditorSelection.create(ranges, 0),
    scrollIntoView: true,
  });
  return rect;
}

export function tableRectClipboardText(view: EditorView, rect: TableSelectionRect): string | null {
  const info = detectTableAtPosition(view, Math.min(rect.tableFrom, view.state.doc.length));
  if (!info || info.from !== rect.tableFrom) return null;
  const current = clampRect(info, rect);
  const rows: string[][] = [];
  for (let row = current.startRow; row <= current.endRow; row++) {
    const out: string[] = [];
    for (let col = current.startCol; col <= current.endCol; col++) {
      out.push(info.cells[row]?.[col] ?? "");
    }
    rows.push(out);
  }
  return rows.map((row) => row.join("\t")).join("\n");
}

export function clearTableRect(view: EditorView, rect: TableSelectionRect): boolean {
  const info = detectTableAtPosition(view, Math.min(rect.tableFrom, view.state.doc.length));
  if (!info || info.from !== rect.tableFrom) return false;
  const current = clampRect(info, rect);
  const cells = info.cells.map((row) => row.slice());
  for (let row = current.startRow; row <= current.endRow; row++) {
    for (let col = current.startCol; col <= current.endCol; col++) {
      cells[row]![col] = "";
    }
  }
  replaceTable(view, info, cells, info.aligns.slice(), current.startRow, current.startCol);
  return true;
}

export type TableAction =
  | { type: "selectCell" }
  | { type: "selectTable" }
  | { type: "insertRowAbove" }
  | { type: "insertRowBelow" }
  | { type: "duplicateRow" }
  | { type: "moveRowUp" }
  | { type: "moveRowDown" }
  | { type: "insertColLeft" }
  | { type: "insertColRight" }
  | { type: "duplicateCol" }
  | { type: "moveColLeft" }
  | { type: "moveColRight" }
  | { type: "deleteRow" }
  | { type: "deleteCol" }
  | { type: "clearCell" }
  | { type: "clearRow" }
  | { type: "clearCol" }
  | { type: "fillDown" }
  | { type: "sortAsc" }
  | { type: "sortDesc" }
  | { type: "format" }
  | { type: "selectRow" }
  | { type: "selectCol" }
  | { type: "align"; value: "left" | "center" | "right" | null };

function parseTableText(text: string): {
  cells: string[][];
  aligns: Array<"left" | "center" | "right" | null>;
} | null {
  const rawLines = text.split(/\r?\n/).filter((line) => /^\s*\|/.test(line));
  if (rawLines.length < 2 || !isSeparatorRow(rawLines[1]!)) return null;
  const headerCells = splitRow(rawLines[0]!);
  const colCount = headerCells.length;
  const aligns: Array<"left" | "center" | "right" | null> =
    splitRow(rawLines[1]!).map(parseAlign);
  while (aligns.length < colCount) aligns.push(null);

  const cells: string[][] = [headerCells];
  for (let i = 2; i < rawLines.length; i++) {
    const row = splitRow(rawLines[i]!);
    while (row.length < colCount) row.push("");
    cells.push(row);
  }
  return { cells, aligns };
}

export function applyTableActionToText(
  source: string,
  tableIndex: number,
  cursor: TableCellCoord,
  action: TableAction,
): string | null {
  const tables = findAllTablesInText(source);
  const table = tables[tableIndex];
  if (!table) return null;
  if (
    action.type === "selectCell" ||
    action.type === "selectTable" ||
    action.type === "selectRow" ||
    action.type === "selectCol"
  ) {
    return null;
  }

  const parsed = parseTableText(source.slice(table.from, table.to));
  if (!parsed) return null;
  const cells = parsed.cells.map((r) => r.slice());
  const aligns = parsed.aligns.slice();
  const colCount = aligns.length;
  const row = Math.max(0, Math.min(cells.length - 1, cursor.row));
  const col = Math.max(0, Math.min(colCount - 1, cursor.col));

  switch (action.type) {
    case "insertRowAbove":
      cells.splice(row, 0, Array(colCount).fill(""));
      break;
    case "insertRowBelow":
      cells.splice(row + 1, 0, Array(colCount).fill(""));
      break;
    case "duplicateRow":
      cells.splice(row + 1, 0, cells[row]!.slice());
      break;
    case "moveRowUp":
      if (row <= 1) return null;
      swapItems(cells, row, row - 1);
      break;
    case "moveRowDown":
      if (row === 0 || row >= cells.length - 1) return null;
      swapItems(cells, row, row + 1);
      break;
    case "insertColLeft":
      for (const r of cells) r.splice(col, 0, "");
      aligns.splice(col, 0, null);
      break;
    case "insertColRight":
      for (const r of cells) r.splice(col + 1, 0, "");
      aligns.splice(col + 1, 0, null);
      break;
    case "duplicateCol":
      for (const r of cells) r.splice(col + 1, 0, r[col] ?? "");
      aligns.splice(col + 1, 0, aligns[col] ?? null);
      break;
    case "moveColLeft":
      if (col <= 0) return null;
      for (const r of cells) swapItems(r, col, col - 1);
      swapItems(aligns, col, col - 1);
      break;
    case "moveColRight":
      if (col >= colCount - 1) return null;
      for (const r of cells) swapItems(r, col, col + 1);
      swapItems(aligns, col, col + 1);
      break;
    case "deleteRow":
      if (cells.length <= 1 || row === 0) return null;
      cells.splice(row, 1);
      break;
    case "deleteCol":
      if (colCount <= 1) return null;
      for (const r of cells) r.splice(col, 1);
      aligns.splice(col, 1);
      break;
    case "clearCell":
      cells[row]![col] = "";
      break;
    case "clearRow":
      cells[row] = cells[row]!.map(() => "");
      break;
    case "clearCol":
      for (const r of cells) r[col] = "";
      break;
    case "fillDown": {
      const value = cells[row]![col] ?? "";
      for (let r = Math.max(1, row + 1); r < cells.length; r++) {
        cells[r]![col] = value;
      }
      break;
    }
    case "sortAsc":
    case "sortDesc": {
      const header = cells[0]!;
      const body = cells.slice(1);
      const dir = action.type === "sortAsc" ? 1 : -1;
      body.sort((a, b) => compareTableValues(a[col] ?? "", b[col] ?? "") * dir);
      cells.splice(0, cells.length, header, ...body);
      break;
    }
    case "format": {
      const next = buildPrettyTable(cells, aligns);
      return source.slice(0, table.from) + next + source.slice(table.to);
    }
    case "align":
      aligns[col] = action.value;
      break;
  }

  const next = buildTable(cells, aligns);
  return source.slice(0, table.from) + next + source.slice(table.to);
}

function swapItems<T>(items: T[], a: number, b: number) {
  const temp = items[a]!;
  items[a] = items[b]!;
  items[b] = temp;
}

function compareTableValues(a: string, b: string) {
  const aa = a.trim();
  const bb = b.trim();
  const an = Number(aa.replace(/,/g, ""));
  const bn = Number(bb.replace(/,/g, ""));
  if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
  return aa.localeCompare(bb, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

export function applyTableAction(view: EditorView, action: TableAction): boolean {
  const info = detectTable(view);
  if (!info) return false;

  const cells = info.cells.map((r) => r.slice());
  const aligns = info.aligns.slice();
  const colCount = aligns.length;
  let row = info.cursorRow;
  const col = info.cursorCol;
  if (row < 0) row = Math.min(1, cells.length - 1);
  row = Math.max(0, Math.min(cells.length - 1, row));
  let targetRow = row;
  let targetCol = col;

  if (action.type === "selectCell") {
    const line = view.state.doc.line(rowLineNumber(info, row));
    const range = cellRangeInLine(line.text, line.from, col);
    view.dispatch({
      selection: { anchor: range.from, head: range.to },
      scrollIntoView: true,
    });
    return true;
  }

  if (action.type === "selectTable") {
    view.dispatch({
      selection: { anchor: info.from, head: info.to },
      scrollIntoView: true,
    });
    return true;
  }

  if (action.type === "selectRow") {
    const lineNumber = rowLineNumber(info, row);
    const line = view.state.doc.line(lineNumber);
    view.dispatch({
      selection: { anchor: line.from, head: line.to },
      scrollIntoView: true,
    });
    return true;
  }

  if (action.type === "selectCol") {
    const ranges = info.cells.map((_, r) => {
      const lineNumber = rowLineNumber(info, r);
      const line = view.state.doc.line(lineNumber);
      const range = cellRangeInLine(line.text, line.from, col);
      return EditorSelection.range(range.from, range.to);
    });
    view.dispatch({
      selection: EditorSelection.create(ranges, 0),
      scrollIntoView: true,
    });
    return true;
  }

  switch (action.type) {
    case "insertRowAbove": {
      const idx = row;
      const newRow = Array(colCount).fill("");
      cells.splice(idx, 0, newRow);
      targetRow = idx;
      break;
    }
    case "insertRowBelow": {
      const idx = row + 1;
      const newRow = Array(colCount).fill("");
      cells.splice(idx, 0, newRow);
      targetRow = idx;
      break;
    }
    case "duplicateRow": {
      const idx = row + 1;
      cells.splice(idx, 0, cells[row]!.slice());
      targetRow = idx;
      break;
    }
    case "moveRowUp": {
      if (row <= 1) return false;
      swapItems(cells, row, row - 1);
      targetRow = row - 1;
      break;
    }
    case "moveRowDown": {
      if (row === 0 || row >= cells.length - 1) return false;
      swapItems(cells, row, row + 1);
      targetRow = row + 1;
      break;
    }
    case "insertColLeft": {
      for (const r of cells) r.splice(col, 0, "");
      aligns.splice(col, 0, null);
      targetCol = col;
      break;
    }
    case "insertColRight": {
      for (const r of cells) r.splice(col + 1, 0, "");
      aligns.splice(col + 1, 0, null);
      targetCol = col + 1;
      break;
    }
    case "duplicateCol": {
      for (const r of cells) r.splice(col + 1, 0, r[col] ?? "");
      aligns.splice(col + 1, 0, aligns[col] ?? null);
      targetCol = col + 1;
      break;
    }
    case "moveColLeft": {
      if (col <= 0) return false;
      for (const r of cells) swapItems(r, col, col - 1);
      swapItems(aligns, col, col - 1);
      targetCol = col - 1;
      break;
    }
    case "moveColRight": {
      if (col >= colCount - 1) return false;
      for (const r of cells) swapItems(r, col, col + 1);
      swapItems(aligns, col, col + 1);
      targetCol = col + 1;
      break;
    }
    case "deleteRow": {
      if (cells.length <= 1) return false; // 至少保留表头
      if (row === 0) return false;
      cells.splice(row, 1);
      targetRow = Math.min(Math.max(1, row), cells.length - 1);
      break;
    }
    case "deleteCol": {
      if (colCount <= 1) return false;
      for (const r of cells) r.splice(col, 1);
      aligns.splice(col, 1);
      targetCol = Math.min(col, aligns.length - 1);
      break;
    }
    case "clearCell": {
      cells[row]![col] = "";
      break;
    }
    case "clearRow": {
      cells[row] = cells[row]!.map(() => "");
      break;
    }
    case "clearCol": {
      for (const r of cells) r[col] = "";
      break;
    }
    case "fillDown": {
      const value = cells[row]![col] ?? "";
      for (let r = Math.max(1, row + 1); r < cells.length; r++) {
        cells[r]![col] = value;
      }
      break;
    }
    case "sortAsc":
    case "sortDesc": {
      const header = cells[0]!;
      const body = cells.slice(1);
      const dir = action.type === "sortAsc" ? 1 : -1;
      body.sort((a, b) => compareTableValues(a[col] ?? "", b[col] ?? "") * dir);
      cells.splice(0, cells.length, header, ...body);
      targetRow = Math.min(Math.max(1, row), cells.length - 1);
      break;
    }
    case "format": {
      const next = buildPrettyTable(cells, aligns);
      view.dispatch({
        changes: { from: info.from, to: info.to, insert: next },
        selection: cellRangeInBuiltTable(next, info.from, targetRow, targetCol),
        scrollIntoView: true,
        userEvent: "input",
      });
      return true;
    }
    case "align": {
      aligns[col] = action.value;
      break;
    }
  }

  replaceTable(view, info, cells, aligns, targetRow, targetCol);
  return true;
}
