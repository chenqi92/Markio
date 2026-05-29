import { useEffect, useState } from "react";
import { Icon } from "../ui/Icon";
import {
  copyHtml,
  copyMarkdown,
  exportDocx,
  exportEpub,
  exportHtml,
  exportPdf,
} from "@/lib/export";
import { api } from "@/lib/api";
import { useTabs } from "@/stores/tabs";
import { useUI } from "@/stores/ui";

const IS_MAC =
  typeof navigator !== "undefined" && navigator.platform.startsWith("Mac");

type FormatId = "pdf" | "docx" | "html" | "epub" | "md" | "copy-html";

interface Format {
  id: FormatId;
  ico: string;
  color: string;
  name: string;
  sub: string;
  /** false = 复制到剪贴板，不显示"另存为"对话框 */
  isFile: boolean;
}

const FORMATS: Format[] = [
  { id: "pdf", ico: "📄", color: "#ff3b30", name: "PDF", sub: "打印对话框选择 · 含目录页码", isFile: true },
  { id: "docx", ico: "📃", color: "#2563eb", name: "Word", sub: ".docx · 通过 pandoc", isFile: true },
  { id: "html", ico: "</>", color: "#f59e0b", name: "HTML", sub: "单文件 · 含样式", isFile: true },
  { id: "epub", ico: "📚", color: "#8b5cf6", name: "EPUB", sub: "电子书 · 通过 pandoc", isFile: true },
  { id: "md", ico: "M↓", color: "#374151", name: "Markdown", sub: "复制原始 markdown 到剪贴板", isFile: false },
  { id: "copy-html", ico: "🔗", color: "#10b981", name: "HTML 片段", sub: "复制 HTML 到剪贴板", isFile: false },
];

type Stage = "config" | "progress" | "done" | "error";

export function ExportSheet({ onClose }: { onClose: () => void }) {
  const tab = useTabs((s) => s.activeTab());
  const setToast = useUI((s) => s.setToast);
  const [fmt, setFmt] = useState<FormatId>("pdf");
  const [stage, setStage] = useState<Stage>("config");
  const [errMsg, setErrMsg] = useState<string | null>(null);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape" && stage !== "progress") onClose();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose, stage]);

  useEffect(() => {
    if (!tab) onClose();
  }, [tab, onClose]);

  if (!tab) return null;

  const fmtObj = FORMATS.find((f) => f.id === fmt) ?? FORMATS[0]!;

  const start = async () => {
    setStage("progress");
    setErrMsg(null);
    try {
      const title = tab.title;
      const src = tab.content;
      switch (fmt) {
        case "pdf":
          await exportPdf(title, src);
          break;
        case "docx":
          await exportDocx(title, src);
          break;
        case "html":
          await exportHtml(title, src);
          break;
        case "epub":
          await exportEpub(title, src);
          break;
        case "md":
          await copyMarkdown(src);
          break;
        case "copy-html":
          await copyHtml(title, src);
          break;
      }
      setStage("done");
      if (!fmtObj.isFile) {
        setToast({ stage: "done", message: "已复制到剪贴板" });
        setTimeout(() => setToast(null), 1500);
        onClose();
      }
    } catch (e) {
      setErrMsg((e as Error).message ?? String(e));
      setStage("error");
    }
  };

  return (
    <div className="scrim ex-scrim" onClick={() => stage !== "progress" && onClose()}>
      <div className="ex-sheet" onClick={(e) => e.stopPropagation()} role="dialog">
        {stage === "config" && (
          <>
            <div className="ex-h">
              <div className="ex-h-ico">↧</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="ex-t">导出文档</div>
                <div className="ex-s">{tab.title} · 选择格式</div>
              </div>
              <button type="button" className="qc2-close" onClick={onClose} title="关闭">
                <Icon name="x" size={12} />
              </button>
            </div>
            <div className="ex-body">
              <div className="ex-section-h">格式</div>
              <div className="ex-formats">
                {FORMATS.map((f) => (
                  <button
                    type="button"
                    key={f.id}
                    className={"ex-fmt" + (fmt === f.id ? " active" : "")}
                    onClick={() => setFmt(f.id)}
                  >
                    <div className="ex-fmt-ico" style={{ background: f.color }}>
                      {f.ico}
                    </div>
                    <div className="ex-fmt-meta">
                      <div className="t">{f.name}</div>
                      <div className="s">{f.sub}</div>
                    </div>
                    {fmt === f.id && <div className="ex-fmt-check">✓</div>}
                  </button>
                ))}
              </div>
              <div className="ex-hint">
                导出 PDF 会调起系统打印对话框；DOCX / EPUB 需要本地装好 <code>pandoc</code>。
              </div>
              {IS_MAC && (
                <>
                  <div className="ex-section-h" style={{ marginTop: 12 }}>
                    分享到系统应用
                  </div>
                  <div className="ex-formats">
                    <button
                      type="button"
                      className="ex-fmt"
                      onClick={async () => {
                        try {
                          await api.macosShare({
                            target: "mail",
                            title: tab.title,
                            body: tab.content,
                          });
                          setToast({ stage: "done", message: "已在 Mail.app 创建新邮件" });
                          setTimeout(() => setToast(null), 1500);
                          onClose();
                        } catch (e) {
                          setToast({ stage: "error", message: `Mail 分享失败：${String(e)}` });
                          setTimeout(() => setToast(null), 2500);
                        }
                      }}
                    >
                      <div className="ex-fmt-ico" style={{ background: "#0a84ff" }}>✉︎</div>
                      <div className="ex-fmt-meta">
                        <div className="t">Mail</div>
                        <div className="s">把笔记装进新邮件草稿</div>
                      </div>
                    </button>
                    <button
                      type="button"
                      className="ex-fmt"
                      onClick={async () => {
                        try {
                          await api.macosShare({
                            target: "reminders",
                            title: tab.title,
                            body: tab.content,
                          });
                          setToast({ stage: "done", message: "已添加到 Reminders 默认列表" });
                          setTimeout(() => setToast(null), 1500);
                          onClose();
                        } catch (e) {
                          setToast({ stage: "error", message: `Reminders 分享失败：${String(e)}` });
                          setTimeout(() => setToast(null), 2500);
                        }
                      }}
                    >
                      <div className="ex-fmt-ico" style={{ background: "#ff9500" }}>✓</div>
                      <div className="ex-fmt-meta">
                        <div className="t">Reminders</div>
                        <div className="s">把标题做事项 · 正文进备注</div>
                      </div>
                    </button>
                  </div>
                  <div className="ex-hint">
                    首次会弹「markio 想控制 Mail / 提醒事项」系统对话框，授权后保留。
                  </div>
                </>
              )}
            </div>
            <div className="ex-foot">
              <div className="ex-foot-meta">
                <span className="ex-foot-fmt" style={{ background: fmtObj.color }}>
                  {fmtObj.ico}
                </span>
                <div>
                  <div className="t">{fmtObj.name}</div>
                  <div className="s">{fmtObj.sub}</div>
                </div>
              </div>
              <span style={{ flex: 1 }} />
              <button type="button" className="settings-btn" onClick={onClose}>
                取消
              </button>
              <button type="button" className="settings-btn primary" onClick={() => void start()}>
                {fmtObj.isFile ? `导出 ${fmtObj.name}` : `复制为 ${fmtObj.name}`}
              </button>
            </div>
          </>
        )}

        {stage === "progress" && (
          <div className="ex-progress">
            <div className="ex-progress-orb" />
            <div className="ex-progress-t">正在导出为 {fmtObj.name}…</div>
            <div className="ex-progress-bar">
              <div />
            </div>
            <div className="ex-progress-step">{fmtObj.sub}</div>
          </div>
        )}

        {stage === "done" && fmtObj.isFile && (
          <div className="ex-done">
            <div className="ex-done-check">✓</div>
            <div className="ex-done-t">导出完成</div>
            <div className="ex-done-name">{tab.title}</div>
            <div className="ex-done-meta">{fmtObj.name} · 已交给系统对话框</div>
            <div className="ex-done-actions">
              <button type="button" className="settings-btn" onClick={onClose}>
                完成
              </button>
            </div>
          </div>
        )}

        {stage === "error" && (
          <div className="ex-done">
            <div className="ex-done-check" style={{ background: "#ff453a" }}>!</div>
            <div className="ex-done-t">导出失败</div>
            <div
              className="ex-done-meta"
              style={{ color: "#ff453a", maxWidth: 420, whiteSpace: "pre-wrap" }}
            >
              {errMsg ?? "未知错误"}
            </div>
            <div className="ex-done-actions">
              <button
                type="button"
                className="settings-btn"
                onClick={() => setStage("config")}
              >
                返回
              </button>
              <button type="button" className="settings-btn" onClick={onClose}>
                关闭
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
