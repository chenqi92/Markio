import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import CodeMirror, {
  type ReactCodeMirrorRef,
  EditorView,
} from "@uiw/react-codemirror";
import { Prec } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { EditorView as CMView, keymap } from "@codemirror/view";
import { useSettings } from "@/stores/settings";
import { registerEditor } from "@/lib/editor-bridge";
import { writeText } from "@/lib/clipboard";
import { markdownCommands } from "@/lib/markdown-commands";
import {
  clearTableRect,
  moveTableCell,
  pasteTableText,
  selectTableRect,
  tableCellFromCoords,
  tableRectClipboardText,
  type TableCellCoord,
  type TableSelectionRect,
} from "./table-edit";
import { wysiwygMarkdown } from "./wysiwyg";
import { getMathContext, type MathContext } from "@/lib/math-context";

interface Props {
  value: string;
  onChange: (v: string) => void;
  onScroll?: (info: {
    top: number;
    height: number;
    clientHeight: number;
  }) => void;
  scrollTarget?: {
    ratio: number;
    nonce: number;
  } | null;
  onPasteImages?: (
    files: File[],
    range: { from: number; to: number },
  ) => void | Promise<void>;
  onSelectionChange?: (info: {
    hasSelection: boolean;
    coords: { x: number; y: number } | null;
  }) => void;
  onTableContextMenu?: (info: {
    coords: { x: number; y: number };
    row: number;
    col: number;
    rows: number;
    cols: number;
    rect: TableSelectionRect | null;
  }) => void;
  onSlashTrigger?: (coords: { x: number; y: number }) => void;
  onAutocompleteUpdate?: (
    state:
      | {
          kind: "wiki" | "mention" | "tag" | "emoji";
          query: string;
          triggerLen: number;
          coords: { x: number; y: number };
        }
      | null,
  ) => void;
  /** 光标进入 / 离开 $...$ / $$...$$ 公式块；用于 KaTeX 实时预览 */
  onMathContext?: (ctx: MathContext | null) => void;
  /** 是否启用 WYSIWYG 装饰（隐藏 markdown 标记 + 行级样式） */
  wysiwyg?: boolean;
}

export const SourceEditor = memo(function SourceEditor({
  value,
  onChange,
  onScroll,
  scrollTarget,
  onPasteImages,
  onSelectionChange,
  onTableContextMenu,
  onSlashTrigger,
  onAutocompleteUpdate,
  onMathContext,
  wysiwyg = false,
}: Props) {
  const fontSize = useSettings((s) => s.fontSize);
  const ref = useRef<ReactCodeMirrorRef>(null);
  const [view, setView] = useState<EditorView | null>(null);
  const suppressScrollRef = useRef(false);
  // 把最新的 onScroll 锁进 ref，给 CodeMirror 扩展里注册的 listener 用
  // —— 否则 listener 闭包会捕获最初的 onScroll，无法响应后续 callback 身份变化
  const onScrollRef = useRef(onScroll);
  useEffect(() => {
    onScrollRef.current = onScroll;
  }, [onScroll]);
  const tableSelectionRectRef = useRef<TableSelectionRect | null>(null);
  const tableDragRef = useRef<{
    tableFrom: number;
    anchor: TableCellCoord;
  } | null>(null);

  const extensions = useMemo(
    () => [
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      EditorView.lineWrapping,
      ...(wysiwyg ? [wysiwygMarkdown] : []),
      tableKeymap,
      markdownKeymap,
      listContinuationKeymap,
      smartQuotesHandler,
      mathInputHandler,
      // 用 CodeMirror 自己的 domEventHandlers 注册 scroll —— 它内部会把 handler
      // 挂到正确的 scrollDOM/scroller 上（用 React useEffect 的 [view] 依赖在某些
      // 渲染时序下不一定能正确触发重绑）
      EditorView.domEventHandlers({
        scroll(_event, v) {
          if (suppressScrollRef.current) return;
          const fn = onScrollRef.current;
          if (!fn) return;
          const el = v.scrollDOM;
          fn({
            top: el.scrollTop,
            height: el.scrollHeight,
            clientHeight: el.clientHeight,
          });
        },
      }),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) tableSelectionRectRef.current = null;
        if (u.selectionSet && onSelectionChange) {
          const sel = u.state.selection.main;
          const has = !sel.empty;
          let coords: { x: number; y: number } | null = null;
          if (has) {
            const r = u.view.coordsAtPos(sel.from);
            if (r) coords = { x: r.left, y: r.top };
          }
          onSelectionChange({ hasSelection: has, coords });
        }
        if ((u.docChanged || u.selectionSet) && onAutocompleteUpdate) {
          const sel = u.state.selection.main;
          if (!sel.empty) {
            onAutocompleteUpdate(null);
            return;
          }
          const line = u.state.doc.lineAt(sel.head);
          const before = line.text.slice(0, sel.head - line.from);
          // 探测最近一次触发
          const triggers: Array<{
            kind: "wiki" | "mention" | "tag" | "emoji";
            re: RegExp;
            triggerLen: number;
          }> = [
            { kind: "wiki", re: /\[\[([\w一-鿿\-\.\/ ]{0,40})$/, triggerLen: 2 },
            { kind: "mention", re: /(^|\s)@([\w一-鿿\-]{0,30})$/, triggerLen: 1 },
            { kind: "tag", re: /(^|\s)#([\w一-鿿\-]{0,30})$/, triggerLen: 1 },
            { kind: "emoji", re: /(^|\s):([\w\-]{0,30})$/, triggerLen: 1 },
          ];
          for (const t of triggers) {
            const m = before.match(t.re);
            if (m) {
              const query = (m[2] ?? m[1] ?? "") as string;
              const r = u.view.coordsAtPos(sel.head);
              if (!r) {
                onAutocompleteUpdate(null);
                return;
              }
              onAutocompleteUpdate({
                kind: t.kind,
                query,
                triggerLen: t.triggerLen,
                coords: { x: r.left, y: r.bottom },
              });
              return;
            }
          }
          onAutocompleteUpdate(null);
        }
        if ((u.docChanged || u.selectionSet) && onMathContext) {
          onMathContext(getMathContext(u.view));
        }
      }),
      CMView.theme(
        {
          "&": { height: "100%", backgroundColor: "transparent" },
          ".cm-scroller": {
            fontFamily: "var(--font-mono)",
            fontSize: `${fontSize - 2}px`,
            lineHeight: "1.7",
            cursor: "text",
          },
          ".cm-content": { cursor: "text" },
          ".cm-line": { cursor: "text" },
          ".cm-gutters": { cursor: "default" },
          ".cm-gutterElement": { cursor: "default" },
        },
        { dark: false },
      ),
    ],
    [fontSize, onSelectionChange, onAutocompleteUpdate, onMathContext, wysiwyg],
  );

  useEffect(() => {
    if (!view) return;
    registerEditor(view);
    return () => registerEditor(null);
  }, [view]);

  // 应用同步对端写过来的目标比例
  useEffect(() => {
    if (!view || !scrollTarget) return;
    const el = view.scrollDOM;
    const max = Math.max(0, el.scrollHeight - el.clientHeight);
    const next = max * Math.max(0, Math.min(1, scrollTarget.ratio));
    if (Math.abs(el.scrollTop - next) < 1) return;
    suppressScrollRef.current = true;
    el.scrollTop = next;
    requestAnimationFrame(() => {
      suppressScrollRef.current = false;
    });
  }, [view, scrollTarget?.nonce, scrollTarget?.ratio]);

  useEffect(() => {
    if (!view) return;
    const pasteHandler = (e: ClipboardEvent) => {
      const data = e.clipboardData;
      if (!data) return;
      const fromItems = Array.from(data.items ?? [])
        .filter((item) => item.type.startsWith("image/"))
        .map((item) => item.getAsFile())
        .filter((file): file is File => !!file);
      const fromFiles = Array.from(data.files ?? []).filter((file) =>
        file.type.startsWith("image/"),
      );
      const files = fromItems.length > 0 ? fromItems : fromFiles;
      if (files.length > 0 && onPasteImages) {
        e.preventDefault();
        e.stopPropagation();
        const sel = view.state.selection.main;
        void onPasteImages(files, { from: sel.from, to: sel.to });
        return;
      }
      const text = data.getData("text/plain");
      const rect = tableSelectionRectRef.current;
      const start = rect ? { row: rect.startRow, col: rect.startCol } : undefined;
      if (text && pasteTableText(view, text, start)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const copyHandler = (e: ClipboardEvent) => {
      const rect = tableSelectionRectRef.current;
      if (!rect) return;
      const text = tableRectClipboardText(view, rect);
      if (text == null) return;
      e.preventDefault();
      e.stopPropagation();
      e.clipboardData?.setData("text/plain", text);
      void writeText(text).catch(() => undefined);
    };
    const cutHandler = (e: ClipboardEvent) => {
      const rect = tableSelectionRectRef.current;
      if (!rect) return;
      const text = tableRectClipboardText(view, rect);
      if (text == null) return;
      e.preventDefault();
      e.stopPropagation();
      e.clipboardData?.setData("text/plain", text);
      void writeText(text).catch(() => undefined);
      clearTableRect(view, rect);
      tableSelectionRectRef.current = null;
    };
    view.contentDOM.addEventListener("paste", pasteHandler);
    view.contentDOM.addEventListener("copy", copyHandler);
    view.contentDOM.addEventListener("cut", cutHandler);
    return () => {
      view.contentDOM.removeEventListener("paste", pasteHandler);
      view.contentDOM.removeEventListener("copy", copyHandler);
      view.contentDOM.removeEventListener("cut", cutHandler);
    };
  }, [view, onPasteImages]);

  useEffect(() => {
    if (!view) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const rect = tableSelectionRectRef.current;
      if (!rect) return;
      e.preventDefault();
      e.stopPropagation();
      clearTableRect(view, rect);
      tableSelectionRectRef.current = null;
      view.focus();
    };
    view.contentDOM.addEventListener("keydown", handler, true);
    return () => view.contentDOM.removeEventListener("keydown", handler, true);
  }, [view]);

  useEffect(() => {
    if (!view) return;

    const clearDragListeners = (move: (e: MouseEvent) => void, up: () => void) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };

    const handleMouseDown = (e: MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest(".cm-gutters")) return;
      const hit = tableCellFromCoords(view, { x: e.clientX, y: e.clientY });
      if (!hit) {
        tableSelectionRectRef.current = null;
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      const anchor = { row: hit.row, col: hit.col };
      tableDragRef.current = { tableFrom: hit.info.from, anchor };
      tableSelectionRectRef.current = selectTableRect(view, hit.info, anchor, anchor);

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const active = tableDragRef.current;
        if (!active) return;
        const next = tableCellFromCoords(view, { x: moveEvent.clientX, y: moveEvent.clientY });
        if (!next || next.info.from !== active.tableFrom) return;
        moveEvent.preventDefault();
        tableSelectionRectRef.current = selectTableRect(view, next.info, active.anchor, {
          row: next.row,
          col: next.col,
        });
      };

      const handleMouseUp = () => {
        tableDragRef.current = null;
        clearDragListeners(handleMouseMove, handleMouseUp);
      };

      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    };

    const handleContextMenu = (e: MouseEvent) => {
      if (!onTableContextMenu) return;
      const hit = tableCellFromCoords(view, { x: e.clientX, y: e.clientY });
      if (!hit) {
        tableSelectionRectRef.current = null;
        return;
      }
      e.preventDefault();
      e.stopPropagation();

      const current = tableSelectionRectRef.current;
      const insideCurrent =
        current &&
        current.tableFrom === hit.info.from &&
        hit.row >= current.startRow &&
        hit.row <= current.endRow &&
        hit.col >= current.startCol &&
        hit.col <= current.endCol;
      const rect =
        insideCurrent
          ? current
          : selectTableRect(view, hit.info, { row: hit.row, col: hit.col }, { row: hit.row, col: hit.col });
      tableSelectionRectRef.current = rect;
      onTableContextMenu?.({
        coords: { x: e.clientX, y: e.clientY },
        row: hit.row,
        col: hit.col,
        rows: hit.info.cells.length,
        cols: hit.info.aligns.length,
        rect,
      });
    };

    view.contentDOM.addEventListener("mousedown", handleMouseDown, true);
    view.contentDOM.addEventListener("contextmenu", handleContextMenu, true);
    return () => {
      view.contentDOM.removeEventListener("mousedown", handleMouseDown, true);
      view.contentDOM.removeEventListener("contextmenu", handleContextMenu, true);
    };
  }, [view, onTableContextMenu]);

  // 监听 `/` 触发斜杠菜单
  useEffect(() => {
    if (!view || !onSlashTrigger) return;
    const el = view.scrollDOM;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // 等输入应用一帧后再读取光标坐标
        requestAnimationFrame(() => {
          const cur = view.state.selection.main;
          const line = view.state.doc.lineAt(cur.head);
          // 仅当 `/` 在行首或行内仅紧贴前导空白后触发
          const prefix = line.text.slice(0, cur.head - line.from);
          if (!/^\s*\/$/.test(prefix)) return;
          const r = view.coordsAtPos(cur.head);
          if (!r) return;
          onSlashTrigger({ x: r.left, y: r.bottom });
        });
      }
    };
    el.addEventListener("keydown", handler);
    return () => el.removeEventListener("keydown", handler);
  }, [view, onSlashTrigger]);

  return (
    <div
      className="cm-host"
      style={{ height: "100%" }}
      data-mode={wysiwyg ? "wysiwyg" : "source"}
    >
      <CodeMirror
        ref={ref}
        value={value}
        height="100%"
        theme="none"
        extensions={extensions}
        basicSetup={{
          lineNumbers: !wysiwyg,
          foldGutter: !wysiwyg,
          highlightActiveLine: true,
          highlightActiveLineGutter: !wysiwyg,
          autocompletion: false,
          bracketMatching: true,
          closeBrackets: true,
        }}
        onCreateEditor={(v) => setView(v)}
        onChange={onChange}
      />
    </div>
  );
});

/** 是否处于围栏代码块 / 行内代码 / 链接 URL 中：跳过智能引号 */
function isInsideCodeOrUrl(view: EditorView, pos: number): boolean {
  const doc = view.state.doc;
  const line = doc.lineAt(pos);
  // 行内代码：行内已出现奇数个未闭合的反引号
  let inInline = false;
  for (let i = 0; i < pos - line.from; i++) {
    if (line.text[i] === "`") inInline = !inInline;
  }
  if (inInline) return true;
  // 围栏代码块：从文档头扫到此行，统计 ``` / ~~~ 切换
  let inFence = false;
  for (let n = 1; n < line.number; n++) {
    const t = doc.line(n).text;
    if (/^\s*(```|~~~)/.test(t)) inFence = !inFence;
  }
  if (inFence) return true;
  // markdown 链接 URL：粗略判断 (...) 内
  const before = line.text.slice(0, pos - line.from);
  const lastOpen = before.lastIndexOf("](");
  const lastClose = before.lastIndexOf(")");
  if (lastOpen > lastClose) return true;
  return false;
}

const smartQuotesHandler = EditorView.inputHandler.of(
  (view, from, to, text) => {
    if (!useSettings.getState().smartQuotes) return false;
    if (text !== '"' && text !== "'") return false;
    if (isInsideCodeOrUrl(view, from)) return false;
    const doc = view.state.doc;
    const prevCh = from > 0 ? doc.sliceString(from - 1, from) : "";
    // 「上一个字符是字母数字/中文」→ 闭合；否则开
    const closing = /[\p{L}\p{N}\p{P}]/u.test(prevCh);
    let insert: string;
    if (text === '"') insert = closing ? "”" : "“";
    else insert = closing ? "’" : "‘";
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length },
      userEvent: "input.type",
    });
    return true;
  },
);

/**
 * 输入 `$` 时自动补一个 `$`，光标停在中间；适配公式输入。
 * 已经在 `$...$` 内部、或行起始 `$$` → 不接管，让默认行为生效。
 */
const mathInputHandler = EditorView.inputHandler.of(
  (view, from, to, text) => {
    if (text !== "$") return false;
    const doc = view.state.doc;
    const prevCh = from > 0 ? doc.sliceString(from - 1, from) : "";
    const nextCh = to < doc.length ? doc.sliceString(to, to + 1) : "";
    // 紧跟在 `$` 之后 → 让用户继续打第二个 `$` 完成 display math
    if (prevCh === "$") return false;
    // 下一个字符已经是 `$` → 视为跳过闭合分隔符
    if (nextCh === "$") {
      view.dispatch({
        selection: { anchor: to + 1 },
        userEvent: "input.type",
      });
      return true;
    }
    // 默认：插入 `$$` 并把光标放中间
    view.dispatch({
      changes: { from, to, insert: "$$" },
      selection: { anchor: from + 1 },
      userEvent: "input.type",
    });
    return true;
  },
);

function runMarkdownCommand(command: () => void) {
  return () => {
    command();
    return true;
  };
}

/** Enter 在 - / * / + / 数字. / [ ] 行末时续标记；空 marker 则消除 marker */
const listContinuationKeymap = Prec.high(
  keymap.of([
    {
      key: "Enter",
      run: (view) => {
        if (!useSettings.getState().autoListContinuation) return false;
        const sel = view.state.selection.main;
        if (!sel.empty) return false;
        const line = view.state.doc.lineAt(sel.head);
        if (sel.head !== line.to) return false;
        const m = line.text.match(/^(\s*)([-*+]|\d+\.)\s+(\[[ xX]\]\s+)?(.*)$/);
        if (!m) return false;
        const [, indent, marker, task, rest] = m;
        // 若该 marker 行无内容（只剩 marker）→ 清掉 marker，光标停在原位
        if (rest.trim().length === 0) {
          view.dispatch({
            changes: { from: line.from, to: line.to, insert: indent },
            selection: { anchor: line.from + indent.length },
            userEvent: "delete.selection",
          });
          return true;
        }
        const nextMarker =
          /^\d+\./.test(marker)
            ? `${parseInt(marker, 10) + 1}.`
            : marker;
        const insert = `\n${indent}${nextMarker} ${task ?? ""}`;
        view.dispatch({
          changes: { from: sel.head, to: sel.head, insert },
          selection: { anchor: sel.head + insert.length },
          userEvent: "input.type",
        });
        return true;
      },
    },
  ]),
);

const tableKeymap = Prec.highest(
  keymap.of([
    { key: "Tab", run: (view) => moveTableCell(view, "next") },
    { key: "Shift-Tab", run: (view) => moveTableCell(view, "prev") },
    { key: "Enter", run: (view) => moveTableCell(view, "down") },
    { key: "Shift-Enter", run: (view) => moveTableCell(view, "up") },
  ]),
);

const markdownKeymap = Prec.highest(
  keymap.of([
    { key: "Mod-b", run: runMarkdownCommand(markdownCommands.bold) },
    { key: "Mod-i", run: runMarkdownCommand(markdownCommands.italic) },
    { key: "Mod-k", run: runMarkdownCommand(markdownCommands.link) },
    { key: "Mod-Shift-h", run: runMarkdownCommand(markdownCommands.mark) },
    { key: "Mod-Shift-x", run: runMarkdownCommand(markdownCommands.strike) },
    { key: "Mod-Alt-1", run: runMarkdownCommand(markdownCommands.h1) },
    { key: "Mod-Alt-2", run: runMarkdownCommand(markdownCommands.h2) },
    { key: "Mod-Alt-3", run: runMarkdownCommand(markdownCommands.h3) },
    { key: "Mod-Alt-4", run: runMarkdownCommand(markdownCommands.h4) },
    { key: "Mod-Alt-l", run: runMarkdownCommand(markdownCommands.wikiLink) },
    { key: "Mod-Alt-t", run: runMarkdownCommand(markdownCommands.table) },
    { key: "Mod-Alt-Shift-t", run: runMarkdownCommand(markdownCommands.selectionToTable) },
    { key: "Mod-Alt-c", run: runMarkdownCommand(markdownCommands.codeBlock) },
    { key: "Mod-Alt-m", run: runMarkdownCommand(markdownCommands.mathBlock) },
    { key: "Mod-Alt-g", run: runMarkdownCommand(markdownCommands.chart) },
    { key: "Mod-Alt-d", run: runMarkdownCommand(markdownCommands.graphviz) },
    { key: "Mod-Alt-u", run: runMarkdownCommand(markdownCommands.plantuml) },
  ]),
);
