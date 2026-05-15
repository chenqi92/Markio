import { useEffect, useState } from "react";
import { Icon } from "../ui/Icon";
import { useUI } from "@/stores/ui";
import { useTabs } from "@/stores/tabs";
import { useWorkspace } from "@/stores/workspace";
import { api } from "@/lib/api";
import { shortcutText } from "@/lib/shortcuts";
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
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [preview, setPreview] = useState<{ ts: number; content: string } | null>(
    null,
  );
  const [loading, setLoading] = useState(false);

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
  }, [open, tabPath, ws?.id]);

  if (!open) return null;

  const onPreview = async (s: Snapshot) => {
    try {
      const c = await api.historyRead(s.path);
      setPreview({ ts: s.timestamp, content: c });
    } catch (e) {
      setToast({
        stage: "error",
        message: `读取失败：${(e as Error).message}`,
      });
      setTimeout(() => setToast(null), 2500);
    }
  };

  const onRestore = (s: Snapshot) => {
    if (!tabId) return;
    const ok = window.confirm(
      `恢复到 ${formatTs(s.timestamp)} 的版本？未保存的更改会丢失。`,
    );
    if (!ok) return;
    api
      .historyRead(s.path)
      .then((c) => {
        updateContent(tabId, c);
        setToast({ stage: "done", message: "已恢复（记得保存）" });
        setTimeout(() => setToast(null), 2000);
      })
      .catch((e: Error) => {
        setToast({
          stage: "error",
          message: `恢复失败：${e.message}`,
        });
        setTimeout(() => setToast(null), 2500);
      });
    close();
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
                  <pre
                    style={{
                      marginTop: 8,
                      padding: 10,
                      background: "var(--bg-pane-2)",
                      border: "0.5px solid var(--border)",
                      borderRadius: 8,
                      fontSize: 11,
                      maxHeight: 180,
                      overflow: "auto",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      lineHeight: 1.5,
                      color: "var(--text-2)",
                      cursor: "text",
                      userSelect: "text",
                    }}
                  >
                    {preview!.content.slice(0, 1500)}
                    {preview!.content.length > 1500 ? "\n…" : ""}
                  </pre>
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
