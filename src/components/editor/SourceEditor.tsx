import { memo, useEffect, useMemo, useRef, useState } from "react";
import CodeMirror, {
  type ReactCodeMirrorRef,
  EditorView,
} from "@uiw/react-codemirror";
import { EditorSelection, Prec } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { search, SearchQuery, setSearchQuery } from "@codemirror/search";
import { EditorView as CMView, keymap } from "@codemirror/view";
import { useSettings } from "@/stores/settings";
import { useUI } from "@/stores/ui";
import { registerEditor } from "@/lib/editor-bridge";
import { writeText } from "@/lib/clipboard";
import { markdownCommands } from "@/lib/markdown-commands";
import { parseImageMarkdown, type ImageParts } from "@/lib/markdown-images";
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
import { SCROLL_SYNC_VIEWPORT_RATIO } from "@/lib/scrollSync";
import { registerPane as registerScrollPane } from "@/lib/splitScrollSync";

interface Props {
  value: string;
  onChange: (v: string) => void;
  /** 行号跳转 / 全局搜索点击结果时用，单次目标。分屏滚动同步走 splitScrollSync 不经过这里。 */
  scrollTarget?: import("@/lib/scrollSync").ScrollTarget | null;
  /** 仅分屏模式启用源码 ↔ 预览滚动同步。 */
  syncScroll?: boolean;
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
  /** 非表格区域右键：把屏幕坐标 + 文档位置交给宿主。宿主总是会处理（屏蔽原生菜单）。 */
  onEditorContextMenu?: (info: {
    coords: { x: number; y: number };
    pos: number;
    image?: (ImageParts & { from: number; to: number }) | null;
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

const CODE_FENCE_SCAN_LIMIT_LINES = 800;

export const SourceEditor = memo(function SourceEditor({
  value,
  onChange,
  scrollTarget,
  onPasteImages,
  onSelectionChange,
  onTableContextMenu,
  onEditorContextMenu,
  onSlashTrigger,
  onAutocompleteUpdate,
  onMathContext,
  wysiwyg = false,
  syncScroll = false,
}: Props) {
  const fontSize = useSettings((s) => s.fontSize);
  const findQuery = useUI((s) => s.findQuery);
  const findIndex = useUI((s) => s.findIndex);
  const findCaseSensitive = useUI((s) => s.findCaseSensitive);
  const findWholeWord = useUI((s) => s.findWholeWord);
  const findRegex = useUI((s) => s.findRegex);
  const ref = useRef<ReactCodeMirrorRef>(null);
  const [view, setView] = useState<EditorView | null>(null);
  // 所有 callback prop 都锁进 ref，extensions useMemo 不依赖它们的身份。
  // 父组件 rerender / callback 重建不再触发 CodeMirror reconfigure（重建解析器 + 装饰链很贵）。
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onAutocompleteUpdateRef = useRef(onAutocompleteUpdate);
  const onMathContextRef = useRef(onMathContext);
  useEffect(() => {
    onSelectionChangeRef.current = onSelectionChange;
    onAutocompleteUpdateRef.current = onAutocompleteUpdate;
    onMathContextRef.current = onMathContext;
  }, [onSelectionChange, onAutocompleteUpdate, onMathContext]);
  const tableSelectionRectRef = useRef<TableSelectionRect | null>(null);
  // selectTableRect 自己会 dispatch 一个多格选区，期间置位以免被下面的
  // 「选区变化即清 rect」逻辑误清。
  const settingTableRectRef = useRef(false);
  const tableDragRef = useRef<{
    tableFrom: number;
    anchor: TableCellCoord;
  } | null>(null);

  const extensions = useMemo(
    () => [
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      search(),
      EditorView.lineWrapping,
      ...(wysiwyg ? [wysiwygMarkdown] : []),
      tableKeymap,
      markdownKeymap,
      listContinuationKeymap,
      smartQuotesHandler,
      mathInputHandler,
      EditorView.updateListener.of((u) => {
        if (u.docChanged) tableSelectionRectRef.current = null;
        // 键盘移动光标 / 点别处会改变选区，使之前点选的表格多格 rect 失效。
        // 必须在此清掉，否则随后的 Backspace/Delete 会按 stale rect 清空最初点选的
        // 那一格（甚至不是光标所在格）。selectTableRect 自身的 dispatch 用 ref 排除。
        else if (u.selectionSet && !settingTableRectRef.current) {
          tableSelectionRectRef.current = null;
        }
        const onSel = onSelectionChangeRef.current;
        if (u.selectionSet && onSel) {
          const sel = u.state.selection.main;
          const has = !sel.empty;
          let coords: { x: number; y: number } | null = null;
          if (has) {
            const r = u.view.coordsAtPos(sel.from);
            if (r) coords = { x: r.left, y: r.top };
          }
          onSel({ hasSelection: has, coords });
        }
        const onAc = onAutocompleteUpdateRef.current;
        if ((u.docChanged || u.selectionSet) && onAc) {
          // 这里之前用裸 return 提前退出，会把后面的 onMath 一并跳过，导致
          // MathPreview 悬浮框不被更新/关闭。改为在 IIFE 里算出补全态再交回，
          // 不影响外层 listener 继续执行 onMath。
          const acState = (() => {
            const sel = u.state.selection.main;
            if (!sel.empty) return null;
            const line = u.state.doc.lineAt(sel.head);
            const before = line.text.slice(0, sel.head - line.from);
            const triggers: Array<{
              kind: "wiki" | "mention" | "tag" | "emoji";
              re: RegExp;
              triggerLen: number;
            }> = [
              { kind: "wiki", re: /\[\[([\w一-鿿./ -]{0,40})$/, triggerLen: 2 },
              { kind: "mention", re: /(^|\s)@([\w一-鿿-]{0,30})$/, triggerLen: 1 },
              // 要求 # 后至少 1 个标签字符才触发，避免输入「# 标题」时一按 # 就弹出
              // 标签补全并劫持 Enter / 方向键。
              { kind: "tag", re: /(^|\s)#([\w一-鿿-]{1,30})$/, triggerLen: 1 },
              { kind: "emoji", re: /(^|\s):([\w-]{0,30})$/, triggerLen: 1 },
            ];
            for (const t of triggers) {
              const m = before.match(t.re);
              if (m) {
                const query = (m[2] ?? m[1] ?? "") as string;
                const r = u.view.coordsAtPos(sel.head);
                if (!r) return null;
                return {
                  kind: t.kind,
                  query,
                  triggerLen: t.triggerLen,
                  coords: { x: r.left, y: r.bottom },
                };
              }
            }
            return null;
          })();
          onAc(acState);
        }
        const onMath = onMathContextRef.current;
        if ((u.docChanged || u.selectionSet) && onMath) {
          onMath(getMathContext(u.view));
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
    // 仅在真正影响 CodeMirror 配置的字段变化时重建（fontSize 影响 theme、wysiwyg 切扩展集合）
    // callbacks 走 ref，不进依赖——光标移动 / 父组件 rerender 不再触发 reconfigure
    [fontSize, wysiwyg],
  );

  useEffect(() => {
    if (!view) return;
    registerEditor(view);
    return () => registerEditor(null);
  }, [view]);

  // 源码侧滚动通过 splitScrollSync 单例总线驱动：注册「读取 / 写入视口
  // 参考点源码行号」的能力，由总线在另一端 scroll 触发时直接命令式写过来。
  useEffect(() => {
    if (!view || !syncScroll) {
      registerScrollPane("source", null);
      return;
    }
    const outerScroll = view.scrollDOM.closest<HTMLElement>(".editor-pane");
    const scrollElements = [view.scrollDOM, outerScroll].filter(
      (el): el is HTMLElement => !!el,
    );
    const ratioFor = (el: HTMLElement) => {
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      return max <= 0 ? null : el.scrollTop / max;
    };
    const bestRatio = () => {
      const ratios = scrollElements
        .map(ratioFor)
        .filter((ratio): ratio is number => ratio != null && Number.isFinite(ratio));
      if (ratios.length === 0) return 0;
      return Math.max(...ratios);
    };
    const applyRatio = (ratio: number) => {
      const clamped = Math.max(0, Math.min(1, ratio));
      for (const el of scrollElements) {
        const max = Math.max(0, el.scrollHeight - el.clientHeight);
        if (max <= 0) continue;
        const next = max * clamped;
        if (Math.abs(el.scrollTop - next) < 1) continue;
        el.scrollTop = next;
      }
    };
    registerScrollPane("source", {
      el: view.scrollDOM,
      eventEls: outerScroll ? [outerScroll] : undefined,
      getTopLine: (eventEl) => {
        try {
          const visualEl =
            eventEl && (eventEl === view.scrollDOM || eventEl === outerScroll)
              ? eventEl
              : outerScroll ?? view.scrollDOM;
          const visualRect = visualEl.getBoundingClientRect();
          const probeY =
            visualRect.top + visualEl.clientHeight * SCROLL_SYNC_VIEWPORT_RATIO;
          const contentRect = view.contentDOM.getBoundingClientRect();
          const probeX = contentRect.left + 24;
          const pos = view.posAtCoords({ x: probeX, y: probeY });
          if (pos != null) {
            const line = view.state.doc.lineAt(pos);
            return line.number;
          }
          const probeTop =
            view.scrollDOM.scrollTop +
            view.scrollDOM.clientHeight * SCROLL_SYNC_VIEWPORT_RATIO;
          const blocks = view.viewportLineBlocks;
          const block =
            blocks.find((b) => b.top + b.height >= probeTop + 1) ??
            blocks[blocks.length - 1] ??
            blocks[0];
          if (!block) return null;
          const line = view.state.doc.lineAt(block.from);
          const within =
            block.height > 0
              ? Math.max(0, Math.min(1, (probeTop - block.top) / block.height))
              : 0;
          return line.number + within;
        } catch {
          return null;
        }
      },
      setTopLine: (line) => {
        const el = view.scrollDOM;
        const lineNo = Math.max(
          1,
          Math.min(view.state.doc.lines, Math.floor(line)),
        );
        const docLine = view.state.doc.line(lineNo);
        view.dispatch({
          effects: EditorView.scrollIntoView(docLine.from, { y: "center" }),
        });
        const frac = Math.max(0, line - lineNo);
        const applyTarget = () => {
          try {
            const block = view.lineBlockAt(docLine.from);
            const target =
              block.top +
              frac * block.height -
              el.clientHeight * SCROLL_SYNC_VIEWPORT_RATIO;
            const max = Math.max(0, el.scrollHeight - el.clientHeight);
            const next = Math.max(0, Math.min(max, target));
            if (Number.isFinite(next) && Math.abs(el.scrollTop - next) >= 1) {
              el.scrollTop = next;
            }
          } catch {
            // The scrollIntoView dispatch above is still a valid coarse target.
          }
        };
        applyTarget();
        window.requestAnimationFrame(applyTarget);
        return true;
      },
      getRatio: () => {
        return bestRatio();
      },
      setRatio: (ratio) => {
        applyRatio(ratio);
      },
    });
    return () => registerScrollPane("source", null);
  }, [view, syncScroll]);

  useEffect(() => {
    if (!view) return;
    const query = new SearchQuery({
      search: findQuery,
      caseSensitive: findCaseSensitive,
      regexp: findRegex,
      wholeWord: findWholeWord,
    });
    view.dispatch({ effects: setSearchQuery.of(query) });
  }, [view, findQuery, findCaseSensitive, findRegex, findWholeWord]);

  useEffect(() => {
    if (!view || !findQuery) return;
    const query = new SearchQuery({
      search: findQuery,
      caseSensitive: findCaseSensitive,
      regexp: findRegex,
      wholeWord: findWholeWord,
    });
    if (!query.valid) return;
    let match: { from: number; to: number } | null = null;
    let i = 0;
    const cursor = query.getCursor(view.state);
    for (let next = cursor.next(); !next.done; next = cursor.next()) {
      if (i === findIndex) {
        match = next.value;
        break;
      }
      i++;
    }
    if (!match) return;
    view.dispatch({
      selection: EditorSelection.single(match.from, match.to),
      effects: EditorView.scrollIntoView(match.from, { y: "center" }),
    });
  }, [view, findQuery, findIndex, findCaseSensitive, findRegex, findWholeWord]);

  // 应用同步对端写过来的目标位置：优先 line（行锁定，对长代码块/公式更准），
  // 没有 line 时退化到 ratio（百分比）兜底。
  useEffect(() => {
    if (!view || !scrollTarget) return;
    const el = view.scrollDOM;
    let next: number | null = null;
    if (typeof scrollTarget.line === "number") {
      const lineNo = Math.max(
        1,
        Math.min(view.state.doc.lines, Math.floor(scrollTarget.line)),
      );
      const line = view.state.doc.line(lineNo);
      const block = view.lineBlockAt(line.from);
      const frac = scrollTarget.line - lineNo;
      next = block.top + (frac > 0 ? frac * block.height : 0);
    } else if (typeof scrollTarget.ratio === "number") {
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      next = max * Math.max(0, Math.min(1, scrollTarget.ratio));
    }
    if (next == null) return;
    if (Math.abs(el.scrollTop - next) < 1) return;
    // lineJump 一次性写源码 scrollTop；分屏总线会捕获这次 scroll 并按"源码视口顶
    // 部对应行号"同步预览侧，正是我们想要的（跳到第 N 行 → 预览也滚到第 N 行）
    el.scrollTop = next;
  }, [view, scrollTarget]);

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

  // 代码块 / 表格 widget 内的编辑 textarea 被聚焦时，点别处常常没法把焦点 / 选区
  // 移出去：很多 widget 的 mousedown 调了 preventDefault，浏览器默认的「换焦点」被
  // 拦掉，textarea 一直保持 focus + 选区，于是「选中代码块内容后点外面移不出去」。
  // 这里用捕获阶段的全局 mousedown（早于 widget 的 stopPropagation）：只要点到了
  // 当前编辑 textarea 之外，就主动 blur 它（blur 会 commit 内容并释放选区）。
  useEffect(() => {
    if (!view) return;
    const onDownCapture = (e: MouseEvent) => {
      const active = document.activeElement as HTMLElement | null;
      if (!active?.matches?.(".cm-md-code-editor, .cm-md-table-cell")) return;
      const target = e.target as Node | null;
      if (target && (active === target || active.contains(target))) return;
      active.blur();
    };
    document.addEventListener("mousedown", onDownCapture, true);
    return () => document.removeEventListener("mousedown", onDownCapture, true);
  }, [view]);

  useEffect(() => {
    if (!view) return;

    // 记录当前挂在 window 上的拖选监听，effect 重跑 / 卸载时一并清理，避免悬空监听泄漏
    let activeDragListeners: { move: (e: MouseEvent) => void; up: () => void } | null = null;
    const clearDragListeners = (move: (e: MouseEvent) => void, up: () => void) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      activeDragListeners = null;
    };

    const handleMouseDown = (e: MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const target =
        e.target instanceof HTMLElement ? e.target : e.target instanceof Node ? e.target.parentElement : null;
      if (target?.closest(".cm-gutters")) return;
      if (target?.closest(".cm-md-table-widget")) return;
      const hit = tableCellFromCoords(view, { x: e.clientX, y: e.clientY });
      if (!hit) {
        tableSelectionRectRef.current = null;
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      const anchor = { row: hit.row, col: hit.col };
      tableDragRef.current = { tableFrom: hit.info.from, anchor };
      settingTableRectRef.current = true;
      tableSelectionRectRef.current = selectTableRect(view, hit.info, anchor, anchor);
      settingTableRectRef.current = false;
      // preventDefault 拦掉了浏览器默认聚焦、stopPropagation 拦掉了 CM 自身的聚焦，
      // 这里必须主动聚焦，否则点表格格后键盘输入仍落在之前聚焦的元素上。
      view.focus();

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const active = tableDragRef.current;
        if (!active) return;
        const next = tableCellFromCoords(view, { x: moveEvent.clientX, y: moveEvent.clientY });
        if (!next || next.info.from !== active.tableFrom) return;
        moveEvent.preventDefault();
        settingTableRectRef.current = true;
        tableSelectionRectRef.current = selectTableRect(view, next.info, active.anchor, {
          row: next.row,
          col: next.col,
        });
        settingTableRectRef.current = false;
      };

      const handleMouseUp = () => {
        tableDragRef.current = null;
        clearDragListeners(handleMouseMove, handleMouseUp);
      };

      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
      activeDragListeners = { move: handleMouseMove, up: handleMouseUp };
    };

    const handleContextMenu = (e: MouseEvent) => {
      const target =
        e.target instanceof HTMLElement ? e.target : e.target instanceof Node ? e.target.parentElement : null;
      if (target?.closest(".cm-md-table-widget")) return;
      // 1) 表格 cell 优先
      const hit = onTableContextMenu
        ? tableCellFromCoords(view, { x: e.clientX, y: e.clientY })
        : null;
      if (!hit) {
        tableSelectionRectRef.current = null;
        // 2) 非表格区域：必须屏蔽浏览器原生菜单，由宿主决定弹什么自定义菜单
        e.preventDefault();
        e.stopPropagation();
        if (onEditorContextMenu) {
          const pos =
            view.posAtCoords({ x: e.clientX, y: e.clientY }) ??
            view.state.selection.main.head;
          let image: (ImageParts & { from: number; to: number }) | null = null;
          const imageHost = target?.closest<HTMLElement>(".cm-md-img-widget");
          if (imageHost) {
            const from = view.posAtDOM(imageHost);
            const len = Number(imageHost.dataset.sourceLength);
            if (from != null && Number.isFinite(len) && len > 0) {
              const to = Math.min(view.state.doc.length, from + len);
              const parts = parseImageMarkdown(view.state.sliceDoc(from, to));
              if (parts) image = { ...parts, from, to };
            }
          }
          onEditorContextMenu({
            coords: { x: e.clientX, y: e.clientY },
            pos,
            image,
          });
        }
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
      if (activeDragListeners) {
        clearDragListeners(activeDragListeners.move, activeDragListeners.up);
      }
    };
  }, [view, onTableContextMenu, onEditorContextMenu]);

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
  const firstLine = Math.max(1, line.number - CODE_FENCE_SCAN_LIMIT_LINES);
  for (let n = firstLine; n < line.number; n++) {
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
    // 「上一个字符是字母数字/中文」→ 闭合；否则开。注意不要把 \p{P}（所有标点）
    // 当成闭合上下文——否则在 ( / ： / ， 之后会得到错误的闭引号（这些恰恰是该用开
    // 引号的位置，如 他说：" → 他说：“）。
    const closing = /[\p{L}\p{N}]/u.test(prevCh);
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
    // 代码围栏 / 行内代码 / 链接 URL 里不自动补 `$`，否则在 ```bash 里打 $HOME
    // 会变成 $HOME$。
    if (isInsideCodeOrUrl(view, from)) return false;
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
        if (rest!.trim().length === 0) {
          view.dispatch({
            changes: { from: line.from, to: line.to, insert: indent },
            selection: { anchor: line.from + indent!.length },
            userEvent: "delete.selection",
          });
          return true;
        }
        const nextMarker =
          /^\d+\./.test(marker!)
            ? `${parseInt(marker!, 10) + 1}.`
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
    { key: "Mod-Alt-5", run: runMarkdownCommand(markdownCommands.h5) },
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
