import { useState } from "react";
import { Icon } from "../ui/Icon";
import { useTabs } from "@/stores/tabs";
import { useUI } from "@/stores/ui";
import { api } from "@/lib/api";
import { writeText } from "@/lib/clipboard";

type TargetId =
  | "wechat"
  | "twitter"
  | "jike"
  | "xhs"
  | "feishu"
  | "notion"
  | "html"
  | "plain";

interface Target {
  id: TargetId;
  ico: string;
  name: string;
  color: string;
  sub: string;
}

const COPY_TARGETS: Target[] = [
  {
    id: "wechat",
    ico: "微",
    name: "微信公众号",
    color: "linear-gradient(135deg, #07c160, #1aad19)",
    sub: "打开排版面板 · 一键复制",
  },
  {
    id: "html",
    ico: "</>",
    name: "HTML",
    color: "linear-gradient(135deg, #e44d26, #f16529)",
    sub: "带样式的完整 HTML",
  },
  {
    id: "plain",
    ico: "T",
    name: "纯文本",
    color: "var(--text-3)",
    sub: "去掉所有 Markdown 标记",
  },
  {
    id: "twitter",
    ico: "𝕏",
    name: "Twitter / X · 长推",
    color: "#0a0a0a",
    sub: "自动按 280 字符分串",
  },
  {
    id: "jike",
    ico: "即",
    name: "即刻",
    color: "linear-gradient(135deg, #ffe028, #ffb800)",
    sub: "保留 Markdown 强调",
  },
  {
    id: "xhs",
    ico: "📕",
    name: "小红书",
    color: "linear-gradient(135deg, #ff2442, #ee5a52)",
    sub: "标题正文标签分段",
  },
  {
    id: "feishu",
    ico: "飞",
    name: "飞书富文本",
    color: "linear-gradient(135deg, #00d6b9, #0090e7)",
    sub: "Markdown 块结构粘贴",
  },
  {
    id: "notion",
    ico: "N",
    name: "Notion 块",
    color: "#0a0a0c",
    sub: "保留 Markdown 块语法",
  },
];

/** 把 markdown 字符串粗略转成纯文本 */
export function markdownToPlain(src: string): string {
  return src
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?|```/g, ""))
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, p, l) => l || p)
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(\*|_)(.+?)\1/g, "$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/^>\s?/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*+]\s+/gm, "· ")
    .replace(/^\d+\.\s+/gm, (m) => m)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 280 字符分串，按行 / 段落优先切 */
export function splitForTwitter(text: string, limit = 280): string {
  const blocks = text.split(/\n{2,}/);
  const parts: string[] = [];
  let buf = "";
  for (const b of blocks) {
    if ((buf + "\n\n" + b).length <= limit) {
      buf = buf ? buf + "\n\n" + b : b;
    } else {
      if (buf) parts.push(buf);
      // 单段超长直接硬切
      if (b.length > limit) {
        for (let i = 0; i < b.length; i += limit) {
          parts.push(b.slice(i, i + limit));
        }
        buf = "";
      } else {
        buf = b;
      }
    }
  }
  if (buf) parts.push(buf);
  return parts
    .map((p, i) => `${i + 1}/${parts.length}\n${p}`)
    .join("\n\n———\n\n");
}

function firstHeading(source: string, fallback: string): string {
  const match = source.match(/^#{1,6}\s+(.+)$/m);
  return (match?.[1] ?? fallback).trim();
}

function uniqueTags(source: string): string[] {
  const tags = source.match(/#[\w\u4e00-\u9fa5-]+/g) ?? [];
  return Array.from(new Set(tags)).slice(0, 8);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function formatForJike(source: string): string {
  return source
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      (_match, label: string, url: string) => `${label} ${url}`,
    )
    .replace(/```[\w-]*\n?([\s\S]*?)```/g, (_match, code: string) =>
      code.trim(),
    )
    .replace(/^#{1,6}\s+/gm, "# ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function formatForXhs(source: string, fallbackTitle: string): string {
  const title = firstHeading(source, fallbackTitle.trim() || "无标题");
  const plain = markdownToPlain(source)
    .replace(new RegExp(`^${escapeRegExp(title)}\\s*`), "")
    .trim();
  const tags = uniqueTags(source).join(" ");
  return [title, plain, tags].filter(Boolean).join("\n\n");
}

export function formatForMarkdownPaste(source: string): string {
  return source.trim();
}

export function MultiCopySheet({ onClose }: { onClose: () => void }) {
  const [picked, setPicked] = useState<TargetId>("wechat");
  const [busy, setBusy] = useState(false);
  const tab = useTabs((s) => s.activeTab());
  const setToast = useUI((s) => s.setToast);
  const openWechat = useUI((s) => s.openWechat);

  const flash = (
    stage: "uploading" | "done" | "error",
    message: string,
    ms = 1800,
  ) => {
    setToast({ stage, message });
    setTimeout(() => setToast(null), ms);
  };

  const doCopy = async () => {
    if (!tab) {
      flash("error", "请先打开一个文档");
      return;
    }
    setBusy(true);
    try {
      if (picked === "wechat") {
        onClose();
        openWechat(true);
        return;
      }
      const source = tab.content;
      switch (picked) {
        case "plain": {
          await writeText(markdownToPlain(source));
          flash("done", "已复制为纯文本");
          break;
        }
        case "html": {
          const r = await api.renderMarkdown(source);
          await writeText(r.html);
          flash("done", "已复制为 HTML");
          break;
        }
        case "twitter": {
          await writeText(splitForTwitter(markdownToPlain(source)));
          flash("done", "已按 280 字符分串复制");
          break;
        }
        case "jike":
          await writeText(formatForJike(source));
          flash("done", "已复制为即刻文本");
          break;
        case "xhs":
          await writeText(formatForXhs(source, tab.title));
          flash("done", "已复制为小红书文案");
          break;
        case "feishu":
          await writeText(formatForMarkdownPaste(source));
          flash("done", "已复制为飞书 Markdown");
          break;
        case "notion": {
          await writeText(formatForMarkdownPaste(source));
          flash("done", "已复制为 Notion Markdown");
          break;
        }
      }
      onClose();
    } catch (e) {
      flash("error", `复制失败：${(e as Error).message}`, 2600);
    } finally {
      setBusy(false);
    }
  };

  const current = COPY_TARGETS.find((t) => t.id === picked);

  return (
    <div className="scrim" onClick={onClose}>
      <div className="mc-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="mc-h">
          <div style={{ flex: 1 }}>
            <div className="mc-t">复制为…</div>
            <div className="mc-s">选择目标平台，自动适配该平台的排版风格</div>
          </div>
          <button className="icon-btn" onClick={onClose} title="关闭">
            <Icon name="x" size={12} />
          </button>
        </div>
        <div className="mc-grid">
          {COPY_TARGETS.map((t) => (
            <div
              key={t.id}
              className={"mc-tile" + (picked === t.id ? " active" : "")}
              onClick={() => setPicked(t.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") setPicked(t.id);
              }}
            >
              <div className="mc-tile-ico" style={{ background: t.color }}>
                {t.ico}
              </div>
              <div className="mc-tile-meta">
                <div className="mc-tile-t">{t.name}</div>
                <div className="mc-tile-s">{t.sub}</div>
              </div>
              {picked === t.id && <span className="mc-check">✓</span>}
            </div>
          ))}
        </div>
        <div className="mc-foot">
          <span style={{ flex: 1, fontSize: 11, color: "var(--text-3)" }}>
            {current?.sub}
          </span>
          <button
            className="settings-btn primary"
            onClick={doCopy}
            disabled={busy}
          >
            {busy
              ? "处理中…"
              : picked === "wechat"
                ? "打开排版面板"
                : "复制到剪贴板"}
          </button>
        </div>
      </div>
    </div>
  );
}
