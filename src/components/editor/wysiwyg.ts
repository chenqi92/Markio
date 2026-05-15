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
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";

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
    el.textContent = this.checked ? "✓" : "";
    el.setAttribute("aria-hidden", "true");
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
}

function build(view: EditorView): BuildResult {
  const decos: PendingDeco[] = [];
  const atomic: PendingDeco[] = [];

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
  let visibleTo = view.state.doc.length;

  /** 给一行加 class（标题 / 引用整行） */
  const lineMark = (pos: number, cls: string) => {
    if (pos < visibleFrom || pos > visibleTo) return;
    const line = view.state.doc.lineAt(pos);
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
    const startLine = view.state.doc.lineAt(fromPos).number;
    const endLine = view.state.doc.lineAt(toPos).number;
    for (let ln = startLine; ln <= endLine; ln++) {
      const line = view.state.doc.line(ln);
      decos.push({
        from: line.from,
        to: line.from,
        deco: Decoration.line({ class: cls }),
      });
    }
  };

  // 用一个简单的 "active block" 栈，标记当前在哪种节点里，给行内 marker 分类
  const tree = syntaxTree(view.state);
  const ranges =
    view.visibleRanges.length > 0
      ? view.visibleRanges
      : [{ from: 0, to: view.state.doc.length }];
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

      // ─── 引用 ───
      if (n === "Blockquote") {
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
        const after = view.state.doc.sliceString(node.to, node.to + 1);
        const to = after === " " ? node.to + 1 : node.to;
        hide(node.from, to);
        return;
      }

      // ─── 表格 ───
      if (n === "Table") {
        markLines(node.from, node.to, "cm-md-line cm-md-table-line");
        return;
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
        const line = view.state.doc.lineAt(node.from);
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
        const after = view.state.doc.sliceString(node.to, node.to + 1);
        const to = after === " " ? node.to + 1 : node.to;
        hide(node.from, to);
        return;
      }
      if (n === "QuoteMark") {
        const after = view.state.doc.sliceString(node.to, node.to + 1);
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
        mark(node.from, node.to, "cm-md-image");
        return;
      }

      // ─── 任务列表 ───
      if (n === "TaskMarker") {
        const text = view.state.doc.sliceString(node.from, node.to);
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
      if (n === "FencedCode" || n === "CodeBlock") {
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
  };
}

class WysiwygPlugin {
  decorations: DecorationSet;
  atomic: DecorationSet;
  constructor(view: EditorView) {
    const r = build(view);
    this.decorations = r.decorations;
    this.atomic = r.atomic;
  }
  update(u: ViewUpdate) {
    // 装饰不再随 selection 变化（保持视觉稳定），只在文档 / 视口变化时重建
    if (u.docChanged || u.viewportChanged) {
      const r = build(u.view);
      this.decorations = r.decorations;
      this.atomic = r.atomic;
    }
  }
}

const wysiwygPlugin = ViewPlugin.fromClass(WysiwygPlugin, {
  decorations: (v) => v.decorations,
  provide: (plugin) =>
    EditorView.atomicRanges.of(
      (view) => view.plugin(plugin)?.atomic ?? Decoration.none,
    ),
  eventHandlers: {
    mousedown(this, e, view) {
      // 点击任务复选框时切换 - [ ] / - [x]
      const target = e.target as HTMLElement;
      if (!target.classList?.contains("cm-md-task")) return;
      const pos = view.posAtDOM(target);
      if (pos == null) return;
      const line = view.state.doc.lineAt(pos);
      const text = line.text;
      const m = text.match(/^(\s*[-*+]\s+\[)([ xX])(\])/);
      if (!m) return;
      const insert = m[2].toLowerCase() === "x" ? " " : "x";
      const from = line.from + m[1].length;
      const to = from + 1;
      view.dispatch({ changes: { from, to, insert } });
      e.preventDefault();
    },
  },
});

export const wysiwygMarkdown = wysiwygPlugin;
