/**
 * Markdown WYSIWYG decoration plugin for CodeMirror 6.
 *
 * 思路：用 `syntaxTree` 拿到 lezer 的 markdown AST，对每个语法节点
 * 生成 Decoration —— 给整行加 class（标题大字号、引用左边线…）、给行内
 * 段落加 mark（粗体 / 斜体 / 行内代码 / 链接 / 删除线）、把 markdown
 * 标记字符（# / ** / ` / > / [] / [x] / ![]() …）替换为隐藏 widget 或空。
 *
 * 光标在某行时，整行的 marker 全部"现形"以便编辑；离开则隐藏。
 *
 * 结构（从 2000 行单文件拆出来后）：
 *   wysiwyg.ts          — 入口：组合 wysiwygMarkdown + 对外 API 再导出
 *   wysiwyg/build.ts    — build() 整文档 decoration 构建 + 命中范围跟踪
 *   wysiwyg/state.ts    — StateField，docChanged / selection 节流策略
 *   wysiwyg/mousedown.ts— widget 点击行为
 *   wysiwyg/math.ts     — MathWidget + KaTeX lazy
 *   wysiwyg/codeFence.ts— CodeFenceWidget + 所有 fenced-code DOM 交互
 *   wysiwyg/visualFence.ts — VisualFenceWidget (mermaid / dot / chart)
 *   wysiwyg/wikilink.ts — WikilinkWidget + detectWikilinks
 *   wysiwyg/table.ts    — TableWidget + 表格 cell 编辑
 *   wysiwyg/inlineWidgets.ts — 6 个轻量 widget
 *   wysiwyg/highlight.ts — hljs lazy 子系统
 *   wysiwyg/util.ts     — Cleanup 类型 + eventElementTarget
 */

import { wysiwygField, wysiwygVaultSync } from "./wysiwyg/state";
import { wysiwygMousedown } from "./wysiwyg/mousedown";

// 兼容旧导入路径：tests / table-edit / SourceEditor 通过 './wysiwyg' 拿这些 API
export {
  buildTableDom,
  parseTableSource,
  buildTableSource,
  applyWysiwygTableAction,
} from "./wysiwyg/table";
export type { ParsedTable, WysiwygTableAction } from "./wysiwyg/table";
export { parseImageMarkdown } from "@/lib/markdown-images";

export const wysiwygMarkdown = [wysiwygField, wysiwygMousedown, wysiwygVaultSync];
