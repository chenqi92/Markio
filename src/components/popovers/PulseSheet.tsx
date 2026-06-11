import { useEffect, useMemo, useState } from "react";
import { Icon } from "../ui/Icon";
import { useUI } from "@/stores/ui";
import { useTabs } from "@/stores/tabs";
import { useWorkspace } from "@/stores/workspace";
import { api } from "@/lib/api";
import type { TimelineEntry } from "@/types";

function startOfDay(ts: number) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function groupLabel(ts: number, now: number): string {
  const dayMs = 86400000;
  const today = startOfDay(now);
  const day = startOfDay(ts);
  const diff = Math.round((today - day) / dayMs);
  if (diff === 0) return "今天";
  if (diff === 1) return "昨天";
  if (diff < 7) return "本周";
  if (diff < 14) return "上周";
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function timeOf(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function PulseSheet() {
  const open = useUI((s) => s.pulseOpen);
  const close = () => useUI.getState().openPulse(false);
  const setToast = useUI((s) => s.setToast);
  const activeWorkspaceId = useWorkspace((s) => s.activeId);
  const ws = useWorkspace((s) =>
    s.workspaces.find((w) => w.id === activeWorkspaceId),
  );
  const openPath = useTabs((s) => s.openPath);

  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<{
    snapshotPath: string;
    content: string;
  } | null>(null);

  useEffect(() => {
    if (!open || !ws) {
      setEntries([]);
      setPreview(null);
      return;
    }
    setLoading(true);
    api
      .historyListAll(ws.path)
      .then((s) => setEntries(s))
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, [open, ws]);

  const grouped = useMemo(() => {
    const now = Date.now();
    const map = new Map<string, TimelineEntry[]>();
    for (const e of entries) {
      const k = groupLabel(e.timestamp, now);
      const arr = map.get(k) ?? [];
      arr.push(e);
      map.set(k, arr);
    }
    return Array.from(map.entries());
  }, [entries]);

  if (!open) return null;

  const onPreview = async (e: TimelineEntry) => {
    if (preview?.snapshotPath === e.snapshotPath) {
      setPreview(null);
      return;
    }
    try {
      const c = await api.historyRead(e.snapshotPath);
      setPreview({ snapshotPath: e.snapshotPath, content: c });
    } catch (err) {
      setToast({ stage: "error", message: `读取失败：${(err as Error).message}` });
    }
  };

  const onOpenSource = async (e: TimelineEntry) => {
    try {
      await openPath(e.sourcePath);
      close();
    } catch (err) {
      setToast({ stage: "error", message: `打开失败：${(err as Error).message}` });
    }
  };

  return (
    <div className="history-sheet">
      <div className="history-hd">
        <span>
          时间线{" "}
          <span style={{ color: "var(--text-3)", fontSize: 11, fontWeight: 400 }}>
            {entries.length} 个快照
          </span>
        </span>
        <button onClick={close} type="button" title="关闭">
          <Icon name="x" size={14} />
        </button>
      </div>
      <div className="history-list">
        {!ws ? (
          <div style={emptyStyle}>没有打开的仓库</div>
        ) : loading ? (
          <div style={emptyStyle}>读取中…</div>
        ) : entries.length === 0 ? (
          <div style={{ ...emptyStyle, lineHeight: 1.6 }}>
            还没有快照。
            <br />
            保存任意笔记会在 .markio/history/ 留一份。
          </div>
        ) : (
          grouped.map(([label, list]) => (
            <div key={label} style={{ marginBottom: 6 }}>
              <div
                style={{
                  padding: "8px 14px 4px",
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: 0.5,
                  textTransform: "uppercase",
                  color: "var(--text-3)",
                }}
              >
                {label}
              </div>
              {list.map((e) => {
                const isPreview = preview?.snapshotPath === e.snapshotPath;
                return (
                  <div
                    key={e.snapshotPath}
                    className={"history-item" + (isPreview ? " active" : "")}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        cursor: "pointer",
                      }}
                      onClick={() => onPreview(e)}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          className="t"
                          style={{
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {e.sourceName}
                        </div>
                        <div className="d">
                          {timeOf(e.timestamp)} · {(e.size / 1024).toFixed(1)} KB
                        </div>
                      </div>
                      <button
                        type="button"
                        className="settings-btn"
                        style={{ padding: "3px 9px", fontSize: 11 }}
                        onClick={(ev) => {
                          ev.stopPropagation();
                          onOpenSource(e);
                        }}
                        title="打开当前笔记"
                      >
                        打开
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
              })}
            </div>
          ))
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
        当前仓库 .markio/history/ 全部快照（每文件保留 30 份）
      </div>
    </div>
  );
}

const emptyStyle: React.CSSProperties = {
  padding: 32,
  color: "var(--text-3)",
  fontSize: 12,
  textAlign: "center",
};
