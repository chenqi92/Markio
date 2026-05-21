import { useEffect, useMemo, useState } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";
import { sanitizeHtml } from "@/lib/safeHtml";

interface Props {
  formula: string;
  display: boolean;
  x: number;
  y: number;
}

/**
 * 光标停在 $...$ / $$...$$ 内时的浮动 KaTeX 实时预览。
 * - 渲染失败显示原始报错（KaTeX 自带 throwOnError=false 时会输出红字）
 * - 不接管点击；只是辅助看效果
 */
export function MathPreview({ formula, display, x, y }: Props) {
  const html = useMemo(() => {
    try {
      return sanitizeHtml(
        katex.renderToString(formula, {
          displayMode: display,
          throwOnError: false,
          strict: "ignore",
          output: "html",
        }),
      );
    } catch (e) {
      // KaTeX 已 throwOnError:false，走到这里通常是 sanitize 异常；把消息当文本展示，
      // 经 DOMPurify escape 后再注入。
      return sanitizeHtml(
        `<span style="color:#e5484d;font-family:var(--font-mono);font-size:11px">${(e as Error).message}</span>`,
      );
    }
  }, [formula, display]);

  const [pos, setPos] = useState({ left: x, top: y });

  useEffect(() => {
    if (typeof window === "undefined") {
      setPos({ left: x, top: y });
      return;
    }
    const margin = 8;
    const maxWidth = Math.min(560, window.innerWidth - margin * 2);
    const left = Math.max(margin, Math.min(x, window.innerWidth - maxWidth - margin));
    const top = Math.max(margin, Math.min(y, window.innerHeight - 80));
    setPos({ left, top });
  }, [x, y]);

  return (
    <div
      className="math-preview"
      style={{
        position: "fixed",
        left: pos.left,
        top: pos.top,
        zIndex: 80,
        background: "var(--bg-pane, #fff)",
        border: "0.5px solid var(--border, #d2d2d7)",
        borderRadius: 10,
        boxShadow: "0 8px 28px rgba(0,0,0,0.12)",
        padding: display ? "10px 14px" : "6px 10px",
        maxWidth: 560,
        overflow: "auto",
        pointerEvents: "none",
        color: "var(--text, #1d1d1f)",
        fontSize: display ? 14 : 13,
      }}
      onMouseDown={(e) => e.preventDefault()}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
