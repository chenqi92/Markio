// 源码编辑器右键菜单：按光标所在区域（链接 / 图片 / 代码块 / 标题 / 列表 / 选区 / 纯文本）
// 给出对应条目。参考 Typora / Obsidian 的右键交互：始终屏蔽浏览器原生菜单，菜单内容随
// 上下文变化，常用的剪贴板 / 格式 / 链接动作放在一个轻量 popover 里。

import type { EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { EditorSelection } from "@codemirror/state";
import { markdownCommands } from "@/lib/markdown-commands";
import { wrapSelection } from "@/lib/editor-bridge";
import { readText, writeText } from "@/lib/clipboard";
import { openExternal } from "@/lib/opener";
import type { CtxItem } from "@/components/popovers/ContextMenu";

export interface EditorContext {
  hasSelection: boolean;
  selectionText: string;
  link: { href: string; text: string; from: number; to: number } | null;
  image: { src: string; alt: string; from: number; to: number } | null;
  inCodeBlock: { lang: string | null; from: number; to: number } | null;
  inInlineCode: { from: number; to: number } | null;
  headingLevel: number | null;
  inTaskItem: boolean;
}

/** 在 `pos` 处沿 lezer 树往上看，落到第一个匹配 name 的节点；找不到返回 null。 */
function findEnclosing(view: EditorView, pos: number, names: ReadonlySet<string>) {
  const tree = syntaxTree(view.state);
  let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, 1);
  while (node) {
    if (names.has(node.name)) return node;
    node = node.parent;
  }
  return null;
}

const LINK_NAMES = new Set(["Link"]);
const IMAGE_NAMES = new Set(["Image"]);
const CODE_BLOCK_NAMES = new Set(["FencedCode", "CodeBlock"]);
const INLINE_CODE_NAMES = new Set(["InlineCode"]);
const HEADING_RE = /^(ATXHeading|SetextHeading)([1-6])$/;
const TASK_NAMES = new Set(["Task", "TaskMarker"]);

export function detectContext(view: EditorView, pos: number): EditorContext {
  const sel = view.state.selection.main;
  const hasSelection = !sel.empty;
  const selectionText = hasSelection ? view.state.sliceDoc(sel.from, sel.to) : "";

  let link: EditorContext["link"] = null;
  const linkNode = findEnclosing(view, pos, LINK_NAMES);
  if (linkNode) {
    // lezer markdown: Link 包 LinkMark "[" + 文本 + LinkMark "]" + LinkMark "(" + URL + LinkMark ")"
    const text = view.state.sliceDoc(linkNode.from, linkNode.to);
    const m = text.match(/\[([^\]]*)\]\(([^)]+)\)/);
    if (m) link = { text: m[1], href: m[2], from: linkNode.from, to: linkNode.to };
  }

  let image: EditorContext["image"] = null;
  const imageNode = findEnclosing(view, pos, IMAGE_NAMES);
  if (imageNode) {
    const text = view.state.sliceDoc(imageNode.from, imageNode.to);
    const m = text.match(/!\[([^\]]*)\]\(([^)]+)\)/);
    if (m) image = { alt: m[1], src: m[2], from: imageNode.from, to: imageNode.to };
  }

  let inCodeBlock: EditorContext["inCodeBlock"] = null;
  const codeNode = findEnclosing(view, pos, CODE_BLOCK_NAMES);
  if (codeNode) {
    // 取 fence 上一行的语言标签
    const first = view.state.doc.lineAt(codeNode.from).text;
    const langMatch = first.match(/^```\s*([^\s`]+)/);
    inCodeBlock = {
      lang: langMatch ? langMatch[1] : null,
      from: codeNode.from,
      to: codeNode.to,
    };
  }

  let inInlineCode: EditorContext["inInlineCode"] = null;
  const inlineCodeNode = findEnclosing(view, pos, INLINE_CODE_NAMES);
  if (inlineCodeNode) {
    inInlineCode = { from: inlineCodeNode.from, to: inlineCodeNode.to };
  }

  let headingLevel: number | null = null;
  const tree = syntaxTree(view.state);
  let n: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, 1);
  while (n) {
    const m = n.name.match(HEADING_RE);
    if (m) {
      headingLevel = Number(m[2]);
      break;
    }
    n = n.parent;
  }

  const inTaskItem = !!findEnclosing(view, pos, TASK_NAMES);

  return {
    hasSelection,
    selectionText,
    link,
    image,
    inCodeBlock,
    inInlineCode,
    headingLevel,
    inTaskItem,
  };
}

export interface BuildItemsDeps {
  view: EditorView;
  pos: number;
  modifierLabel: (mac: string, win: string) => string;
  toast: (msg: string) => void;
}

export function buildEditorContextItems(deps: BuildItemsDeps): CtxItem[] {
  const { view, pos, modifierLabel, toast } = deps;
  // 右键时若没有选区，先把光标移到点击位置，方便后续的「拷贝当前词 / 格式化」按钮
  if (view.state.selection.main.empty) {
    view.dispatch({ selection: EditorSelection.single(pos) });
  }
  const ctx = detectContext(view, pos);
  const items: CtxItem[] = [];

  // ─── 剪贴板 ───
  items.push({
    label: "剪切",
    kbd: modifierLabel("⌘X", "Ctrl+X"),
    disabled: !ctx.hasSelection,
    onClick: () => {
      const sel = view.state.selection.main;
      void writeText(view.state.sliceDoc(sel.from, sel.to));
      view.dispatch({ changes: { from: sel.from, to: sel.to } });
    },
  });
  items.push({
    label: "复制",
    icon: "copy",
    kbd: modifierLabel("⌘C", "Ctrl+C"),
    disabled: !ctx.hasSelection,
    onClick: () => {
      const sel = view.state.selection.main;
      void writeText(view.state.sliceDoc(sel.from, sel.to));
    },
  });
  items.push({
    label: "粘贴",
    kbd: modifierLabel("⌘V", "Ctrl+V"),
    onClick: () => {
      void readText().then((text) => {
        if (!text) {
          toast("剪贴板为空 / 没有权限读取");
          return;
        }
        const sel = view.state.selection.main;
        view.dispatch({
          changes: { from: sel.from, to: sel.to, insert: text },
          selection: EditorSelection.single(sel.from + text.length),
        });
      });
    },
  });
  items.push({ sep: true });

  // ─── 链接区域 ───
  if (ctx.link) {
    const href = ctx.link.href;
    items.push({
      label: "打开链接",
      icon: "external",
      onClick: () => {
        void openExternal(href);
      },
    });
    items.push({
      label: "复制链接",
      icon: "copy",
      onClick: () => void writeText(href),
    });
    items.push({
      label: "去掉链接（保留文字）",
      onClick: () => {
        if (!ctx.link) return;
        view.dispatch({
          changes: {
            from: ctx.link.from,
            to: ctx.link.to,
            insert: ctx.link.text,
          },
        });
      },
    });
    items.push({ sep: true });
  }

  // ─── 图片区域 ───
  if (ctx.image) {
    const src = ctx.image.src;
    items.push({
      label: "复制图片地址",
      icon: "copy",
      onClick: () => void writeText(src),
    });
    items.push({
      label: "在外部打开图片",
      icon: "external",
      onClick: () => {
        void openExternal(src);
      },
    });
    items.push({ sep: true });
  }

  // ─── 代码块区域 ───
  if (ctx.inCodeBlock) {
    const block = ctx.inCodeBlock;
    items.push({
      label: "复制整段代码",
      icon: "copy",
      onClick: () => {
        // 去掉首尾的 ``` fence
        const raw = view.state.sliceDoc(block.from, block.to);
        const lines = raw.split("\n");
        if (lines[0]?.startsWith("```")) lines.shift();
        if (lines[lines.length - 1]?.startsWith("```")) lines.pop();
        void writeText(lines.join("\n"));
      },
    });
    items.push({ sep: true });
  }

  // ─── 选区（行内代码 / 链接 / 加粗等） ───
  if (ctx.hasSelection) {
    items.push({
      label: "加粗",
      icon: "bold",
      kbd: modifierLabel("⌘B", "Ctrl+B"),
      onClick: () => wrapSelection("**"),
    });
    items.push({
      label: "斜体",
      icon: "italic",
      kbd: modifierLabel("⌘I", "Ctrl+I"),
      onClick: () => wrapSelection("*"),
    });
    items.push({
      label: "删除线",
      icon: "strike",
      onClick: () => wrapSelection("~~"),
    });
    items.push({
      label: "行内代码",
      icon: "code",
      onClick: () => wrapSelection("`"),
    });
    items.push({
      label: "转为链接",
      icon: "link",
      onClick: () => markdownCommands.link(),
    });
    items.push({ sep: true });
  }

  // ─── 标题区域提示 ───
  if (ctx.headingLevel != null) {
    items.push({
      label: `（当前是 H${ctx.headingLevel}）`,
      disabled: true,
    });
    items.push({ sep: true });
  }

  // ─── 通用插入 ───
  if (!ctx.inCodeBlock) {
    items.push({
      label: "插入链接",
      icon: "link",
      onClick: () => markdownCommands.link(),
    });
    items.push({
      label: "插入代码块",
      icon: "code",
      onClick: () => markdownCommands.codeBlock(),
    });
  }
  items.push({
    label: "全选",
    kbd: modifierLabel("⌘A", "Ctrl+A"),
    onClick: () => {
      view.dispatch({
        selection: EditorSelection.single(0, view.state.doc.length),
      });
    },
  });
  // 防止结尾出现孤立分隔条
  while (items.length && items[items.length - 1].sep) items.pop();
  return items;
}

