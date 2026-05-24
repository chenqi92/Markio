import { useEffect, useRef, useState } from "react";
import { createReactBlockSpec } from "@blocknote/react";

/**
 * Math 块级公式自定义 block。
 *
 * - `props.latex` 是 LaTeX 源码（即 markdown 里 `$$ ... $$` 中的内容）
 * - 默认显示 KaTeX 渲染结果；双击进入编辑态
 * - 行内 `$ ... $` 不在这里处理，留给 inline content schema（跟 wikilink 一起）
 *
 * Markdown round-trip：因为 BlockNote 默认 markdown parser 不识别 `$$`，
 * BlockEditor 在 parse 前把 `$$...$$` 预先替换成 ` ```math ` 围栏，让
 * BlockNote 当成 codeBlock 处理；transformBlocksAfterParse 再把
 * codeBlock(language=math) 换成本 block。序列化反过来：math block → codeBlock(math)
 * → blocksToMarkdownLossy → post-process 把 ` ```math ` 换回 `$$...$$`。
 */
type MathProps = { latex: { default: "" } };

let katexPromise: Promise<typeof import("katex").default> | null = null;
function getKatex() {
  if (!katexPromise) {
    katexPromise = import("katex").then((m) => m.default);
  }
  return katexPromise;
}

interface RenderProps {
  block: {
    id: string;
    type: "math";
    props: { latex: string };
  };
  editor: {
    updateBlock: (
      block: { id: string },
      update: { props: { latex: string } },
    ) => void;
  };
}

function MathView({ block, editor }: RenderProps) {
  const latex = block.props.latex;
  const [editing, setEditing] = useState(false);
  const outRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editing) return;
    if (!latex.trim()) {
      if (outRef.current) {
        outRef.current.innerHTML =
          '<div style="color: var(--text-3); font-size: 12px; padding: 8px;">空公式（双击编辑）</div>';
      }
      return;
    }
    let cancelled = false;
    void (async () => {
      const katex = await getKatex();
      if (cancelled || !outRef.current) return;
      try {
        outRef.current.innerHTML = katex.renderToString(latex, {
          displayMode: true,
          throwOnError: false,
          strict: "ignore",
        });
      } catch (err) {
        outRef.current.innerHTML = `<pre style="color: #d44; font-size: 12px; white-space: pre-wrap; margin: 0; padding: 8px;">KaTeX 错误：${(err as Error).message}</pre>`;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [latex, editing]);

  return (
    <div className="bn-math-block" contentEditable={false}>
      {editing ? (
        <textarea
          value={latex}
          autoFocus
          spellCheck={false}
          rows={Math.max(2, latex.split("\n").length + 1)}
          onChange={(e) =>
            editor.updateBlock(block, { props: { latex: e.target.value } })
          }
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
            }
          }}
          style={{
            width: "100%",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 13,
            padding: 10,
            background: "var(--bg-pane-2)",
            border: "1px solid var(--accent)",
            borderRadius: 6,
            color: "var(--text)",
            resize: "vertical",
            outline: "none",
            lineHeight: 1.5,
          }}
        />
      ) : (
        <div
          ref={outRef}
          onDoubleClick={() => setEditing(true)}
          style={{
            padding: 12,
            background: "var(--bg-pane-2)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            minHeight: 40,
            cursor: "pointer",
            textAlign: "center",
            overflowX: "auto",
            color: "var(--text)",
          }}
          title="双击编辑"
        />
      )}
    </div>
  );
}

export const MathReactBlock = createReactBlockSpec(
  {
    type: "math",
    propSchema: {
      latex: { default: "" },
    } as const satisfies MathProps,
    content: "none",
  },
  {
    render: MathView as unknown as Parameters<
      typeof createReactBlockSpec
    >[1]["render"],
  },
);
