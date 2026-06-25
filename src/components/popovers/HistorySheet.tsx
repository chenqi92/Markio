import { useEffect, useMemo, useState } from "react";
import { Icon } from "../ui/Icon";
import { useUI } from "@/stores/ui";
import { useTabs } from "@/stores/tabs";
import { useWorkspace } from "@/stores/workspace";
import { useDialog } from "@/stores/dialog";
import { api } from "@/lib/api";
import { shortcutText } from "@/lib/shortcuts";
import { diffLines, diffStat } from "@/lib/lineDiff";
import type { Snapshot } from "@/types";

function formatTs(ts: number) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (sameDay) return `今天 ${time}`;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${time}`;
}

export function HistorySheet() {
  const open = useUI((s) => s.historyOpen);
  const close = () => useUI.getState().openHistory(false);
  const tabId = useTabs((s) => (open ? s.activeId : null));
  const tabTitle = useTabs((s) => {
    if (!open) return undefined;
    const id = s.activeId;
    return id ? s.tabs.find((t) => t.id === id)?.title : undefined;
  });
  const tabPath = useTabs((s) => {
    if (!open) return undefined;
    const id = s.activeId;
    return id ? s.tabs.find((t) => t.id === id)?.path : undefined;
  });
  const tabWorkspaceId = useTabs((s) => {
    if (!open) return undefined;
    const id = s.activeId;
    return id ? s.tabs.find((t) => t.id === id)?.workspaceId : undefined;
  });
  const ws = useWorkspace((s) =>
    tabWorkspaceId ? s.workspaces.find((w) => w.id === tabWorkspaceId) : undefined,
  );
  const updateContent = useTabs((s) => s.updateContent);
  const setToast = useUI((s) => s.setToast);
  const confirmDialog = useDialog((s) => s.confirm);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [preview, setPreview] = useState<{
    ts: number;
    content: string;
    current: string;
  } | null>(null);
  // "diff" = 与当前文档对比；"raw" = 看快照原文。
  const [viewMode, setViewMode] = useState<"diff" | "raw">("diff");
  const [loading, setLoading] = useState(false);

  // 对比行（old = 快照内容，new = 预览时捕获的当前文档内容）。
  const diffRows = useMemo(
    () => (preview ? diffLines(preview.content, preview.current) : []),
    [preview],
  );
  const stat = useMemo(() => diffStat(diffRows), [diffRows]);

  useEffect(() => {
    if (!open || !tabPath || !ws) {
      setSnapshots([]);
      setPreview(null);
      return;
    }
    setLoading(true);
    api
      .historyList(ws.path, tabPath)
      .then((s) => setSnapshots(s))
      .catch(() => setSnapshots([]))
      .finally(() => setLoading(false));
  }, [open, tabPath, ws]);

  if (!open) return null;

  const onPreview = async (s: Snapshot) => {
    try {
      const c = await api.historyRead(s.path);
      // 捕获预览时刻的当前文档内容，diff 不订阅 content（避免逐键重渲染）。
      const current = tabId
        ? (useTabs.getState().tabs.find((t) => t.id === tabId)?.content ?? "")
        : "";
      setPreview({ ts: s.timestamp, content: c, current });
    } catch (e) {
      setToast({
        stage: "error",
        message: `读取失败：${(e as Error).message}`,
      });
    }
  };

  const onRestore = async (s: Snapshot) => {
    if (!tabId) return;
    const ok = await confirmDialog({
      title: "恢复历史版本？",
      message: `恢复到 ${formatTs(s.timestamp)} 的版本。未保存的更改会丢失。`,
      confirmLabel: "恢复",
      danger: true,
    });
    if (!ok) return;
    close();
    try {
      const c = await api.historyRead(s.path);
      updateContent(tabId, c);
      setToast({ stage: "done", message: "已恢复（记得保存）" });
    } catch (e) {
      setToast({
        stage: "error",
        message: `恢复失败：${(e as Error).message}`,
      });
    }
  };

  return (
    <div className="history-sheet">
      <div className="history-hd">
        <span>
          历史版本{tabTitle ? ` · ${tabTitle}` : ""}{" "}
          <span style={{ color: "var(--text-3)", fontSize: 11, fontWeight: 400 }}>
            {snapshots.length} 个快照
          </span>
        </span>
        <button onClick={close} type="button" title="关闭">
          <Icon name="x" size={14} />
        </button>
      </div>
      <div className="history-list">
        {!tabId ? (
          <div
            style={{
              padding: 32,
              color: "var(--text-3)",
              fontSize: 12,
              textAlign: "center",
            }}
          >
            打开一个文档后才会有历史记录
          </div>
        ) : loading ? (
          <div
            style={{
              padding: 32,
              color: "var(--text-3)",
              fontSize: 12,
              textAlign: "center",
            }}
          >
            读取中…
          </div>
        ) : snapshots.length === 0 ? (
          <div
            style={{
              padding: 24,
              color: "var(--text-3)",
              fontSize: 12,
              textAlign: "center",
              lineHeight: 1.6,
            }}
          >
            还没有快照。保存（{shortcutText("⌘S")}）后会在
            <br />
            <code
              style={{
                fontSize: 10,
                background: "var(--bg-pane-2)",
                padding: "1px 6px",
                borderRadius: 4,
              }}
            >
              .markio/history/
            </code>
            里留一份。
          </div>
        ) : (
          snapshots.map((s) => {
            const isPreview = preview?.ts === s.timestamp;
            return (
              <div
                key={s.path}
                className={"history-item" + (isPreview ? " active" : "")}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    cursor: "pointer",
                  }}
                  onClick={() => onPreview(s)}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="t">{formatTs(s.timestamp)}</div>
                    <div className="d">{(s.size / 1024).toFixed(1)} KB</div>
                  </div>
                  <button
                    type="button"
                    className="settings-btn"
                    style={{ padding: "3px 9px", fontSize: 11 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      onRestore(s);
                    }}
                  >
                    恢复
                  </button>
                </div>
                {isPreview && (
                  <div style={{ marginTop: 8 }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        marginBottom: 6,
                        fontSize: 11,
                        color: "var(--text-3)",
                      }}
                    >
                      <div style={{ display: "flex", gap: 2 }}>
                        <button
                          type="button"
                          className="settings-btn"
                          style={{
                            padding: "2px 8px",
                            fontSize: 10,
                            ...(viewMode === "diff"
                              ? { background: "var(--accent)", color: "#fff" }
                              : {}),
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setViewMode("diff");
                          }}
                        >
                          对比当前
                        </button>
                        <button
                          type="button"
                          className="settings-btn"
                          style={{
                            padding: "2px 8px",
                            fontSize: 10,
                            ...(viewMode === "raw"
                              ? { background: "var(--accent)", color: "#fff" }
                              : {}),
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setViewMode("raw");
                          }}
                        >
                          原文
                        </button>
                      </div>
                      {viewMode === "diff" &&
                        (stat.added === 0 && stat.removed === 0 ? (
                          <span>与当前文档一致</span>
                        ) : (
                          <span>
                            <span style={{ color: "var(--green, #3fb950)" }}>
                              +{stat.added}
                            </span>{" "}
                            <span style={{ color: "var(--red, #f85149)" }}>
                              −{stat.removed}
                            </span>{" "}
                            <span style={{ color: "var(--text-4)" }}>
                              （红=此版本有、现已删；绿=当前新增）
                            </span>
                          </span>
                        ))}
                    </div>
                    {viewMode === "raw" ? (
                      <pre
                        style={{
                          padding: 10,
                          background: "var(--bg-pane-2)",
                          border: "0.5px solid var(--border)",
                          borderRadius: 8,
                          fontSize: 11,
                          maxHeight: 220,
                          overflow: "auto",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                          lineHeight: 1.5,
                          color: "var(--text-2)",
                          cursor: "text",
                          userSelect: "text",
                        }}
                      >
                        {preview!.content.slice(0, 2000)}
                        {preview!.content.length > 2000 ? "\n…" : ""}
                      </pre>
                    ) : (
                      <div
                        style={{
                          background: "var(--bg-pane-2)",
                          border: "0.5px solid var(--border)",
                          borderRadius: 8,
                          fontSize: 11,
                          maxHeight: 240,
                          overflow: "auto",
                          lineHeight: 1.5,
                          fontFamily: "var(--font-mono, ui-monospace, monospace)",
                          cursor: "text",
                          userSelect: "text",
                        }}
                      >
                        {diffRows.slice(0, 600).map((row, idx) => (
                          <div
                            key={idx}
                            style={{
                              display: "flex",
                              gap: 6,
                              padding: "0 8px",
                              whiteSpace: "pre-wrap",
                              wordBreak: "break-word",
                              background:
                                row.type === "add"
                                  ? "color-mix(in srgb, var(--green, #3fb950) 16%, transparent)"
                                  : row.type === "del"
                                    ? "color-mix(in srgb, var(--red, #f85149) 16%, transparent)"
                                    : "transparent",
                              color:
                                row.type === "eq"
                                  ? "var(--text-3)"
                                  : "var(--text-2)",
                            }}
                          >
                            <span
                              style={{
                                width: 10,
                                flexShrink: 0,
                                textAlign: "center",
                                color:
                                  row.type === "add"
                                    ? "var(--green, #3fb950)"
                                    : row.type === "del"
                                      ? "var(--red, #f85149)"
                                      : "var(--text-4)",
                              }}
                            >
                              {row.type === "add" ? "+" : row.type === "del" ? "−" : ""}
                            </span>
                            <span style={{ flex: 1, minWidth: 0 }}>
                              {row.text || " "}
                            </span>
                          </div>
                        ))}
                        {diffRows.length > 600 && (
                          <div
                            style={{
                              padding: "4px 8px",
                              color: "var(--text-4)",
                            }}
                          >
                            … 仅显示前 600 行
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
      <div
        style={{
          padding: "10px 14px",
          borderTop: "0.5px solid var(--border)",
          fontSize: 11,
          color: "var(--text-4)",
          textAlign: "center",
        }}
      >
        每次保存自动留快照，仓库根目录 .markio/history/，每文件最多 30 份
      </div>
    </div>
  );
}
