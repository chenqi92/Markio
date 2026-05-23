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
  const [zoomed, setZoomed] = useState(false);
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
        <div style={{ position: "relative" }}>
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
            title="双击编辑 / 右上角放大"
          />
          {code.trim() && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setZoomed(true);
              }}
              title="放大查看"
              style={{
                position: "absolute",
                top: 6,
                right: 8,
                width: 24,
                height: 24,
                padding: 0,
                background: "var(--bg-elev)",
                border: "0.5px solid var(--border)",
                borderRadius: 4,
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--text-2)",
                opacity: 0.7,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M15 3h6v6" />
                <path d="M10 14 21 3" />
                <path d="M9 21H3v-6" />
                <path d="m3 21 11-11" />
              </svg>
            </button>
          )}
        </div>
      )}
      {zoomed && (
        <ZoomedOverlay
          code={code}
          themeId={themeId}
          onClose={() => setZoomed(false)}
        />
      )}
    </div>
  );
}

/** 全屏放大：重新渲染 SVG 到独立容器，支持滚轮缩放 + 拖动平移。
 *  Esc / 点击空白处 / 右上角 ✕ 关闭。 */
function ZoomedOverlay({
  code,
  themeId,
  onClose,
}: {
  code: string;
  themeId: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const mermaid = await getMermaid(themeId);
        const id = `bn-mmd-zoom-${counter++}`;
        const { svg } = await mermaid.render(id, code);
        if (cancelled || !ref.current) return;
        ref.current.innerHTML = DOMPurify.sanitize(svg, {
          USE_PROFILES: { svg: true, svgFilters: true },
        });
        // 让 SVG 撑满父容器作为缩放基准
        const svgEl = ref.current.querySelector("svg");
        if (svgEl) {
          svgEl.setAttribute("width", "100%");
          svgEl.setAttribute("height", "100%");
          svgEl.style.display = "block";
        }
      } catch (err) {
        if (cancelled || !ref.current) return;
        ref.current.innerHTML = `<pre style="color:#d44;font-size:12px;">${(err as Error).message}</pre>`;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, themeId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "0") {
        setScale(1);
        setTx(0);
        setTy(0);
      } else if (e.key === "+" || e.key === "=") {
        setScale((s) => Math.min(s * 1.2, 8));
      } else if (e.key === "-" || e.key === "_") {
        setScale((s) => Math.max(s / 1.2, 0.2));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const delta = -e.deltaY;
    setScale((s) => {
      const factor = delta > 0 ? 1.1 : 1 / 1.1;
      return Math.max(0.2, Math.min(8, s * factor));
    });
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    dragRef.current = { x: e.clientX, y: e.clientY, tx, ty };
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (!dragRef.current) return;
    setTx(dragRef.current.tx + (e.clientX - dragRef.current.x));
    setTy(dragRef.current.ty + (e.clientY - dragRef.current.y));
  };
  const stopDrag = () => {
    dragRef.current = null;
  };

  const reset = () => {
    setScale(1);
    setTx(0);
    setTy(0);
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.85)",
        zIndex: 10000,
        cursor: "zoom-out",
        userSelect: "none",
      }}
      title="点击空白处或 Esc 关闭"
    >
      {/* 缩放舞台：撑满 overlay，监听 wheel / mousedown */}
      <div
        ref={stageRef}
        onClick={(e) => e.stopPropagation()}
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={stopDrag}
        onMouseLeave={stopDrag}
        style={{
          position: "absolute",
          inset: 0,
          overflow: "hidden",
          cursor: dragRef.current ? "grabbing" : "grab",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          ref={ref}
          style={{
            transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
            transformOrigin: "center center",
            transition: dragRef.current ? "none" : "transform 80ms ease-out",
            background: "var(--bg-modal)",
            borderRadius: 8,
            padding: 24,
            maxWidth: "80vw",
            maxHeight: "80vh",
            pointerEvents: "auto",
            willChange: "transform",
          }}
        />
      </div>
      {/* 控制条：右上角缩放比例 + 重置 + 关闭 */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "absolute",
          top: 16,
          right: 16,
          display: "inline-flex",
          gap: 6,
          padding: "6px 8px",
          background: "rgba(0, 0, 0, 0.5)",
          borderRadius: 6,
          color: "#fff",
          fontSize: 11,
          alignItems: "center",
        }}
      >
        <button type="button" onClick={() => setScale((s) => Math.max(0.2, s / 1.2))} style={zoomBtn} title="缩小 -">−</button>
        <span style={{ minWidth: 38, textAlign: "center", fontVariantNumeric: "tabular-nums" }}>{Math.round(scale * 100)}%</span>
        <button type="button" onClick={() => setScale((s) => Math.min(8, s * 1.2))} style={zoomBtn} title="放大 +">+</button>
        <button type="button" onClick={reset} style={zoomBtn} title="重置 0">⟲</button>
        <button type="button" onClick={onClose} style={zoomBtn} title="关闭 Esc">✕</button>
      </div>
      {/* 底部提示 */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "absolute",
          bottom: 16,
          left: "50%",
          transform: "translateX(-50%)",
          color: "#aaa",
          fontSize: 11,
          background: "rgba(0, 0, 0, 0.5)",
          padding: "4px 10px",
          borderRadius: 4,
        }}
      >
        滚轮缩放 · 拖动平移 · +/- 缩放 · 0 重置 · Esc 关闭
      </div>
    </div>
  );
}

const zoomBtn: React.CSSProperties = {
  width: 24,
  height: 24,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: "transparent",
  border: "1px solid rgba(255,255,255,0.2)",
  color: "#fff",
  cursor: "pointer",
  borderRadius: 4,
  fontSize: 13,
  padding: 0,
};

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
