import type { EditorView } from "@codemirror/view";

export interface MathContext {
  formula: string;
  display: boolean;
  coords: { x: number; y: number };
}

const DISPLAY_MATH_SCAN_LIMIT_LINES = 250;

/**
 * 探测光标当前是否处于行内 $...$ 或 块级 $$...$$ 公式内。
 * 返回公式文本 + 显示模式 + 屏幕坐标（光标行底部偏 4px）；不在公式内返回 null。
 *
 * 行内规则：
 *   - 仅扫当前行；统计未转义、且不属于 $$ 对的 `$`
 *   - 光标前 `$` 个数为奇 → 在 inline math 内
 *
 * 块规则：
 *   - 光标行往上找最近的「整行 $$」；往下找最近的「整行 $$」；
 *     若上下都存在且光标在两者之间 → 在 display math 内
 */
export function getMathContext(view: EditorView): MathContext | null {
  const sel = view.state.selection.main;
  if (!sel.empty) return null;
  const pos = sel.head;
  const doc = view.state.doc;
  const line = doc.lineAt(pos);

  const isFenceLine = /^\s*\$\$\s*$/.test(line.text);
  const block = isFenceLine ? null : detectDisplayBlock(view, line.number);
  if (block) {
    const formulaLines: string[] = [];
    for (let n = block.start + 1; n < block.end; n++) {
      formulaLines.push(doc.line(n).text);
    }
    const formula = formulaLines.join("\n").trim();
    if (!formula) return null;
    const r = view.coordsAtPos(pos);
    if (!r) return null;
    return { formula, display: true, coords: { x: r.left, y: r.bottom + 4 } };
  }

  const inline = detectInlineMath(line.text, pos - line.from);
  if (!inline) return null;
  const r = view.coordsAtPos(pos);
  if (!r) return null;
  return { formula: inline.formula, display: false, coords: { x: r.left, y: r.bottom + 4 } };
}

function detectDisplayBlock(
  view: EditorView,
  cursorLineNumber: number,
): { start: number; end: number } | null {
  const doc = view.state.doc;
  let start = -1;
  const firstLine = Math.max(1, cursorLineNumber - DISPLAY_MATH_SCAN_LIMIT_LINES);
  for (let n = cursorLineNumber - 1; n >= firstLine; n--) {
    if (/^\s*\$\$\s*$/.test(doc.line(n).text)) {
      start = n;
      break;
    }
  }
  if (start < 0) return null;
  let end = -1;
  const lastLine = Math.min(doc.lines, cursorLineNumber + DISPLAY_MATH_SCAN_LIMIT_LINES);
  for (let n = cursorLineNumber + 1; n <= lastLine; n++) {
    if (/^\s*\$\$\s*$/.test(doc.line(n).text)) {
      end = n;
      break;
    }
  }
  if (end < 0) return null;
  return { start, end };
}

function detectInlineMath(
  lineText: string,
  posInLine: number,
): { from: number; to: number; formula: string } | null {
  const dollars: number[] = [];
  let i = 0;
  while (i < lineText.length) {
    if (lineText[i] === "\\" && lineText[i + 1] === "$") {
      i += 2;
      continue;
    }
    if (lineText[i] === "$" && lineText[i + 1] === "$") {
      i += 2;
      continue;
    }
    if (lineText[i] === "$") dollars.push(i);
    i++;
  }
  if (dollars.length < 2) return null;
  let countBefore = 0;
  let leftIdx = -1;
  let rightIdx = -1;
  for (const d of dollars) {
    if (d < posInLine) {
      countBefore++;
      leftIdx = d;
    } else if (rightIdx < 0) {
      rightIdx = d;
    }
  }
  if (countBefore % 2 === 0) return null;
  if (leftIdx < 0 || rightIdx < 0) return null;
  const formula = lineText.slice(leftIdx + 1, rightIdx).trim();
  if (!formula) return null;
  return { from: leftIdx, to: rightIdx, formula };
}
