import { useEffect, useRef, useState } from "react";
import { Icon } from "../ui/Icon";
import { api } from "@/lib/api";
import { renderMermaidIn } from "@/lib/mermaid";
import { useSettings } from "@/stores/settings";
import { useTabs } from "@/stores/tabs";
import { useUI } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";
import { insertBlock } from "@/lib/editor-bridge";

interface Props {
  text: string;
  time: number;
  busy?: boolean;
  /** 用户上一次的提问，用于"重生成" */
  prevUserText?: string;
  onRegenerate?: (text: string) => void;
}

function fmtTime(ts: number) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * AI 助手消息：把回复文本走 Rust markdown 渲染，挂回 DOM。
 * 代码块走 syntect 高亮；mermaid 块走前端 mermaid 渲染。
 * 配套四个操作：复制 / 插入到当前笔记光标 / 另存为新笔记 / 重生成。
 */
export function AIAssistantMessage({
  text,
  time,
  busy,
  prevUserText,
  onRegenerate,
}: Props) {
  const [html, setHtml] = useState<string>("");
  const ref = useRef<HTMLDivElement>(null);
  const theme = useSettings((s) => s.theme);
  const setToast = useUI((s) => s.setToast);
  const ws = useWorkspace((s) => s.activeWorkspace());

  useEffect(() => {
    let cancelled = false;
    api
      .renderMarkdown(text)
      .then((r) => {
        if (cancelled) return;
        setHtml(r.html);
      })
      .catch(() => {
        if (cancelled) return;
        setHtml(
          `<pre style="color: var(--text-3); font-size: 12px; padding: 8px;">${escapeHtml(text)}</pre>`,
        );
      });
    return () => {
      cancelled = true;
    };
  }, [text]);

  useEffect(() => {
    if (!ref.current) return;
    ref.current
      .querySelectorAll<HTMLElement>(".mermaid-block")
      .forEach((el) => {
        delete el.dataset.rendered;
      });
    renderMermaidIn(ref.current).catch(() => undefined);
  }, [html, theme]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setToast({ stage: "done", message: "已复制" });
      setTimeout(() => setToast(null), 1500);
    } catch {
      /* ignore */
    }
  };

  const insertToTab = () => {
    insertBlock("\n" + text + "\n", { atLineStart: true });
    setToast({ stage: "done", message: "已插入当前笔记" });
    setTimeout(() => setToast(null), 1500);
  };

  const saveAsNote = async () => {
    if (!ws) {
      setToast({ stage: "error", message: "请先打开一个仓库" });
      setTimeout(() => setToast(null), 2000);
      return;
    }
    const ymd = new Date().toISOString().slice(0, 10);
    const guess = `AI · ${prevUserText?.slice(0, 24) ?? ymd}`.replace(/[\/\\:*?"<>|]/g, " ");
    const name = window.prompt("另存为新笔记，文件名（自动追加 .md）", guess);
    if (!name) return;
    const fname = name.endsWith(".md") ? name : `${name}.md`;
    const path = `${ws.path}/${fname}`;
    try {
      await api.createNew(path, text);
      await useWorkspace.getState().refreshTree(ws.id);
      await useTabs.getState().openFile(ws.id, path);
    } catch (e) {
      const { parseError } = await import("@/lib/api");
      const err = parseError(e);
      if (err.code === "ALREADY_EXISTS") {
        setToast({
          stage: "error",
          message: `${fname} 已存在，请换个名字`,
        });
      } else {
        setToast({ stage: "error", message: err.message });
      }
      setTimeout(() => setToast(null), 2500);
    }
  };

  return (
    <div className="ai-msg assistant">
      <div className="ai-msg-avatar assistant">
        <Icon name="sparkle" size={13} />
      </div>
      <div className="ai-msg-body">
        <div
          ref={ref}
          className="ai-msg-md preview"
          dangerouslySetInnerHTML={{ __html: html }}
        />
        <div className="ai-msg-foot">
          <span className="ai-msg-time">{fmtTime(time)}</span>
          {!busy && (
            <div className="ai-msg-actions-row">
              <button
                type="button"
                className="ai-act-mini"
                title="复制"
                onClick={copy}
              >
                <Icon name="copy" size={11} />
              </button>
              <button
                type="button"
                className="ai-act-mini"
                title="插入到当前笔记"
                onClick={insertToTab}
              >
                <Icon name="link" size={11} />
              </button>
              <button
                type="button"
                className="ai-act-mini"
                title="另存为新笔记"
                onClick={saveAsNote}
              >
                <Icon name="save" size={11} />
              </button>
              {prevUserText && onRegenerate && (
                <button
                  type="button"
                  className="ai-act-mini"
                  title="重生成"
                  onClick={() => onRegenerate(prevUserText)}
                >
                  <Icon name="sync" size={11} />
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
