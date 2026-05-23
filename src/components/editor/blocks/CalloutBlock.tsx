import { useState } from "react";
import { useTranslation } from "react-i18next";
import { createReactBlockSpec } from "@blocknote/react";

/**
 * Callout 自定义 block —— Obsidian 风 `> [!type] Title\n> body`。
 *
 * - `props.calloutType` 一类（note / tip / warning / ...）
 * - `props.title` 第一行标题（可空）
 * - `props.body` 多行正文（plain text，未支持行内富文本，简单实现）
 *
 * 阶段 2 用最简实现：textarea 编辑 body，type 用 select 切。阶段 3 可以
 * 升级成嵌套 blocks 让 body 支持富文本。
 *
 * Round-trip：parse 阶段在 BlockEditor 里把 quote block + 首行 `[!type] title?`
 * 模式换成 callout block；serialize 阶段反向 —— callout block → quote block
 * 让 BlockNote 输出 `> ...` 段；之后 postprocess 把首行补成 `> [!type] title`。
 */
const CALLOUT_TYPES = [
  { id: "note", color: "#5b8def" },
  { id: "info", color: "#0ea5e9" },
  { id: "tip", color: "#10b981" },
  { id: "success", color: "#22c55e" },
  { id: "question", color: "#a855f7" },
  { id: "warning", color: "#f59e0b" },
  { id: "danger", color: "#ef4444" },
  { id: "important", color: "#ec4899" },
  { id: "todo", color: "#6366f1" },
  { id: "example", color: "#14b8a6" },
  { id: "bug", color: "#ef4444" },
  { id: "quote", color: "#94a3b8" },
] as const;

const TYPE_BY_ID = new Map(CALLOUT_TYPES.map((t) => [t.id, t]));

/** 别名 → 主类型，跟 markio preview 的 callouts.ts 对齐 */
const CALLOUT_ALIASES: Record<string, string> = {
  hint: "tip",
  caution: "warning",
  attention: "warning",
  error: "danger",
  check: "success",
  done: "success",
  help: "question",
  faq: "question",
  abstract: "note",
  summary: "note",
  tldr: "note",
};

/** 把任何（含别名的）类型字符串 normalize 成主类型 id；非法返回 null */
function normalizeCalloutType(raw: string): string | null {
  const lower = raw.toLowerCase();
  if (TYPE_BY_ID.has(lower as (typeof CALLOUT_TYPES)[number]["id"])) return lower;
  const aliased = CALLOUT_ALIASES[lower];
  if (aliased && TYPE_BY_ID.has(aliased as (typeof CALLOUT_TYPES)[number]["id"])) {
    return aliased;
  }
  return null;
}

export function calloutDefByType(type: string) {
  return TYPE_BY_ID.get(type as (typeof CALLOUT_TYPES)[number]["id"]);
}

type CalloutProps = {
  calloutType: { default: "note" };
  title: { default: "" };
  body: { default: "" };
};

interface RenderProps {
  block: {
    id: string;
    type: "callout";
    props: { calloutType: string; title: string; body: string };
  };
  editor: {
    updateBlock: (
      block: { id: string },
      update: {
        props: Partial<{ calloutType: string; title: string; body: string }>;
      },
    ) => void;
  };
}

function CalloutView({ block, editor }: RenderProps) {
  const { t } = useTranslation();
  const { calloutType, title, body } = block.props;
  const def = calloutDefByType(calloutType) ?? CALLOUT_TYPES[0];
  const [bodyEditing, setBodyEditing] = useState(false);

  return (
    <div
      className="bn-callout-block"
      contentEditable={false}
      style={{
        border: `1px solid ${def.color}40`,
        background: `${def.color}10`,
        borderLeft: `3px solid ${def.color}`,
        borderRadius: 6,
        padding: "10px 12px",
        marginBlock: 8,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            display: "inline-block",
            width: 8,
            height: 8,
            borderRadius: 999,
            background: def.color,
            flexShrink: 0,
          }}
        />
        <select
          value={calloutType}
          onChange={(e) =>
            editor.updateBlock(block, { props: { calloutType: e.target.value } })
          }
          style={{
            background: "transparent",
            border: "none",
            color: def.color,
            fontWeight: 600,
            fontSize: 12,
            cursor: "pointer",
            outline: "none",
          }}
        >
          {CALLOUT_TYPES.map((typ) => (
            <option key={typ.id} value={typ.id}>
              {t(`callout.${typ.id}`)}
            </option>
          ))}
        </select>
        <input
          value={title}
          placeholder={t("callout.titlePlaceholder")}
          onChange={(e) =>
            editor.updateBlock(block, { props: { title: e.target.value } })
          }
          style={{
            flex: 1,
            background: "transparent",
            border: "none",
            color: "var(--text)",
            fontWeight: 600,
            fontSize: 13,
            outline: "none",
            padding: 0,
          }}
        />
      </div>
      {bodyEditing ? (
        <textarea
          value={body}
          autoFocus
          spellCheck={false}
          rows={Math.max(2, body.split("\n").length + 1)}
          onChange={(e) =>
            editor.updateBlock(block, { props: { body: e.target.value } })
          }
          onBlur={() => setBodyEditing(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setBodyEditing(false);
            }
          }}
          style={{
            width: "100%",
            background: "transparent",
            border: `1px dashed ${def.color}60`,
            borderRadius: 4,
            color: "var(--text)",
            fontFamily: "inherit",
            fontSize: 13,
            padding: 6,
            resize: "vertical",
            outline: "none",
            lineHeight: 1.6,
          }}
        />
      ) : (
        <div
          onDoubleClick={() => setBodyEditing(true)}
          style={{
            whiteSpace: "pre-wrap",
            color: "var(--text)",
            fontSize: 13,
            lineHeight: 1.6,
            cursor: "text",
            minHeight: 18,
          }}
          title={t("callout.editBody")}
        >
          {body || (
            <span style={{ color: "var(--text-3)" }}>
              {t("callout.bodyPlaceholder")}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export const CalloutReactBlock = createReactBlockSpec(
  {
    type: "callout",
    propSchema: {
      calloutType: { default: "note" },
      title: { default: "" },
      body: { default: "" },
    } as const satisfies CalloutProps,
    content: "none",
  },
  {
    render: CalloutView as unknown as Parameters<
      typeof createReactBlockSpec
    >[1]["render"],
  },
);

/**
 * 把一段 markdown 引用块（` > a\n> b ...` 已经把 `>` 去掉了的纯文本）
 * 解析成 callout 结构。返回 null 表示不是 callout 形式。
 */
export function tryParseCalloutFromQuote(
  plainQuoteText: string,
): { type: string; title: string; body: string } | null {
  const m = plainQuoteText.match(/^\[!([a-zA-Z][\w-]*)\][+-]?\s*(.*?)(\n[\s\S]*)?$/);
  if (!m) return null;
  const type = normalizeCalloutType(m[1]);
  if (!type) return null;
  return {
    type,
    title: m[2]?.trim() ?? "",
    body: (m[3] ?? "").replace(/^\n/, ""),
  };
}

/** 反向：callout 结构 → quote 块的 inline plain text（不带 `> ` 前缀） */
export function calloutToQuoteText(opts: {
  type: string;
  title: string;
  body: string;
}): string {
  const titlePart = opts.title ? ` ${opts.title}` : "";
  const header = `[!${opts.type}]${titlePart}`;
  return opts.body ? `${header}\n${opts.body}` : header;
}
