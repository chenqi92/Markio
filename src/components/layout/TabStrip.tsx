import { useEffect, useRef, useState } from "react";
import { Icon } from "../ui/Icon";
import { ContextMenu, type CtxItem } from "../popovers/ContextMenu";
import { useTabs } from "@/stores/tabs";
import { useUI } from "@/stores/ui";
import { api } from "@/lib/api";
import { writeText } from "@/lib/clipboard";
import { classNames } from "@/lib/utils";
import type { TabInfo } from "@/types";

type TabStripItem = Pick<TabInfo, "id" | "path" | "title" | "dirty" | "pinned">;

function selectTabStripItems(): TabStripItem[] {
  return useTabs
    .getState()
    .tabs.map(({ id, path, title, dirty, pinned }) => ({
      id,
      path,
      title,
      dirty,
      pinned,
    }));
}

function sameTabStripItems(a: TabStripItem[], b: TabStripItem[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.id !== y.id ||
      x.path !== y.path ||
      x.title !== y.title ||
      x.dirty !== y.dirty ||
      x.pinned !== y.pinned
    ) {
      return false;
    }
  }
  return true;
}

function useTabStripItems(): TabStripItem[] {
  const [items, setItems] = useState(selectTabStripItems);
  useEffect(
    () =>
      useTabs.subscribe(() => {
        setItems((prev) => {
          const next = selectTabStripItems();
          return sameTabStripItems(prev, next) ? prev : next;
        });
      }),
    [],
  );
  return items;
}

export function TabStrip() {
  const tabs = useTabStripItems();
  const activeId = useTabs((s) => s.activeId);
  const setActive = useTabs((s) => s.setActive);
  const closeTab = useTabs((s) => s.closeTab);
  const togglePin = useTabs((s) => s.togglePin);
  const reorderTabs = useTabs((s) => s.reorderTabs);
  const setToast = useUI((s) => s.setToast);
  const [ctx, setCtx] = useState<{ x: number; y: number; tab: TabStripItem } | null>(null);
  const dragFrom = useRef<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);

  const confirmAndClose = (t: TabStripItem) => {
    if (t.dirty) {
      const ok = window.confirm(
        `${t.title} 还有未保存的修改。继续关闭会丢失。`,
      );
      if (!ok) return;
    }
    closeTab(t.id);
  };

  const items = (t: TabStripItem): CtxItem[] => [
    {
      label: t.pinned ? "取消固定" : "固定到最前",
      icon: "pin",
      onClick: () => togglePin(t.id),
    },
    { sep: true },
    {
      label: "复制路径",
      icon: "copy",
      onClick: async () => {
        try {
          await writeText(t.path);
          setToast({ stage: "done", message: "已复制路径" });
          setTimeout(() => setToast(null), 1500);
        } catch {
          /* ignore */
        }
      },
    },
    {
      label: "在 Finder 中显示",
      icon: "folder-open",
      onClick: async () => {
        try {
          await api.reveal(t.path);
        } catch (e) {
          setToast({
            stage: "error",
            message: `打开失败：${(e as Error).message}`,
          });
          setTimeout(() => setToast(null), 2500);
        }
      },
    },
    { sep: true },
    {
      label: "关闭其它标签",
      icon: "close",
      onClick: () => {
        const others = useTabs.getState().tabs.filter((x) => x.id !== t.id && !x.pinned);
        const dirty = others.find((x) => x.dirty);
        if (dirty) {
          const ok = window.confirm(
            `有未保存的标签（${dirty.title}）。继续关闭会丢失。`,
          );
          if (!ok) return;
        }
        for (const x of others) closeTab(x.id);
      },
    },
    {
      label: "关闭所有标签",
      icon: "trash",
      danger: true,
      onClick: () => {
        const anyDirty = useTabs.getState().tabs.some((x) => x.dirty);
        if (anyDirty) {
          const ok = window.confirm("有未保存的标签，继续关闭会丢失。");
          if (!ok) return;
        }
        for (const x of useTabs.getState().tabs) closeTab(x.id);
      },
    },
    { sep: true },
    {
      label: "关闭",
      icon: "x",
      onClick: () => confirmAndClose(t),
    },
  ];

  if (tabs.length === 0) return null;

  // 把 pinned 排前面
  const ordered = [...tabs].sort((a, b) => {
    if (a.pinned === b.pinned) return 0;
    return a.pinned ? -1 : 1;
  });

  return (
    <>
      <div className="tabstrip">
        {ordered.map((t) => (
          <div
            key={t.id}
            role="tab"
            draggable={!t.pinned}
            className={classNames(
              "tab",
              t.id === activeId && "active",
              t.dirty && "unsaved",
              t.pinned && "pinned",
              dragOver === t.id && "drag-over",
            )}
            onClick={() => setActive(t.id)}
            onAuxClick={(e) => {
              if (e.button === 1) confirmAndClose(t);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setCtx({ x: e.clientX, y: e.clientY, tab: t });
            }}
            onDragStart={(e) => {
              if (t.pinned) return;
              dragFrom.current = t.id;
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              if (!dragFrom.current || dragFrom.current === t.id) return;
              if (t.pinned) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (dragOver !== t.id) setDragOver(t.id);
            }}
            onDragLeave={() => {
              if (dragOver === t.id) setDragOver(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              const fromId = dragFrom.current;
              dragFrom.current = null;
              setDragOver(null);
              if (!fromId || fromId === t.id) return;
              reorderTabs(fromId, t.id);
            }}
            onDragEnd={() => {
              dragFrom.current = null;
              setDragOver(null);
            }}
            title={t.path}
          >
            <span className="ico">
              <Icon name={t.pinned ? "pin" : "file"} size={12} />
            </span>
            <span className="lbl">{t.title}</span>
            {t.dirty ? <span className="dot-unsaved" /> : null}
            {!t.pinned && (
              <span
                className="close"
                role="button"
                onClick={(e) => {
                  e.stopPropagation();
                  confirmAndClose(t);
                }}
              >
                ×
              </span>
            )}
          </div>
        ))}
        <div className="spacer" />
      </div>
      {ctx && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          items={items(ctx.tab)}
          onClose={() => setCtx(null)}
        />
      )}
    </>
  );
}
