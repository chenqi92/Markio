/* eslint-disable @typescript-eslint/no-explicit-any --
 * BlockNote 自定义 schema 的具体 block 类型由 generic 推导，跟自定义
 * insertOrUpdateBlockForSlashMenu 的 PartialBlock 联合不兼容，整文件用 any
 * 绕一下；运行期逻辑没问题。
 */
import {
  SuggestionMenuController,
  getDefaultReactSlashMenuItems,
  type DefaultReactSuggestionItem,
} from "@blocknote/react";
import {
  filterSuggestionItems,
  insertOrUpdateBlockForSlashMenu,
} from "@blocknote/core/extensions";
import type { BlockNoteEditor, PartialBlock } from "@blocknote/core";
import { DEFAULT_CHART_CODE } from "./blocks/ChartBlock";
import { DEFAULT_DOT_CODE, DEFAULT_PLANTUML_CODE } from "./blocks/DiagramBlock";
import { useWorkspace } from "@/stores/workspace";
import { useVaultIndex } from "@/stores/vaultIndex";

type AnyEditor = BlockNoteEditor<any, any, any>;

/**
 * markio 给 BlockNote slash menu 加的 3 个自定义块（mermaid / math / callout）。
 * 复用 BlockNote 自带的 insertOrUpdateBlockForSlashMenu 助手 —— 它能识别当前
 * 行是不是空段，是就替换、否则插入下一行。
 */
function getMarkioSlashItems(
  editor: AnyEditor,
  group: string,
): DefaultReactSuggestionItem[] {
  return [
    {
      title: "Mermaid 图",
      onItemClick: () => {
        insertOrUpdateBlockForSlashMenu(editor, {
          type: "mermaid",
          props: { code: "graph TD\n  A --> B" },
        } as unknown as PartialBlock<any, any, any>);
      },
      aliases: ["mermaid", "图表", "diagram", "flow"],
      group,
      icon: <span style={{ fontSize: 14 }}>🧜</span>,
      subtext: "插入 Mermaid 流程图 / 时序图 / 甘特图",
    },
    {
      title: "Chart 图表",
      onItemClick: () => {
        insertOrUpdateBlockForSlashMenu(editor, {
          type: "chart",
          props: { code: DEFAULT_CHART_CODE },
        } as unknown as PartialBlock<any, any, any>);
      },
      aliases: ["chart", "bar", "line", "pie", "图表", "柱状图"],
      group,
      icon: <span style={{ fontSize: 14 }}>▥</span>,
      subtext: "插入 JSON 驱动的 bar / line / pie 图表",
    },
    {
      title: "Graphviz / DOT",
      onItemClick: () => {
        insertOrUpdateBlockForSlashMenu(editor, {
          type: "diagram",
          props: { kind: "graphviz", code: DEFAULT_DOT_CODE, server: "" },
        } as unknown as PartialBlock<any, any, any>);
      },
      aliases: ["graphviz", "dot", "diagram", "关系图"],
      group,
      icon: <span style={{ fontSize: 14 }}>◎</span>,
      subtext: "插入本地渲染的 DOT 关系图",
    },
    {
      title: "PlantUML",
      onItemClick: () => {
        insertOrUpdateBlockForSlashMenu(editor, {
          type: "diagram",
          props: { kind: "plantuml", code: DEFAULT_PLANTUML_CODE, server: "" },
        } as unknown as PartialBlock<any, any, any>);
      },
      aliases: ["plantuml", "puml", "sequence", "时序图"],
      group,
      icon: <span style={{ fontSize: 12, fontWeight: 700 }}>PU</span>,
      subtext: "插入 PlantUML 块",
    },
    {
      title: "数学公式 (KaTeX)",
      onItemClick: () => {
        insertOrUpdateBlockForSlashMenu(editor, {
          type: "math",
          props: { latex: "" },
        } as unknown as PartialBlock<any, any, any>);
      },
      aliases: ["math", "latex", "katex", "公式", "$$"],
      group,
      icon: <span style={{ fontSize: 14 }}>∑</span>,
      subtext: "插入块级 LaTeX 公式",
    },
    {
      title: "Callout 提示",
      onItemClick: () => {
        insertOrUpdateBlockForSlashMenu(editor, {
          type: "callout",
          props: { calloutType: "note", title: "", body: "" },
        } as unknown as PartialBlock<any, any, any>);
      },
      aliases: ["callout", "note", "tip", "warning", "提示", "警告"],
      group,
      icon: <span style={{ fontSize: 14 }}>📌</span>,
      subtext: "Obsidian 风格的彩色提示框",
    },
  ];
}

/** `/` 触发的 slash menu 配置 —— 把 markio 自定义块插到默认菜单后面 */
export function MarkioSlashMenu({
  editor,
  locale,
}: {
  editor: AnyEditor;
  locale: "zh-CN" | "en";
}) {
  const group = locale === "zh-CN" ? "markio 扩展" : "markio";
  return (
    <SuggestionMenuController
      triggerCharacter="/"
      getItems={async (query) =>
        filterSuggestionItems(
          [
            ...getDefaultReactSlashMenuItems(editor),
            ...getMarkioSlashItems(editor, group),
          ],
          query,
        )
      }
    />
  );
}

/**
 * `[[` 触发的 wikilink 自动补全。BlockNote 的 trigger 只支持单字符，所以
 * trigger 用 `[` + shouldOpen 检查光标前是不是 `[`，等价 `[[` 触发。
 *
 * onItemClick 直接 insert wikilink inline content 并删掉用户已经敲入的
 * `[[query` 这一段；最终落到文档里就是一个 pill。
 */
export function WikilinkSuggestionMenu({ editor }: { editor: AnyEditor }) {
  return (
    <SuggestionMenuController
      triggerCharacter="["
      shouldOpen={(tr) => {
        const $pos = tr.selection.$from;
        const off = $pos.parentOffset;
        // trigger 是 "["，触发时已经输入了一个 "["。再看再前一个字符是不是 "["
        const before = $pos.parent.textBetween(Math.max(0, off - 2), off);
        return before === "[[";
      }}
      minQueryLength={0}
      getItems={async (query) => {
        const ws = useWorkspace.getState().activeWorkspace();
        if (!ws) return [];
        await useVaultIndex.getState().ensure(ws.path);
        const idx = useVaultIndex.getState().index[ws.path];
        const all = idx?.files ?? [];
        const q = query.trim().toLowerCase();
        const matches = (
          q
            ? all.filter(
                (f) =>
                  f.name.toLowerCase().includes(q) ||
                  f.path.toLowerCase().includes(q),
              )
            : all
        ).slice(0, 30);
        return matches.map((f) => {
          const stem = f.name.replace(/\.md$/, "");
          return {
            title: stem,
            subtext: f.path,
            onItemClick: () => {
              // 用户已经敲入 "[[" + query：trigger 吃掉第一个 "["，
              // 第二个 "[" + query 还在文档里需要删掉再插 wikilink。
              const $pos = editor._tiptapEditor.state.selection.$from;
              const off = $pos.parentOffset;
              const docPos = $pos.pos;
              const back = 1 + query.length; // 第二个 "[" + query 长度
              const from = docPos - back;
              editor._tiptapEditor
                .chain()
                .focus()
                .deleteRange({ from, to: docPos })
                .insertContent({
                  type: "wikilink",
                  attrs: { target: stem },
                })
                .insertContent(" ")
                .run();
              const _ = off;
            },
          } as DefaultReactSuggestionItem;
        });
      }}
    />
  );
}
