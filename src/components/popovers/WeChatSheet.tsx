import { useMemo, useState } from "react";
import { Icon } from "../ui/Icon";
import { useTabs } from "@/stores/tabs";
import { useUI } from "@/stores/ui";
import { api } from "@/lib/api";

const STYLES = [
  { id: "warm", name: "暖橘 · 杂志", accent: "#ff7a45" },
  { id: "blue", name: "海蓝 · 经典", accent: "#0a84ff" },
  { id: "ink", name: "墨黑 · 极简", accent: "#1d1d1f" },
  { id: "rose", name: "桃粉 · 文艺", accent: "#c43d63" },
];

/**
 * 微信公众号导出抽屉。
 * 接入真实 API 推送在 设置 → 微信公众号 里配置；目前提供：
 * - 样式选择
 * - 预览 HTML 渲染（沿用 Rust 的 render）
 * - 把渲染后的内容复制到剪贴板（公众号支持粘贴 HTML 样式）
 */
export function WeChatSheet({ onClose }: { onClose: () => void }) {
  const tab = useTabs((s) => s.activeTab());
  const setToast = useUI((s) => s.setToast);
  const [style, setStyle] = useState(STYLES[0]);
  const [html, setHtml] = useState<string>("");

  useMemo(() => {
    if (!tab) return;
    api
      .renderMarkdown(tab.content)
      .then((r) => setHtml(r.html))
      .catch(() => setHtml(""));
  }, [tab?.id, tab?.content]);

  const copy = async () => {
    if (!html) return;
    const inlined = inlineForWeChat(html, style.accent);
    const wrapped = `<section style="font-family: -apple-system, 'PingFang SC', sans-serif; line-height: 1.75; color: #333;">${inlined.html}</section>`;
    try {
      await navigator.clipboard.writeText(wrapped);
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

  /** 公众号编辑器对 class 不友好，需要把代码高亮转成内联 style；
   *  同时统计 http(s) 图片数量提示用户手动上传。 */
  const inlineForWeChat = (
    html: string,
    accent: string,
  ): { html: string; externalImages: number } => {
    const doc = new DOMParser().parseFromString(
      `<div>${html}</div>`,
      "text/html",
    );
    const wrap = doc.body.firstElementChild as HTMLElement;
    let externalImages = 0;
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
    // 图片：http/https 外链统计
    wrap.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
      const src = img.getAttribute("src") || "";
      if (/^https?:\/\//.test(src)) externalImages += 1;
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
            <div style={{ fontWeight: 600, fontSize: 14 }}>导出到微信公众号</div>
            <div style={{ fontSize: 11, color: "var(--text-3)" }}>
              选择样式 → 复制到公众号编辑器即可保留格式
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
                onClick={() => setStyle(s)}
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
              发布
            </div>
            <button
              type="button"
              className="settings-btn primary"
              style={{ width: "100%", marginBottom: 6 }}
              onClick={copy}
            >
              复制为公众号样式
            </button>
            <button
              type="button"
              className="settings-btn"
              style={{ width: "100%" }}
              disabled
              title="需在 设置 → 微信公众号 绑定账号"
            >
              直接推送草稿
            </button>
          </aside>
          <div className="wechat-preview-pane">
            <div className="wechat-phone">
              <div
                className="wechat-phone-content"
                style={{
                  ["--accent" as never]: style.accent,
                } as React.CSSProperties}
                dangerouslySetInnerHTML={{ __html: html }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
