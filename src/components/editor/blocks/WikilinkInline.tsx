import { createReactInlineContentSpec } from "@blocknote/react";
import { useTabs } from "@/stores/tabs";
import { useWorkspace } from "@/stores/workspace";
import { useUI } from "@/stores/ui";
import { useVaultIndex } from "@/stores/vaultIndex";

/**
 * Wikilink inline content —— `[[target]]` 在 BlockNote 里显示为可点击 pill。
 *
 * 设计：
 * - `props.target` 是链接目标（笔记标题或路径）
 * - content="none" 表示这是 atom inline（不可在内部输入）
 * - 点击：尝试在当前 vault 索引找匹配笔记，找到就开 tab，找不到弹 toast
 *
 * Markdown round-trip 由 BlockEditor 在 parse/serialize 钩子里处理：
 * - parse 后：扫描所有 block.content 的 text 节点，把 `[[xxx]]` 拆成
 *   [text, wikilink, text, ...]
 * - serialize 前：把 wikilink inline 转回 text `[[target]]`
 */
type WikilinkProps = { target: { default: "" } };

interface RenderProps {
  inlineContent: {
    type: "wikilink";
    props: { target: string };
  };
}

function WikilinkView({ inlineContent }: RenderProps) {
  const target = inlineContent.props.target;
  const onClick = () => {
    const ws = useWorkspace.getState().activeWorkspace();
    if (!ws) return;
    const idx = useVaultIndex.getState().index[ws.path];
    const norm = target.replace(/\\/g, "/").toLowerCase();
    const stem = norm.split("/").pop() ?? norm;
    const hit = idx?.files.find((f) => {
      const fn = f.name.toLowerCase().replace(/\.md$/, "");
      const path = f.path.toLowerCase();
      return fn === stem || path.endsWith(`/${norm}.md`) || path.endsWith(`/${norm}`);
    });
    if (hit) {
      void useTabs.getState().openPath(hit.path);
    } else {
      useUI.getState().setToast({
        stage: "error",
        message: `未找到笔记：${target}`,
      });
      setTimeout(() => useUI.getState().setToast(null), 1800);
    }
  };

  return (
    <span
      className="bn-wikilink"
      contentEditable={false}
      onClick={onClick}
      style={{
        // 用普通 inline 而不是 inline-flex，让 chip 跟周围文本基线对齐
        // （在 heading 等大字号文本里 inline-flex 会让 chip 偏低）
        display: "inline",
        padding: "1px 6px",
        margin: "0 1px",
        borderRadius: 4,
        background: "var(--accent-glow, rgba(10, 132, 255, 0.18))",
        color: "var(--accent)",
        fontSize: "0.92em",
        cursor: "pointer",
        userSelect: "none",
        verticalAlign: "baseline",
        textDecoration: "none",
        whiteSpace: "nowrap",
      }}
      title={`打开 ${target}`}
    >
      {/* 链接图标 + 笔记名；不再重复显示 [[ ]] 标记，磁盘上的 markdown 仍是 `[[xxx]]` */}
      <svg
        width="0.85em"
        height="0.85em"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{
          opacity: 0.7,
          verticalAlign: "-0.1em",
          marginRight: 3,
        }}
        aria-hidden
      >
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      </svg>
      {target}
    </span>
  );
}

export const WikilinkInlineContent = createReactInlineContentSpec(
  {
    type: "wikilink",
    propSchema: {
      target: { default: "" },
    } as const satisfies WikilinkProps,
    content: "none",
  },
  // 用 any 绕开 BlockNote 内部 generic 跟自定义 type 的相互推导冲突；
  // 实际签名跟 render: (props: { inlineContent: { type, props }, ...}) => JSX 等价。
  {
    render: WikilinkView as never,
  },
);

/**
 * 在 block.content（inline content 数组）里把所有 text 节点的 `[[xxx]]`
 * 拆成 [text, wikilink, text, ...]。其它类型的 inline content 原样保留。
 */
export function expandWikilinksInInlineContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  const out: unknown[] = [];
  for (const node of content) {
    if (!node || typeof node !== "object") {
      out.push(node);
      continue;
    }
    const n = node as { type?: string; text?: string; styles?: unknown };
    if (n.type !== "text" || typeof n.text !== "string") {
      out.push(node);
      continue;
    }
    const text = n.text;
    const re = /\[\[([^[\]\n|]+?)(?:\|([^[\]\n]+?))?\]\]/g;
    let lastIdx = 0;
    let m: RegExpExecArray | null;
    let pushedAny = false;
    while ((m = re.exec(text)) !== null) {
      pushedAny = true;
      if (m.index > lastIdx) {
        out.push({
          type: "text",
          text: text.slice(lastIdx, m.index),
          styles: n.styles ?? {},
        });
      }
      out.push({
        type: "wikilink",
        props: { target: m[1].trim() },
      });
      lastIdx = m.index + m[0].length;
    }
    if (!pushedAny) {
      out.push(node);
    } else if (lastIdx < text.length) {
      out.push({
        type: "text",
        text: text.slice(lastIdx),
        styles: n.styles ?? {},
      });
    }
  }
  return out;
}

/** 反向：把 wikilink inline 转回 text `[[target]]`，便于 BlockNote 序列化。 */
export function collapseWikilinksInInlineContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((node) => {
    if (!node || typeof node !== "object") return node;
    const n = node as { type?: string; props?: { target?: string } };
    if (n.type === "wikilink") {
      return {
        type: "text",
        text: `[[${n.props?.target ?? ""}]]`,
        styles: {},
      };
    }
    return node;
  });
}
