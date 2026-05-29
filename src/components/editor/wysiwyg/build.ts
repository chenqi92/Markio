/**
 * 整文档 decoration 重建。
 *
 * 调用时机：StateField.update 检测到 docChanged，或选区跨越了某个 widget
 * 的 cursor-sensitive 边界（参考 anySensitiveRangeFlipped）。其它选区变化
 * 走 fast-path 不重建。
 *
 * 性能模型：单次 build = 一次 doc.toString + math/wikilink 两次 regex 全扫 +
 * 一次 syntaxTree.iterate 整树遍历。lezer 增量解析对几千行只需要几 ms；
 * 几万行的大文档主要瓶颈在 syntaxTree iterate + WidgetType 实例化次数。
 */

import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { Decoration, type DecorationSet } from "@codemirror/view";

import { detectMathRanges } from "@/lib/math-ranges";

import { CodeFenceWidget } from "./codeFence";
import { FrontmatterWidget, parseFrontmatter } from "./frontmatter";
import {
  CalloutLabelWidget,
  HrWidget,
  ImageWidget,
  ListMarkerWidget,
  TableSepWidget,
  TaskCheckbox,
  isAbsoluteSafeUrl,
  normalizeCalloutType,
} from "./inlineWidgets";
import { MathWidget } from "./math";
import { TableWidget } from "./table";
import {
  VisualFenceWidget,
  WYSIWYG_VISUAL_FENCES_ENABLED,
  detectVisualLang,
} from "./visualFence";
import {
  WikilinkWidget,
  currentVaultFiles,
  detectWikilinks,
} from "./wikilink";
import { parseImageMarkdown } from "@/lib/markdown-images";

interface PendingDeco {
  from: number;
  to: number;
  deco: Decoration;
}

export interface BuildResult {
  decorations: DecorationSet;
  /** 隐藏掉的 marker 字符范围，给 EditorView.atomicRanges 用 ——
   *  防止鼠标拖动选区时光标"落进"被隐藏的字符里、导致选区视觉上溢出到下方行 */
  atomic: DecorationSet;
  /** 受光标位置影响是否展示 widget 的所有判定范围。selection-only 的 tr 触发
   *  rebuild 时，先按这些范围在新旧选区下的命中变化判断；任何一个翻转才 rebuild，
   *  否则直接复用上次结果，避免大文档每次方向键 / 鼠标选中都跑全文 syntaxTree。 */
  sensitive: SensitiveRange[];
}

export interface SensitiveRange {
  from: number;
  to: number;
  inclusive: boolean;
}

/** rangeHasCursor 的内核：把判断从 EditorState 解耦到 EditorSelection，
 *  让 fast-path 在 update() 里跨 prev / current selection 重放。 */
export function selectionHitsRange(
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
export function anySensitiveRangeFlipped(
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

/**
 * YAML frontmatter 区间：文档以 `---\n` 开头 + 后续某行单独 `---` 结束。
 * 返回 frontmatter 结束后第一个字符的 offset；不存在时返回 0。
 *
 * 用途：lezer 把 `---` 解析为 HorizontalRule，没有 frontmatter 节点；如果
 * 不显式排除，文档头部和 `---` 闭合行都会被替换成 HR widget。
 */
function frontmatterEnd(text: string): number {
  if (!text.startsWith("---")) return 0;
  // 第一行必须就是 `---`（允许尾随 \r）
  const firstEol = text.indexOf("\n");
  if (firstEol < 0) return 0;
  const firstLine = text.slice(0, firstEol).trimEnd();
  if (firstLine !== "---") return 0;
  // 后续找一行只含 `---` 的关闭 delimiter
  let i = firstEol + 1;
  while (i < text.length) {
    const eol = text.indexOf("\n", i);
    const line = text.slice(i, eol < 0 ? text.length : eol).trimEnd();
    if (line === "---") {
      return eol < 0 ? text.length : eol + 1;
    }
    if (eol < 0) return 0;
    i = eol + 1;
  }
  return 0;
}

export function build(state: EditorState): BuildResult {
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
  const fmEnd = frontmatterEnd(docText);

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
  // 始终渲染为 widget（单击打开笔记，悬浮出现 ✎ 进编辑浮层），不再光标显形原文。
  const wikilinkRanges = detectWikilinks(docText, currentVaultFiles());
  for (const info of wikilinkRanges) {
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

  // ─── YAML frontmatter ───
  // 渲染成就地可编辑的属性表（始终渲染，不退回原始块）。仅当 YAML 能被干净
  // 解析时才上 widget——否则退回原始文本编辑，避免就地编辑丢数据。
  // 无论哪种都跳过区间内的 lezer 节点（见 enter 开头的 guard），避免
  // `- 脚本` 被当成无序列表、`title:` 被当成裸段落。
  if (fmEnd > 0) {
    const source = docText.slice(0, fmEnd);
    const fm = parseFrontmatter(source);
    if (fm.ok && fm.props.length > 0) {
      decos.push({
        from: 0,
        to: fmEnd,
        deco: Decoration.replace({
          widget: new FrontmatterWidget(source),
          block: true,
        }),
      });
      atomic.push({ from: 0, to: fmEnd, deco: Decoration.mark({}) });
    } else {
      markLines(0, fmEnd, "cm-md-line cm-md-frontmatter-line");
    }
  }

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

      // frontmatter 区间整体由上面的 widget / line-mark 接管，跳过**完全落在**
      // 区间内的 lezer 节点（含被误判成 Hr / ListItem / ListMark 的 `---` 与
      // `- x`）。注意必须判 node.to <= fmEnd：文档根节点 from=0 也 < fmEnd，
      // 若只判 from 会把整棵树（含正文）一并跳过，导致正文完全不渲染。
      if (fmEnd > 0 && node.to <= fmEnd) return false;

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
        // YAML frontmatter 的开 / 闭 `---` 不当 HR 渲染 —— 否则首行变成横线、
        // 中间 YAML 字段悬空，整个 frontmatter 块视觉错乱
        if (node.from < fmEnd) return;
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
        // 始终渲染图片 widget（点击进编辑浮层），不再光标显形 markdown 源码。
        if (parts && isAbsoluteSafeUrl(parts.url)) {
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
          // 空 mermaid/dot/chart fence 仍要给 widget —— 否则用户看到的是源码
          // `\`\`\`mermaid` 加几行 codeblock 样式，没法走 widget 的编辑入口
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
