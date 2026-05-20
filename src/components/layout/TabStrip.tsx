import { useEffect, useRef, useState } from "react";
import { Icon } from "../ui/Icon";
import { ContextMenu, type CtxItem } from "../popovers/ContextMenu";
import { useTabs } from "@/stores/tabs";
import { useUI } from "@/stores/ui";
import { useDialog } from "@/stores/dialog";
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
  const saveTab = useTabs((s) => s.saveTab);
  const togglePin = useTabs((s) => s.togglePin);
  const reorderTabs = useTabs((s) => s.reorderTabs);
  const setToast = useUI((s) => s.setToast);
  const confirmDialog = useDialog((s) => s.confirm);
  const [ctx, setCtx] = useState<{ x: number; y: number; tab: TabStripItem } | null>(null);
  const dragFrom = useRef<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);

  // 把 pinned 排前面，和 TabStrip 的可视顺序保持一致。
  const ordered = [...tabs].sort((a, b) => {
    if (a.pinned === b.pinned) return 0;
    return a.pinned ? -1 : 1;
  });

  const showToast = (
    stage: "done" | "error",
    message: string,
    timeout = stage === "error" ? 2500 : 1500,
  ) => {
    setToast({ stage, message });
    window.setTimeout(() => setToast(null), timeout);
  };

  const copyValue = async (value: string, message: string) => {
    try {
      await writeText(value);
      showToast("done", message);
    } catch (e) {
      showToast("error", `复制失败：${(e as Error).message}`);
    }
  };

  const confirmDirtyTabs = async (targets: TabStripItem[], action: string) => {
    const dirty = targets.filter((x) => x.dirty);
    if (dirty.length === 0) return true;
    const suffix = dirty.length > 1 ? ` 等 ${dirty.length} 个标签` : "";
    return confirmDialog({
      title: "关闭未保存标签？",
      message: `${action}包含未保存的标签（${dirty[0].title}${suffix}）。继续关闭会丢失修改。`,
      confirmLabel: "关闭",
      danger: true,
    });
  };

  const closeTabs = async (targets: TabStripItem[], action: string) => {
    if (targets.length === 0) {
      showToast("done", "没有可关闭的标签");
      return;
    }
    if (!(await confirmDirtyTabs(targets, action))) return;
    for (const x of targets) closeTab(x.id);
  };

  const confirmAndClose = async (t: TabStripItem) => {
    await closeTabs([t], "关闭当前标签");
  };

  const items = (t: TabStripItem): CtxItem[] => {
    const index = ordered.findIndex((x) => x.id === t.id);
    const left = index >= 0 ? ordered.slice(0, index).filter((x) => !x.pinned) : [];
    const right = index >= 0 ? ordered.slice(index + 1).filter((x) => !x.pinned) : [];
    const others = ordered.filter((x) => x.id !== t.id && !x.pinned);
    const saved = ordered.filter((x) => !x.dirty && !x.pinned);
    const unpinned = ordered.filter((x) => !x.pinned);
    const menu: CtxItem[] = [
      {
        label: "切换到此标签",
        icon: "file",
        onClick: () => setActive(t.id),
      },
    ];

    if (t.dirty) {
      menu.push({
        label: "保存",
        icon: "save",
        onClick: async () => {
          const result = await saveTab(t.id);
          if (result === "ok") {
            showToast("done", "已保存");
          } else if (result === "conflict") {
            showToast("error", "保存冲突，请先处理磁盘版本");
          } else {
            showToast("error", "保存失败");
          }
        },
      });
    }

    menu.push(
      {
        label: t.pinned ? "取消固定" : "固定到最前",
        icon: "pin",
        onClick: () => togglePin(t.id),
      },
      { sep: true },
      {
        label: "复制标题",
        icon: "copy",
        onClick: () => copyValue(t.title, "已复制标题"),
      },
      {
        label: "复制路径",
        icon: "copy",
        onClick: () => copyValue(t.path, "已复制路径"),
      },
      {
        label: "在 Finder 中显示",
        icon: "folder-open",
        onClick: async () => {
          try {
            await api.reveal(t.path);
          } catch (e) {
            showToast("error", `打开失败：${(e as Error).message}`);
          }
        },
      },
      { sep: true },
      {
        label: "关闭当前标签",
        icon: "x",
        onClick: () => void confirmAndClose(t),
      },
      {
        label: "关闭左侧标签",
        icon: "close",
        disabled: left.length === 0,
        onClick: () => void closeTabs(left, "关闭左侧标签"),
      },
      {
        label: "关闭右侧标签",
        icon: "close",
        disabled: right.length === 0,
        onClick: () => void closeTabs(right, "关闭右侧标签"),
      },
      {
        label: "关闭其它标签",
        icon: "close",
        disabled: others.length === 0,
        onClick: () => void closeTabs(others, "关闭其它标签"),
      },
      {
        label: "关闭已保存标签",
        icon: "check",
        disabled: saved.length === 0,
        onClick: () => void closeTabs(saved, "关闭已保存标签"),
      },
      {
        label: "关闭未固定标签",
        icon: "close",
        disabled: unpinned.length === 0,
        onClick: () => void closeTabs(unpinned, "关闭未固定标签"),
      },
      {
        label: "关闭所有标签",
        icon: "trash",
        danger: true,
        onClick: () => void closeTabs(ordered, "关闭所有标签"),
      },
    );

    return menu;
  };

  if (tabs.length === 0) return null;

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
              if (e.button === 1) void confirmAndClose(t);
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
                  void confirmAndClose(t);
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
