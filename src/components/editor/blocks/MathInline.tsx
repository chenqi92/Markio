import { useEffect, useRef } from "react";
import { createReactInlineContentSpec } from "@blocknote/react";

/**
 * 行内数学公式：`$x^2$` → KaTeX 渲染。
 *
 * 跟 markdown 原生语法的冲突边界：
 * - `$100` 不应识别为公式（前面是字母数字时不算）；要求 `$` 前是空白或
 *   字符串开头
 * - 配对要求：另一个 `$` 出现在同一行内，且后面紧跟 \s / 标点 / 行尾
 * - 内部不允许跨行（带 `\n` 视为不闭合）
 */
type MathInlineProps = { latex: { default: "" } };

interface RenderProps {
  inlineContent: {
    type: "mathInline";
    props: { latex: string };
  };
}

let katexPromise: Promise<typeof import("katex").default> | null = null;
function getKatex() {
  if (!katexPromise) {
    katexPromise = import("katex").then((m) => m.default);
  }
  return katexPromise;
}

function MathInlineView({ inlineContent }: RenderProps) {
  const latex = inlineContent.props.latex;
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const katex = await getKatex();
      if (cancelled || !ref.current) return;
      try {
        ref.current.innerHTML = katex.renderToString(latex, {
          displayMode: false,
          throwOnError: false,
          strict: "ignore",
        });
      } catch {
        if (ref.current) ref.current.textContent = `$${latex}$`;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [latex]);

  return (
    <span
      ref={ref}
      className="bn-math-inline"
      contentEditable={false}
      style={{
        display: "inline",
        padding: "0 2px",
        cursor: "default",
        userSelect: "none",
        verticalAlign: "baseline",
      }}
      title={`$${latex}$`}
    >
      ${latex}$
    </span>
  );
}

export const MathInlineContent = createReactInlineContentSpec(
  {
    type: "mathInline",
    propSchema: {
      latex: { default: "" },
    } as const satisfies MathInlineProps,
    content: "none",
  },
  {
    render: MathInlineView as never,
  },
);

/** 扫 text 节点把 `$x^2$` 拆成 [text, mathInline, text] */
export function expandInlineMathInInlineContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  const out: unknown[] = [];
  // 配对：$ 前是空白/行首；内部不含 $ 和 \n；闭合 $ 后是空白/行尾/标点
  const re = /\$([^\s$][^$\n]*?[^\s$]|[^\s$\n])\$/g;
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
      const after = text[m.index + m[0].length] ?? "";
      // 前后字符不是字母数字下划线即可 —— 避开 `$100`/`C#`/`md5$hash`，
      // 但允许任意空白、标点、中文（包括 `：`、`，`、`（` 等）。
      const okPrev = prev === "" || !/[A-Za-z0-9_]/.test(prev);
      const okAfter = after === "" || !/[A-Za-z0-9_]/.test(after);
      if (!okPrev || !okAfter) continue;
      pushedAny = true;
      if (m.index > lastIdx) {
        out.push({
          type: "text",
          text: text.slice(lastIdx, m.index),
          styles: n.styles ?? {},
        });
      }
      out.push({ type: "mathInline", props: { latex: m[1] } });
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

/** 反向：mathInline → text `$latex$` */
export function collapseInlineMathInInlineContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((node) => {
    if (!node || typeof node !== "object") return node;
    const n = node as { type?: string; props?: { latex?: string } };
    if (n.type === "mathInline") {
      return {
        type: "text",
        text: `$${n.props?.latex ?? ""}$`,
        styles: {},
      };
    }
    return node;
  });
}
