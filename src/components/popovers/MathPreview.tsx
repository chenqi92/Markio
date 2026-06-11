import { useEffect, useState } from "react";
import { renderMathToHtml } from "@/lib/math";

interface Props {
  formula: string;
  display: boolean;
  x: number;
  y: number;
}

/**
 * 光标停在 $...$ / $$...$$ 内时的浮动 KaTeX 实时预览。
 * - KaTeX(256KB JS + 24KB CSS) 改为懒加载：静态 import 会把它压进冷启动入口包，
 *   即便用户从不写公式。这里在首次需要时异步加载并渲染。
 * - 不接管点击；只是辅助看效果
 */
export function MathPreview({ formula, display, x, y }: Props) {
  const [html, setHtml] = useState<string>("");
  useEffect(() => {
    let cancelled = false;
    void renderMathToHtml(formula, display).then((h) => {
      if (!cancelled) setHtml(h);
    });
    return () => {
      cancelled = true;
    };
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
