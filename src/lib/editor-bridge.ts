/**
 * 编辑器桥接：让工具栏 / Bubble / Slash 等组件能直接驱动当前 CodeMirror 视图。
 *
 * SourceEditor 挂载时把 EditorView 注册进来，卸载时清理。
 * 外部组件用 `runEditorCommand` 包装的指令操作选区 / 插入文本。
 */
import type { EditorView } from "@codemirror/view";

let active: EditorView | null = null;
const listeners = new Set<() => void>();

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
export function insertBlock(template: string, options?: { atLineStart?: boolean }) {
  const view = active;
  if (!view) return;
  const sel = view.state.selection.main;
  let from = sel.from;
  if (options?.atLineStart) {
    const line = view.state.doc.lineAt(from);
    from = line.from;
  }
  view.dispatch({
    changes: { from, to: sel.to, insert: template },
    selection: { anchor: from + template.length },
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
export function replaceSelection(text: string) {
  const view = active;
  if (!view) return;
  const sel = view.state.selection.main;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: text },
    selection: { anchor: sel.from + text.length },
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
