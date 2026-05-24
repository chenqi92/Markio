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
} from "@codemirror/view";
import { cursorInsideRange, detectMathRanges } from "@/lib/math-ranges";
import { MathWidget } from "./wysiwyg/math";
import { CodeFenceWidget } from "./wysiwyg/codeFence";
import { eventElementTarget } from "./wysiwyg/util";
import {
  TableWidget,
  buildTableDom,
  parseTableSource,
  type ParsedTable,
  type WysiwygTableAction,
  applyWysiwygTableAction,
  buildTableSource,
} from "./wysiwyg/table";

// 兼容旧导入路径：tests / table-edit 通过 './wysiwyg' 直接拿这些 API
export {
  buildTableDom,
  parseTableSource,
  buildTableSource,
  applyWysiwygTableAction,
};
export type { ParsedTable, WysiwygTableAction };
import {
  CalloutLabelWidget,
  HrWidget,
  ImageWidget,
  ListMarkerWidget,
  TableSepWidget,
  TaskCheckbox,
  isAbsoluteSafeUrl,
  normalizeCalloutType,
} from "./wysiwyg/inlineWidgets";
import {
  WikilinkWidget,
  currentVaultFiles,
  detectWikilinks,
} from "./wysiwyg/wikilink";
import {
  VisualFenceWidget,
  WYSIWYG_VISUAL_FENCES_ENABLED,
  detectVisualLang,
} from "./wysiwyg/visualFence";
import { parseImageMarkdown } from "@/lib/markdown-images";
import { useTabs } from "@/stores/tabs";
import { useUI } from "@/stores/ui";

// MathWidget + getKatex + renderKatexInto 已迁移到 ./wysiwyg/math

// VisualFenceWidget + detectVisualLang 已迁移到 ./wysiwyg/visualFence


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


// ─── 模块迁移说明 ─────────────────────────────────────────────────────────
//
// 大部分 widget 类与配套 helpers 都拆到 ./wysiwyg/ 子目录：
// - math.ts          — MathWidget + KaTeX lazy
// - codeFence.ts     — CodeFenceWidget + 所有 fenced-code DOM 交互
// - visualFence.ts   — VisualFenceWidget (mermaid / dot / chart)
// - wikilink.ts      — WikilinkWidget + detectWikilinks
// - inlineWidgets.ts — ListMarker / CalloutLabel / Image / Task / Hr / TableSep
// - highlight.ts     — hljs lazy 子系统
// - table.ts         — TableWidget + 整套表格交互
// - util.ts          — Cleanup type + eventElementTarget
//
// 主文件留：build() + StateField + mousedown handler + parseImageMarkdown 转出口

export { parseImageMarkdown };

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

  // doc.toString() 是大文档（兆级笔记）的真正 cost；math / wikilink 两个
  // regex 扫共享同一份字符串，避免重复转换。
  const docText = state.doc.toString();

  // Math regions: detect once over the full doc (regex-only, no AST since
  // lezer-markdown has no math node by default). Skip the widget when the
  // cursor is inside so the user can edit the source plainly.
  const mathRanges = detectMathRanges(docText);
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
  const wikilinkRanges = detectWikilinks(docText, currentVaultFiles());
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
