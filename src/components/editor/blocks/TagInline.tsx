import { createReactInlineContentSpec } from "@blocknote/react";
import { useUI } from "@/stores/ui";

/**
 * Tag inline content —— 形如 `#tag-name` / `#中文标签` 显示为 chip。
 *
 * 跟 markdown 原生语法的冲突边界：
 * - markdown H1 是行首 `# ` 后跟空格；inline tag 是 `#` 紧接非空白字符
 * - `C#` / `F#` 不应识别为 tag，所以要求 `#` 前面是空白或字符串开头
 * - `## ` 等 heading 已经被 BlockNote 解析成 heading 节点，到 inline content
 *   时 `#` 已经被剥掉，不会进入 expand 路径
 *
 * 点击 chip：切到侧栏的 "标签" tab。具体定位到该 tag 是 TagLandscape 内部
 * 的事，目前先打开 tab 让用户能看到。
 */
type TagProps = { name: { default: "" } };

interface RenderProps {
  inlineContent: {
    type: "tag";
    props: { name: string };
  };
}

function TagView({ inlineContent }: RenderProps) {
  const name = inlineContent.props.name;
  return (
    <span
      className="bn-tag"
      contentEditable={false}
      onClick={() => {
        useUI.getState().setSidebarTab("tags");
      }}
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "0 6px",
        margin: "0 1px",
        borderRadius: 4,
        background: "var(--bg-pane-2)",
        color: "var(--text-2)",
        fontSize: "0.9em",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        cursor: "pointer",
        userSelect: "none",
        verticalAlign: "baseline",
        lineHeight: 1.4,
        border: "0.5px solid var(--border)",
      }}
      title={`打开标签 #${name}`}
    >
      #{name}
    </span>
  );
}

export const TagInlineContent = createReactInlineContentSpec(
  {
    type: "tag",
    propSchema: {
      name: { default: "" },
    } as const satisfies TagProps,
    content: "none",
  },
  {
    render: TagView as never,
  },
);

/** 跟 wikilink 同模式：扫 text 节点把 `#tag` 拆成 inline tag 节点。 */
export function expandTagsInInlineContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  const out: unknown[] = [];
  // 只匹配 ASCII 字母数字下划线连字符 + 汉字；前面必须是空白或字符串开头
  // （避免误识别 C# / F# / md5#hash 等）
  const re = /#([A-Za-z0-9_\-一-龥]+)/g;
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
    let lastIdx = 0;
    let m: RegExpExecArray | null;
    let pushedAny = false;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      const prev = m.index > 0 ? text[m.index - 1] ?? "" : "";
      // 前一字符必须是空白或字符串开头，否则不当 tag
      if (prev !== "" && !/\s/.test(prev)) continue;
      pushedAny = true;
      if (m.index > lastIdx) {
        out.push({
          type: "text",
          text: text.slice(lastIdx, m.index),
          styles: n.styles ?? {},
        });
      }
      out.push({ type: "tag", props: { name: m[1] } });
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

/** 反向：tag inline → text `#name` */
export function collapseTagsInInlineContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((node) => {
    if (!node || typeof node !== "object") return node;
    const n = node as { type?: string; props?: { name?: string } };
    if (n.type === "tag") {
      return {
        type: "text",
        text: `#${n.props?.name ?? ""}`,
        styles: {},
      };
    }
    return node;
  });
}
