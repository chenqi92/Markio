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
import { EditorSelection } from "@codemirror/state";

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
  lines.push(buildRow(padded[0]));
  lines.push(buildAlignRow(aligns, cols));
  for (let i = 1; i < padded.length; i++) {
    lines.push(buildRow(padded[i]));
  }
  return lines.join("\n");
}

function cellRangeInLine(lineText: string, lineFrom: number, col: number): { from: number; to: number } {
  const pipes: number[] = [];
  for (let i = 0; i < lineText.length; i++) {
    if (lineText[i] === "|") pipes.push(i);
  }
  if (pipes.length < 2) return { from: lineFrom, to: lineFrom };
  const startPipe = pipes[Math.max(0, Math.min(col, pipes.length - 2))];
  const endPipe = pipes[Math.max(1, Math.min(col + 1, pipes.length - 1))];
  let from = startPipe + 1;
  let to = endPipe;
  while (from < to && /\s/.test(lineText[from])) from++;
  while (to > from && /\s/.test(lineText[to - 1])) to--;
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

  if (lines.length >= 2 && /^\s*\|/.test(lines[0]) && isSeparatorRow(lines[1])) {
    return lines
      .filter((line, index) => index !== 1 && /^\s*\|/.test(line))
      .map(splitRow)
      .filter((row) => row.length > 0);
  }

  if (!trimmed.includes("\t") && lines.length < 2) return null;
  return lines.map((line) => line.split("\t").map((cell) => cell.trim()));
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

export function pasteTableText(view: EditorView, text: string): boolean {
  const data = parseTabularText(text);
  if (!data || data.length === 0) return false;
  const info = detectTable(view);
  if (!info) return false;

  const cells = info.cells.map((r) => r.slice());
  const aligns = info.aligns.slice();
  const { row: startRow, col: startCol } = normalizeCursor(info);
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
    for (let c = 0; c < data[r].length; c++) {
      cells[startRow + r][startCol + c] = data[r][c];
    }
  }

  replaceTable(
    view,
    info,
    cells,
    aligns,
    startRow + data.length - 1,
    startCol + data[data.length - 1].length - 1,
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

export function detectTable(view: EditorView): TableInfo | null {
  const doc = view.state.doc;
  const head = view.state.selection.main.head;
  const curLine = doc.lineAt(head);

  // 当前行必须以 `|` 开头（去掉 leading space 后）才考虑
  if (!/^\s*\|/.test(curLine.text)) return null;

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

  const headerCells = splitRow(rawLines[0]);
  const colCount = headerCells.length;
  const aligns: Array<"left" | "center" | "right" | null> = splitRow(rawLines[1]).map(parseAlign);
  // pad aligns to colCount
  while (aligns.length < colCount) aligns.push(null);

  const cells: string[][] = [headerCells];
  for (let i = 2; i < rawLines.length; i++) {
    const row = splitRow(rawLines[i]);
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

export type TableAction =
  | { type: "selectCell" }
  | { type: "selectTable" }
  | { type: "insertRowAbove" }
  | { type: "insertRowBelow" }
  | { type: "duplicateRow" }
  | { type: "insertColLeft" }
  | { type: "insertColRight" }
  | { type: "deleteRow" }
  | { type: "deleteCol" }
  | { type: "clearCell" }
  | { type: "clearRow" }
  | { type: "clearCol" }
  | { type: "selectRow" }
  | { type: "selectCol" }
  | { type: "align"; value: "left" | "center" | "right" | null };

export function applyTableAction(view: EditorView, action: TableAction): boolean {
  const info = detectTable(view);
  if (!info) return false;

  const cells = info.cells.map((r) => r.slice());
  const aligns = info.aligns.slice();
  const colCount = aligns.length;
  let row = info.cursorRow;
  let col = info.cursorCol;
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
      cells.splice(idx, 0, cells[row].slice());
      targetRow = idx;
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
    case "deleteRow": {
      if (cells.length <= 1) return false; // 至少保留表头
      cells.splice(Math.max(1, row), 1);
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
      cells[row][col] = "";
      break;
    }
    case "clearRow": {
      cells[row] = cells[row].map(() => "");
      break;
    }
    case "clearCol": {
      for (const r of cells) r[col] = "";
      break;
    }
    case "align": {
      aligns[col] = action.value;
      break;
    }
  }

  replaceTable(view, info, cells, aligns, targetRow, targetCol);
  return true;
}
