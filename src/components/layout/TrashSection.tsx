import { useEffect, useState } from "react";
import { Icon } from "../ui/Icon";
import { api } from "@/lib/api";
import { useWorkspace } from "@/stores/workspace";
import { useUI } from "@/stores/ui";
import type { TrashItem } from "@/types";

function daysAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  const d = Math.floor(diff / 86_400_000);
  return `${d} 天前`;
}

export function TrashSection() {
  const ws = useWorkspace((s) => s.activeWorkspace());
  const refreshTree = useWorkspace((s) => s.refreshTree);
  const setToast = useUI((s) => s.setToast);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<TrashItem[]>([]);

  const reload = async () => {
    if (!ws) return;
    try {
      const list = await api.trashList(ws.path);
      setItems(list);
    } catch {
      setItems([]);
    }
  };

  useEffect(() => {
    if (open && ws) reload();
  }, [open, ws?.id]);

  if (!ws) return null;

  const restore = async (it: TrashItem) => {
    try {
      await api.trashRestore(ws.path, it.path);
      setToast({ stage: "done", message: "已恢复" });
      setTimeout(() => setToast(null), 1500);
      await refreshTree(ws.id);
      await reload();
    } catch (e) {
      setToast({
        stage: "error",
        message: `恢复失败：${(e as Error).message}`,
      });
      setTimeout(() => setToast(null), 2500);
    }
  };

  const purge = async (it: TrashItem) => {
    const ok = window.confirm(`永久删除 ${it.name}？`);
    if (!ok) return;
    try {
      await api.trashPurge(ws.path, it.path);
      await reload();
    } catch (e) {
      setToast({
        stage: "error",
        message: `删除失败：${(e as Error).message}`,
      });
      setTimeout(() => setToast(null), 2500);
    }
  };

  const purgeAll = async () => {
    const ok = window.confirm(`清空回收站（${items.length} 项）？`);
    if (!ok) return;
    try {
      await api.trashPurge(ws.path);
      await reload();
    } catch (e) {
      setToast({
        stage: "error",
        message: `清空失败：${(e as Error).message}`,
      });
      setTimeout(() => setToast(null), 2500);
    }
  };

  return (
    <div className="trash-section">
      <div
        className="tree-section"
        style={{ marginTop: 10, cursor: "pointer" }}
        onClick={() => setOpen((v) => !v)}
      >
        <span
          style={{
            display: "inline-block",
            width: 12,
            fontSize: 9,
            color: "var(--text-3)",
            transform: open ? "rotate(90deg)" : "none",
            transition: "transform 160ms",
          }}
        >
          ▸
        </span>
        <span style={{ flex: 1 }}>回收站</span>
        <span className="count">{items.length}</span>
      </div>
      {open && (
        <>
          {items.length === 0 ? (
            <div
              style={{
                padding: "8px 14px",
                fontSize: 11,
                color: "var(--text-3)",
              }}
            >
              空
            </div>
          ) : (
            <div style={{ paddingLeft: 14 }}>
              {items.map((it) => (
                <div
                  key={it.path}
                  className="tree-row trash-row"
                  title={it.original}
                  style={{ opacity: 0.85 }}
                >
                  <span className="ico" style={{ opacity: 0.65 }}>
                    <Icon name="file" size={13} />
                  </span>
                  <span className="lbl" style={{ color: "var(--text-3)" }}>
                    {it.name}
                  </span>
                  <span style={{ fontSize: 10, color: "var(--text-4)" }}>
                    {daysAgo(it.timestamp)}
                  </span>
                  <button
                    type="button"
                    className="trash-act"
                    title="恢复"
                    onClick={(e) => {
                      e.stopPropagation();
                      restore(it);
                    }}
                  >
                    <Icon name="history" size={12} />
                  </button>
                  <button
                    type="button"
                    className="trash-act danger"
                    title="永久删除"
                    onClick={(e) => {
                      e.stopPropagation();
                      purge(it);
                    }}
                  >
                    <Icon name="trash" size={12} />
                  </button>
                </div>
              ))}
              {items.length > 0 && (
                <div
                  style={{
                    padding: "6px 14px 10px",
                    display: "flex",
                    gap: 8,
                    fontSize: 11,
                  }}
                >
                  <button
                    type="button"
                    style={{
                      color: "#ff453a",
                      fontWeight: 500,
                      cursor: "pointer",
                    }}
                    onClick={purgeAll}
                  >
                    清空回收站
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
