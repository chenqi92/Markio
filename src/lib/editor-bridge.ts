/**
 * 编辑器桥接：让工具栏 / Bubble / Slash 等组件能直接驱动当前 CodeMirror 视图。
 *
 * SourceEditor 挂载时把 EditorView 注册进来，卸载时清理。
 * 外部组件用 `runEditorCommand` 包装的指令操作选区 / 插入文本。
 */
import type { EditorView } from "@codemirror/view";

let active: EditorView | null = null;
const listeners = new Set<() => void>();
type MarkdownCommandHandler = (
  name: string,
  args: readonly unknown[],
) => boolean;

let markdownCommandHandler: MarkdownCommandHandler | null = null;

export function registerEditor(view: EditorView | null) {
  active = view;
  listeners.forEach((cb) => cb());
}

export function getEditor(): EditorView | null {
  return active;
}

export function subscribeEditor(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function registerMarkdownCommandHandler(
  handler: MarkdownCommandHandler | null,
) {
  markdownCommandHandler = handler;
}

export function runRegisteredMarkdownCommand(
  name: string,
  args: readonly unknown[] = [],
): boolean {
  try {
    return markdownCommandHandler?.(name, args) === true;
  } catch {
    return false;
  }
}

/** 通用：把当前选区包裹起来；如果没选区，就插入占位串 */
export function wrapSelection(
  before: string,
  after: string = before,
  placeholder = "",
) {
  const view = active;
  if (!view) return;
  const { from, to } = view.state.selection.main;
  const text = view.state.sliceDoc(from, to);
  const insert = text || placeholder;
  const newFrom = from + before.length;
  const newTo = newFrom + insert.length;
  view.dispatch({
    changes: { from, to, insert: before + insert + after },
    selection: { anchor: newFrom, head: newTo },
  });
  view.focus();
}

type SelectionTarget =
  | { anchor: number }
  | { anchor: number; head: number };

function selectionForInsertedText(
  from: number,
  inserted: string,
  options?: {
    cursorOffset?: number;
    selectText?: string;
  },
): SelectionTarget {
  if (typeof options?.cursorOffset === "number") {
    return { anchor: from + Math.max(0, Math.min(inserted.length, options.cursorOffset)) };
  }
  if (options?.selectText) {
    const ix = inserted.indexOf(options.selectText);
    if (ix >= 0) {
      return {
        anchor: from + ix,
        head: from + ix + options.selectText.length,
      };
    }
  }
  return { anchor: from + inserted.length };
}

/** 在当前行开头加前缀（# / - / > 等） */
export function prefixLine(prefix: string) {
  const view = active;
  if (!view) return;
  const { from, to } = view.state.selection.main;
  const startLine = view.state.doc.lineAt(from);
  const endLine = view.state.doc.lineAt(to);
  const changes: { from: number; to: number; insert: string }[] = [];
  for (let n = startLine.number; n <= endLine.number; n++) {
    const line = view.state.doc.line(n);
    const has = line.text.startsWith(prefix);
    if (has) continue;
    changes.push({ from: line.from, to: line.from, insert: prefix });
  }
  if (changes.length) view.dispatch({ changes });
  view.focus();
}

/** 在光标位置插入一段文本（支持多行模板） */
export function insertBlock(
  template: string,
  options?: {
    atLineStart?: boolean;
    ensureBlankLines?: boolean;
    selectText?: string;
    cursorOffset?: number;
  },
) {
  const view = active;
  if (!view) return;
  const sel = view.state.selection.main;
  let from = sel.from;
  let to = sel.to;
  if (options?.atLineStart) {
    const startLine = view.state.doc.lineAt(sel.from);
    const endLine = view.state.doc.lineAt(sel.to);
    if (sel.empty) {
      from = startLine.from;
      to = startLine.text.trim() === "" ? startLine.to : startLine.from;
    } else {
      from = startLine.from;
      to = endLine.to;
    }
  }
  let insert = template;
  if (options?.ensureBlankLines) {
    const doc = view.state.doc;
    const body = template.replace(/^\n+|\n+$/g, "");
    const before = from > 0 ? doc.sliceString(Math.max(0, from - 2), from) : "";
    const after = to < doc.length ? doc.sliceString(to, Math.min(doc.length, to + 2)) : "";
    const needsLeadingBlank = from > 0 && !before.endsWith("\n\n");
    const needsTrailingBlank = to < doc.length && !after.startsWith("\n\n");
    insert = `${needsLeadingBlank ? "\n" : ""}${body}${needsTrailingBlank ? "\n" : ""}`;
  }
  view.dispatch({
    changes: { from, to, insert },
    selection: selectionForInsertedText(from, insert, options),
  });
  view.focus();
}

/** 取当前选区文本（用于 Bubble 菜单展示状态） */
export function selectedText(): string {
  const view = active;
  if (!view) return "";
  const { from, to } = view.state.selection.main;
  return view.state.sliceDoc(from, to);
}

/** 选区屏幕坐标（用于浮动菜单定位） */
export function selectionCoords(): { x: number; y: number } | null {
  const view = active;
  if (!view) return null;
  const sel = view.state.selection.main;
  const rect = view.coordsAtPos(sel.from);
  if (!rect) return null;
  return { x: rect.left, y: rect.top };
}

/** 把选区替换为指定文本（一般给 Slash 菜单用） */
export function replaceSelection(
  text: string,
  options?: { selectText?: string; cursorOffset?: number },
) {
  const view = active;
  if (!view) return;
  const sel = view.state.selection.main;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: text },
    selection: selectionForInsertedText(sel.from, text, options),
  });
  view.focus();
}

/** 替换指定文档范围；异步插入（如图片上传完成）会用到。 */
export function replaceRange(from: number, to: number, text: string) {
  const view = active;
  if (!view) return;
  const docLen = view.state.doc.length;
  const safeFrom = Math.max(0, Math.min(docLen, from));
  const safeTo = Math.max(safeFrom, Math.min(docLen, to));
  view.dispatch({
    changes: { from: safeFrom, to: safeTo, insert: text },
    selection: { anchor: safeFrom + text.length },
  });
  view.focus();
}

/** 从当前光标位置往左删除 n 个字符（用于 Slash 触发后吃掉 `/` 等） */
export function deleteBeforeCursor(n: number) {
  const view = active;
  if (!view) return;
  const head = view.state.selection.main.head;
  const from = Math.max(0, head - n);
  view.dispatch({
    changes: { from, to: head, insert: "" },
  });
  view.focus();
}

// ─── 块级（段落）操作：BlockMenu (P10b) 使用 ─────────────────────
// "块" 在 markdown 里没有严格定义，这里取最直观的：当前光标周围的"连续非空行"，
// 即段落。空行作为分隔符，不包含在块内。

/** 返回当前光标位置所在段落的 [from, to)（行号 1-based）。 */
export function currentBlockLineRange(): { fromLine: number; toLine: number } | null {
  const view = active;
  if (!view) return null;
  const doc = view.state.doc;
  const head = view.state.selection.main.head;
  const headLine = doc.lineAt(head).number;
  let fromLine = headLine;
  while (fromLine > 1) {
    const prev = doc.line(fromLine - 1);
    if (prev.text.trim() === "") break;
    fromLine -= 1;
  }
  let toLine = headLine;
  while (toLine < doc.lines) {
    const next = doc.line(toLine + 1);
    if (next.text.trim() === "") break;
    toLine += 1;
  }
  return { fromLine, toLine };
}

/** 返回当前块的字符区间（含末尾换行，便于做完整剪切 / 移动）。 */
export function currentBlockCharRange(): { from: number; to: number; text: string } | null {
  const view = active;
  if (!view) return null;
  const r = currentBlockLineRange();
  if (!r) return null;
  const doc = view.state.doc;
  const a = doc.line(r.fromLine);
  const b = doc.line(r.toLine);
  const text = doc.sliceString(a.from, b.to);
  return { from: a.from, to: b.to, text };
}

/** 把当前块和上一个块互换位置（中间空行保持原位）。 */
export function moveBlockUp(): boolean {
  const view = active;
  if (!view) return false;
  const cur = currentBlockLineRange();
  if (!cur || cur.fromLine <= 1) return false;
  const doc = view.state.doc;
  // 找上一个块的 toLine：cur.fromLine - 1 是空行，再往上找
  let prevToLine = cur.fromLine - 1;
  while (prevToLine >= 1 && doc.line(prevToLine).text.trim() === "") prevToLine -= 1;
  if (prevToLine < 1) return false;
  let prevFromLine = prevToLine;
  while (prevFromLine > 1) {
    const p = doc.line(prevFromLine - 1);
    if (p.text.trim() === "") break;
    prevFromLine -= 1;
  }
  const prevA = doc.line(prevFromLine);
  const prevB = doc.line(prevToLine);
  const curA = doc.line(cur.fromLine);
  const curB = doc.line(cur.toLine);
  const prevText = doc.sliceString(prevA.from, prevB.to);
  const curText = doc.sliceString(curA.from, curB.to);
  const between = doc.sliceString(prevB.to, curA.from);
  // 替换 [prevA.from, curB.to) 为 curText + between + prevText
  const newText = curText + between + prevText;
  const newCursor =
    prevA.from +
    Math.min(view.state.selection.main.head - curA.from, curText.length);
  view.dispatch({
    changes: { from: prevA.from, to: curB.to, insert: newText },
    selection: { anchor: newCursor },
  });
  view.focus();
  return true;
}

/** 把当前块和下一个块互换位置。 */
export function moveBlockDown(): boolean {
  const view = active;
  if (!view) return false;
  const cur = currentBlockLineRange();
  if (!cur) return false;
  const doc = view.state.doc;
  let nextFromLine = cur.toLine + 1;
  while (nextFromLine <= doc.lines && doc.line(nextFromLine).text.trim() === "") {
    nextFromLine += 1;
  }
  if (nextFromLine > doc.lines) return false;
  let nextToLine = nextFromLine;
  while (nextToLine < doc.lines) {
    const n = doc.line(nextToLine + 1);
    if (n.text.trim() === "") break;
    nextToLine += 1;
  }
  const curA = doc.line(cur.fromLine);
  const curB = doc.line(cur.toLine);
  const nextA = doc.line(nextFromLine);
  const nextB = doc.line(nextToLine);
  const curText = doc.sliceString(curA.from, curB.to);
  const nextText = doc.sliceString(nextA.from, nextB.to);
  const between = doc.sliceString(curB.to, nextA.from);
  const newText = nextText + between + curText;
  const head = view.state.selection.main.head;
  const offset = head - curA.from;
  const newCursor =
    curA.from + nextText.length + between.length + offset;
  view.dispatch({
    changes: { from: curA.from, to: nextB.to, insert: newText },
    selection: { anchor: newCursor },
  });
  view.focus();
  return true;
}

/** 删除当前块（连带后面的一个空行；位于文末则连带前面的空行）。 */
export function deleteCurrentBlock(): boolean {
  const view = active;
  if (!view) return false;
  const r = currentBlockLineRange();
  if (!r) return false;
  const doc = view.state.doc;
  const a = doc.line(r.fromLine);
  const b = doc.line(r.toLine);
  let from = a.from;
  let to = b.to;
  // 把块后的一个换行 + 可能的空行一起吃掉，保持文档不残留空行堆
  if (to < doc.length) {
    to = Math.min(doc.length, to + 1); // 吞 \n
    if (to < doc.length) {
      const nxt = doc.lineAt(to);
      if (nxt.text.trim() === "") {
        to = Math.min(doc.length, nxt.to + 1);
      }
    }
  } else if (from > 0) {
    // 文末块：往前吞一个换行
    from = Math.max(0, from - 1);
  }
  view.dispatch({
    changes: { from, to, insert: "" },
    selection: { anchor: from },
  });
  view.focus();
  return true;
}
