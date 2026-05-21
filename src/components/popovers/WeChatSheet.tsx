import { useEffect, useState } from "react";
import { Icon } from "../ui/Icon";
import { useSettings } from "@/stores/settings";
import { useTabs } from "@/stores/tabs";
import { useUI } from "@/stores/ui";
import { api } from "@/lib/api";
import { writeText } from "@/lib/clipboard";

const STYLES = [
  { id: "warmMagazine", name: "暖橘 · 杂志", accent: "#ff7a45" },
  { id: "cleanTech", name: "清爽 · 科技", accent: "#0a84ff" },
  { id: "inkClassic", name: "墨色 · 经典", accent: "#1d1d1f" },
  { id: "minimal", name: "极简 · 文章", accent: "#6b7280" },
] as const;

/**
 * 微信公众号排版复制抽屉。
 * 目前提供：
 * - 样式选择
 * - 预览 HTML 渲染（沿用 Rust 的 render）
 * - 把渲染后的内容复制到剪贴板（公众号支持粘贴 HTML 样式）
 */
export function WeChatSheet({ onClose }: { onClose: () => void }) {
  const tab = useTabs((s) => s.activeTab());
  const styleId = useSettings((s) => s.wechatStyle);
  const setPreference = useSettings((s) => s.setPreference);
  const setToast = useUI((s) => s.setToast);
  const [html, setHtml] = useState<string>("");
  const style = STYLES.find((s) => s.id === styleId) ?? STYLES[0];

  useEffect(() => {
    if (!tab) return;
    let cancelled = false;
    api
      .renderMarkdown(tab.content)
      .then((r) => {
        if (!cancelled) setHtml(r.html);
      })
      .catch(() => {
        if (!cancelled) setHtml("");
      });
    return () => {
      cancelled = true;
    };
  }, [tab?.id, tab?.content]);

  const copy = async () => {
    if (!html) return;
    const inlined = await inlineForWeChat(html, style.accent);
    const wrapped = `<section style="font-family: -apple-system, 'PingFang SC', sans-serif; line-height: 1.75; color: #333;">${inlined.html}</section>`;
    try {
      await writeText(wrapped);
      const warnings: string[] = [];
      if (inlined.externalImages > 0)
        warnings.push(`${inlined.externalImages} 张外链图`);
      if (warnings.length > 0) {
        setToast({
          stage: "done",
          message: `已复制（含 ${warnings.join("、")}，公众号需手动上传图片）`,
        });
      } else {
        setToast({ stage: "done", message: "已复制 · 粘贴到公众号编辑器即可" });
      }
      setTimeout(() => setToast(null), 3200);
    } catch {
      setToast({ stage: "error", message: "复制失败" });
      setTimeout(() => setToast(null), 2000);
    }
  };

  /** 1x1 透明灰 PNG，作为外链图片占位 */
  const PLACEHOLDER_IMG =
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180"><rect width="320" height="180" fill="#f2f2f2"/><text x="160" y="92" font-size="14" fill="#999" text-anchor="middle" font-family="-apple-system,PingFang SC,sans-serif">请在公众号编辑器中手动上传图片</text></svg>`,
    );

  /** 公众号编辑器对 class 不友好：
   *  - 代码高亮转成内联 style
   *  - .math/.math-inline/.math-display 用 KaTeX 渲染成内联 MathML+HTML
   *  - http(s) 外链图替换为占位 SVG（公众号不接受外链） */
  const inlineForWeChat = async (
    html: string,
    accent: string,
  ): Promise<{ html: string; externalImages: number }> => {
    const doc = new DOMParser().parseFromString(
      `<div>${html}</div>`,
      "text/html",
    );
    const wrap = doc.body.firstElementChild as HTMLElement;
    let externalImages = 0;

    // 公式：拷贝走 Preview 同款渲染，避免编辑器丢公式
    const mathNodes = wrap.querySelectorAll<HTMLElement>(".math");
    if (mathNodes.length > 0) {
      const [katex, DOMPurify] = await Promise.all([
        import("katex"),
        import("dompurify").then((m) => m.default),
      ]);
      for (const node of Array.from(mathNodes)) {
        const tex = node.textContent ?? "";
        const displayMode = node.classList.contains("math-display");
        try {
          const html = katex.renderToString(tex, {
            displayMode,
            throwOnError: false,
            strict: "ignore",
            output: "htmlAndMathml",
          });
          node.innerHTML = DOMPurify.sanitize(html, {
            USE_PROFILES: { html: true, mathMl: true, svg: true },
          });
        } catch {
          node.textContent = displayMode ? `$$${tex}$$` : `$${tex}$`;
        }
      }
    }

    // 代码高亮：复制计算好的颜色到 style，公众号才能保留
    wrap.querySelectorAll<HTMLElement>("pre code .hljs, pre, code").forEach((el) => {
      const cs = (typeof window !== "undefined"
        ? window.getComputedStyle(el)
        : null) as CSSStyleDeclaration | null;
      if (cs) {
        const color = cs.color;
        const bg = cs.backgroundColor;
        const existing = el.getAttribute("style") || "";
        const additions: string[] = [];
        if (color && color !== "rgba(0, 0, 0, 0)")
          additions.push(`color: ${color}`);
        if (bg && bg !== "rgba(0, 0, 0, 0)")
          additions.push(`background: ${bg}`);
        if (additions.length > 0) {
          el.setAttribute("style", [existing, ...additions].filter(Boolean).join("; "));
        }
      }
    });

    // 图片：http(s) 外链替换为占位 SVG，本地图保留
    wrap.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
      const src = img.getAttribute("src") || "";
      if (/^https?:\/\//.test(src)) {
        externalImages += 1;
        img.setAttribute("data-original-src", src);
        img.setAttribute("src", PLACEHOLDER_IMG);
        const existingStyle = img.getAttribute("style") || "";
        img.setAttribute(
          "style",
          [existingStyle, "max-width: 100%", "border: 1px dashed #ccc"]
            .filter(Boolean)
            .join("; "),
        );
      }
    });

    // 替换主色 token
    let out = wrap.innerHTML;
    out = out.replace(/var\(--accent\)/g, accent);
    return { html: out, externalImages };
  };

  return (
    <div className="scrim" onClick={onClose}>
      <div className="wechat-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="wechat-hd">
          <span
            style={{
              width: 24,
              height: 24,
              borderRadius: 5,
              background: "linear-gradient(135deg, #07c160, #1aad19)",
              color: "white",
              fontWeight: 700,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 12,
            }}
          >
            微
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>公众号排版复制</div>
            <div style={{ fontSize: 11, color: "var(--text-3)" }}>
              选择样式 → 复制到公众号编辑器，图片仍需手动上传
            </div>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            title="关闭"
          >
            <Icon name="x" size={15} />
          </button>
        </div>
        <div className="wechat-body">
          <aside className="wechat-styles">
            <div className="settings-card-h">样式</div>
            {STYLES.map((s) => (
              <button
                type="button"
                key={s.id}
                className={
                  "wechat-style-row" + (style.id === s.id ? " active" : "")
                }
                onClick={() => setPreference("wechatStyle", s.id)}
              >
                <span
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: 5,
                    background: s.accent,
                  }}
                />
                <span style={{ flex: 1 }}>{s.name}</span>
                {style.id === s.id && (
                  <span style={{ color: "var(--accent)" }}>✓</span>
                )}
              </button>
            ))}
            <div className="settings-card-h" style={{ marginTop: 16 }}>
              复制
            </div>
            <button
              type="button"
              className="settings-btn primary"
              style={{ width: "100%" }}
              onClick={copy}
            >
              复制排版 HTML
            </button>
          </aside>
          <div className="wechat-preview-pane">
            <div className="wechat-phone">
              <span className="btn-side action" />
              <span className="btn-side vol-up" />
              <span className="btn-side vol-dn" />
              <span className="btn-side power" />
              <div className="wechat-phone-island" />
              <div className="wechat-phone-screen">
                <div className="wechat-phone-status">
                  <span className="wechat-phone-status-time">9:41</span>
                  <span className="wechat-phone-status-icons">
                    {/* 信号格 */}
                    <svg
                      width="18"
                      height="11"
                      viewBox="0 0 18 11"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <rect x="0" y="7" width="3" height="4" rx="0.5" />
                      <rect x="5" y="5" width="3" height="6" rx="0.5" />
                      <rect x="10" y="3" width="3" height="8" rx="0.5" />
                      <rect x="15" y="1" width="3" height="10" rx="0.5" />
                    </svg>
                    {/* Wi-Fi */}
                    <svg
                      width="16"
                      height="12"
                      viewBox="0 0 16 12"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                      aria-hidden="true"
                    >
                      <path d="M1 4.4a11 11 0 0 1 14 0" />
                      <path d="M3.5 6.8a7 7 0 0 1 9 0" />
                      <path d="M6 9a3.3 3.3 0 0 1 4 0" />
                      <circle cx="8" cy="10.6" r="0.8" fill="currentColor" />
                    </svg>
                    {/* 电池 */}
                    <svg
                      width="26"
                      height="12"
                      viewBox="0 0 26 12"
                      fill="none"
                      aria-hidden="true"
                    >
                      <rect
                        x="0.6"
                        y="0.6"
                        width="22.8"
                        height="10.8"
                        rx="2.6"
                        stroke="currentColor"
                        strokeOpacity="0.45"
                        strokeWidth="1"
                      />
                      <rect
                        x="2"
                        y="2"
                        width="18"
                        height="8"
                        rx="1.4"
                        fill="currentColor"
                      />
                      <rect
                        x="24"
                        y="4"
                        width="1.6"
                        height="4"
                        rx="0.8"
                        fill="currentColor"
                        fillOpacity="0.45"
                      />
                    </svg>
                  </span>
                </div>
                <div className="wechat-phone-nav">
                  <span className="wechat-phone-nav-back" aria-hidden="true">
                    <svg width="11" height="18" viewBox="0 0 11 18" fill="none">
                      <path
                        d="M9 1L2 9l7 8"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </span>
                  公众号文章
                  <span className="wechat-phone-nav-more" aria-hidden="true">
                    <svg width="20" height="6" viewBox="0 0 20 6" fill="currentColor">
                      <circle cx="3" cy="3" r="1.7" />
                      <circle cx="10" cy="3" r="1.7" />
                      <circle cx="17" cy="3" r="1.7" />
                    </svg>
                  </span>
                </div>
                <div className="wechat-phone-scroll">
                  <div
                    className="wechat-phone-content"
                    style={{
                      ["--accent" as never]: style.accent,
                    } as React.CSSProperties}
                    dangerouslySetInnerHTML={{ __html: html }}
                  />
                </div>
                <div className="wechat-phone-home" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
