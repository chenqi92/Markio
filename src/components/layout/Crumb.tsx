import { useEffect, useRef, useState } from "react";
import { crumbSegments, displayPath } from "@/lib/utils";
import { useWorkspace } from "@/stores/workspace";
import { useTabs } from "@/stores/tabs";
import { useUI } from "@/stores/ui";
import { api } from "@/lib/api";
import { writeText } from "@/lib/clipboard";
import { ContextMenu } from "../popovers/ContextMenu";
import { Icon } from "../ui/Icon";
import type { FileEntry } from "@/types";

interface NavState {
  dir: string;
  entries: FileEntry[];
  loading: boolean;
  anchor: { x: number; y: number };
}

export function Crumb() {
  const ws = useWorkspace((s) => s.activeWorkspace());
  const tabPath = useTabs((s) => {
    const id = s.activeId;
    return id ? s.tabs.find((t) => t.id === id)?.path : undefined;
  });
  const setToast = useUI((s) => s.setToast);
  const [ctx, setCtx] = useState<
    { x: number; y: number; absPath: string; isLeaf: boolean } | null
  >(null);
  const [nav, setNav] = useState<NavState | null>(null);
  const navToken = useRef(0);

  useEffect(() => {
    if (!nav) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest(".crumb-menu") || t?.closest(".crumb .seg")) return;
      setNav(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNav(null);
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [nav]);

  if (!ws || !tabPath) return null;
  const segs = crumbSegments(ws.path, tabPath);
  if (segs.length === 0) return null;

  const flash = (msg: string) => {
    setToast({ stage: "done", message: msg });
    setTimeout(() => setToast(null), 1500);
  };

  // 在仓库根之下还原每段对应的绝对路径：第 0 段 = ws.path，后续累加。
  const sep = ws.path.includes("\\") ? "\\" : "/";
  const absFor = (i: number): string => {
    if (i === 0) return ws.path;
    return ws.path + sep + segs.slice(1, i + 1).join(sep);
  };

  // 某一级对应「要列出的目录」：文件夹段 = 它自身；叶子（当前文件）= 它的父目录，
  // 这样点叶子能直接看到同目录其它文件、快速切换。
  const dirFor = (i: number): string => {
    const isLeaf = i === segs.length - 1;
    if (isLeaf) return i === 0 ? ws.path : absFor(i - 1);
    return absFor(i);
  };

  const loadDir = (dir: string, anchor: { x: number; y: number }) => {
    const token = ++navToken.current;
    setNav({ dir, entries: [], loading: true, anchor });
    void api
      .readDir(dir)
      .then((entry) => {
        if (navToken.current !== token) return;
        setNav({
          dir,
          entries: entry.children ?? [],
          loading: false,
          anchor,
        });
      })
      .catch(() => {
        if (navToken.current !== token) return;
        setNav({ dir, entries: [], loading: false, anchor });
      });
  };

  const openSeg = (i: number, el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    const anchor = { x: rect.left, y: rect.bottom + 4 };
    const dir = dirFor(i);
    if (nav && nav.dir === dir) {
      setNav(null);
      return;
    }
    loadDir(dir, anchor);
  };

  const parentOf = (dir: string): string | null => {
    if (dir.length <= ws.path.length) return null;
    const idx = dir.lastIndexOf(sep);
    if (idx < 0) return null;
    const parent = dir.slice(0, idx);
    return parent.length >= ws.path.length ? parent : ws.path;
  };

  const onEntry = (entry: FileEntry) => {
    if (entry.isDir) {
      loadDir(entry.path, nav!.anchor);
    } else {
      void useTabs.getState().openPath(entry.path);
      setNav(null);
    }
  };

  return (
    <>
      <div className="crumb" title={displayPath(tabPath)}>
        {segs.map((s, i) => {
          const isLeaf = i === segs.length - 1;
          return (
            <span
              key={i}
              style={{ display: "inline-flex", alignItems: "center" }}
            >
              <span
                className={"seg" + (isLeaf ? " current" : "")}
                onClick={(e) => openSeg(i, e.currentTarget)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setCtx({
                    x: e.clientX,
                    y: e.clientY,
                    absPath: absFor(i),
                    isLeaf,
                  });
                }}
              >
                {s}
              </span>
              {i < segs.length - 1 && <span className="sep">›</span>}
            </span>
          );
        })}
      </div>

      {nav && (
        <div
          className="crumb-menu"
          style={{ left: nav.anchor.x, top: nav.anchor.y }}
        >
          {parentOf(nav.dir) && (
            <button
              type="button"
              className="crumb-menu-item crumb-menu-up"
              onClick={() => loadDir(parentOf(nav.dir)!, nav.anchor)}
            >
              <Icon name="chevron" size={13} />
              <span className="lbl">上级目录</span>
            </button>
          )}
          {nav.loading ? (
            <div className="crumb-menu-empty">加载中…</div>
          ) : nav.entries.length === 0 ? (
            <div className="crumb-menu-empty">空目录</div>
          ) : (
            nav.entries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                className={
                  "crumb-menu-item" +
                  (entry.path === tabPath ? " active" : "") +
                  (entry.isDir ? " is-dir" : "")
                }
                onClick={() => onEntry(entry)}
              >
                <Icon name={entry.isDir ? "folder" : "file"} size={13} />
                <span className="lbl">{entry.name}</span>
                {entry.isDir && (
                  <Icon name="chevron" size={12} />
                )}
              </button>
            ))
          )}
        </div>
      )}

      {ctx && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          onClose={() => setCtx(null)}
          items={[
            {
              label: ctx.isLeaf ? "在 Finder 中显示" : "在 Finder 中打开此目录",
              icon: "folder-open",
              onClick: () => {
                void api.reveal(ctx.absPath);
              },
            },
            {
              label: ctx.isLeaf ? "复制文件路径" : "复制目录路径",
              icon: "copy",
              onClick: async () => {
                try {
                  await writeText(ctx.absPath);
                  flash("已复制路径");
                } catch {
                  /* ignore */
                }
              },
            },
          ]}
        />
      )}
    </>
  );
}
