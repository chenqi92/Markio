import { useEffect, useRef, useState } from "react";
import { createReactBlockSpec } from "@blocknote/react";
import DOMPurify from "dompurify";
import { useSettings } from "@/stores/settings";
import { isDarkTheme } from "@/themes";

/**
 * Mermaid 自定义 block：
 *
 * - `props.code` 是 mermaid 源码（即 markdown 里 ` ```mermaid` 围栏内的内容）
 * - 默认显示渲染后的 SVG；双击进入编辑态，textarea 直接改源码
 * - blur 后退出编辑，并立刻重新渲染
 * - 主题切换会触发 re-render（用 settings.theme 作为 effect dep）
 *
 * 序列化方向：BlockEditor 的 onChange 在调 blocksToMarkdownLossy 前，
 * 会把 type=mermaid 的 block 转回 `{ type: "codeBlock", props.language: "mermaid",
 * content: [{ type: "text", text: code }] }`，BlockNote 自然会输出 ```mermaid 围栏。
 *
 * 解析方向：BlockEditor 在 tryParseMarkdownToBlocks 之后扫描 codeBlock，
 * 把 language === "mermaid" 的换成本 block。
 */
type MermaidProps = {
  code: { default: ""; type?: "string" };
};

let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;
let initializedTheme: string | null = null;
let counter = 0;

async function getMermaid(themeId: string) {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => m.default);
  }
  const mermaid = await mermaidPromise;
  if (initializedTheme !== themeId) {
    const dark = isDarkTheme(themeId);
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: dark ? "dark" : "default",
      fontFamily: "var(--font-sans), system-ui, sans-serif",
    });
    initializedTheme = themeId;
  }
  return mermaid;
}

interface RenderProps {
  block: {
    id: string;
    type: "mermaid";
    props: { code: string };
  };
  editor: {
    updateBlock: (
      block: { id: string },
      update: { props: { code: string } },
    ) => void;
  };
}

function MermaidView({ block, editor }: RenderProps) {
  const code = block.props.code;
  const [editing, setEditing] = useState(false);
  const svgRef = useRef<HTMLDivElement>(null);
  const themeId = useSettings((s) => s.theme);

  useEffect(() => {
    if (editing) return;
    if (!code.trim()) {
      if (svgRef.current) {
        svgRef.current.innerHTML =
          '<div style="color: var(--text-3); font-size: 12px; padding: 8px;">空 mermaid 块（双击编辑）</div>';
      }
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const mermaid = await getMermaid(themeId);
        const id = `bn-mmd-${counter++}`;
        const { svg } = await mermaid.render(id, code);
        if (cancelled || !svgRef.current) return;
        svgRef.current.innerHTML = DOMPurify.sanitize(svg, {
          USE_PROFILES: { svg: true, svgFilters: true },
        });
      } catch (err) {
        if (cancelled || !svgRef.current) return;
        const msg = (err as Error).message;
        svgRef.current.innerHTML = `<pre style="color: var(--text-3); font-size: 12px; white-space: pre-wrap; margin: 0; padding: 8px;">mermaid 渲染失败：${msg.replace(/</g, "&lt;")}</pre>`;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, editing, themeId]);

  return (
    <div className="bn-mermaid-block" contentEditable={false}>
      {editing ? (
        <textarea
          value={code}
          autoFocus
          spellCheck={false}
          rows={Math.max(3, code.split("\n").length + 1)}
          onChange={(e) =>
            editor.updateBlock(block, { props: { code: e.target.value } })
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
            fontSize: 12,
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
          ref={svgRef}
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
          }}
          title="双击编辑"
        />
      )}
    </div>
  );
}

export const MermaidReactBlock = createReactBlockSpec(
  {
    type: "mermaid",
    propSchema: {
      code: { default: "" },
    } as const satisfies MermaidProps,
    content: "none",
  },
  {
    render: MermaidView as unknown as Parameters<
      typeof createReactBlockSpec
    >[1]["render"],
  },
);
