import { memo, useCallback, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Icon, isIconName } from "../ui/Icon";
import { ContextMenu, type CtxItem } from "../popovers/ContextMenu";
import { IconPicker } from "../popovers/IconPicker";
import { AttachmentSection } from "./AttachmentSection";
import { RecentSection } from "./RecentSection";
import { TrashSection } from "./TrashSection";
import { useWorkspace } from "@/stores/workspace";
import { useTabs } from "@/stores/tabs";
import { useFileIcons } from "@/stores/fileIcons";
import { api, parseError, pickDirectory } from "@/lib/api";
import { useUI } from "@/stores/ui";
import { useRag } from "@/stores/rag";
import type { FileEntry } from "@/types";

export function FileTree() {
  const ws = useWorkspace((s) => s.activeWorkspace());
  const tree = useWorkspace((s) => s.activeTree());
  const loading = useWorkspace((s) => s.loading);
  const addWorkspace = useWorkspace((s) => s.addWorkspace);
  const refreshTree = useWorkspace((s) => s.refreshTree);
  const loadDir = useWorkspace((s) => s.loadDir);
  const activePath = useTabs((s) =>
    s.tabs.find((t) => t.id === s.activeId)?.path,
  );

  const [ctx, setCtx] = useState<{ x: number; y: number; node: FileEntry } | null>(null);
  const [iconPicker, setIconPicker] = useState<{
    x: number;
    y: number;
    path: string;
  } | null>(null);
  const mdCount = useMemo(() => (tree ? countMd(tree) : 0), [tree]);

  if (!ws) {
    return (
      <div className="tree scroll tree-empty">
        没有打开任何仓库
        <br />
        <button
          type="button"
          onClick={async () => {
            const dir = await pickDirectory();
            if (dir) await addWorkspace(dir);
          }}
        >
          选择文件夹…
        </button>
      </div>
    );
  }

  if (loading && !tree) {
    return (
      <div className="tree scroll tree-empty">
        <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              width: 12,
              height: 12,
              border: "2px solid var(--border-strong)",
              borderTopColor: "var(--accent)",
              borderRadius: "50%",
              animation: "spin 1s linear infinite",
              display: "inline-block",
            }}
          />
          正在加载目录…
        </div>
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    );
  }

  if (!tree) {
    return (
      <div className="tree scroll tree-empty">
        尚未加载当前文件夹。
        <br />
        <button
          type="button"
          onClick={() => {
            void refreshTree(ws.id);
          }}
        >
          加载文件夹…
        </button>
      </div>
    );
  }

  if (!tree.children?.length) {
    return (
      <div className="tree scroll tree-empty">
        当前文件夹里暂时没有 markdown 文件。
      </div>
    );
  }

  return (
    <>
      <div className="tree scroll">
        <RecentSection />
        <div className="tree-section">
          <span style={{ flex: 1 }}>文件</span>
          <span className="count">{mdCount}</span>
          <button
            type="button"
            className="sec-act"
            title="新建笔记"
            style={{ opacity: 1 }}
            onClick={async () => {
              if (!ws) return;
              const name = window.prompt("新笔记文件名（自动追加 .md）", "未命名");
              if (!name) return;
              const fname = name.endsWith(".md") ? name : `${name}.md`;
              const path = `${ws.path}/${fname}`;
              try {
                await api.createNew(path, `# ${fname.replace(/\.md$/i, "")}\n\n`);
                await useWorkspace.getState().refreshTree(ws.id);
                await useTabs.getState().openFile(ws.id, path);
              } catch (e) {
                const err = parseError(e);
                if (err.code === "ALREADY_EXISTS") {
                  const reuse = window.confirm(`${fname} 已存在。打开它？`);
                  if (reuse)
                    await useTabs.getState().openFile(ws.id, path);
                } else {
                  window.alert(`创建失败：${err.message}`);
                }
              }
            }}
          >
            +
          </button>
        </div>
        {tree.truncated && (
          <div
            role="alert"
            style={{
              margin: "4px 10px 8px",
              padding: "8px 10px",
              border: "1px solid #d97706",
              borderLeft: "3px solid #d97706",
              borderRadius: 6,
              background: "rgba(217,119,6,0.08)",
              color: "var(--text-2)",
              fontSize: 12,
              lineHeight: 1.5,
              display: "flex",
              gap: 8,
              alignItems: "flex-start",
            }}
          >
            <span
              aria-hidden
              style={{ flexShrink: 0, fontWeight: 700, color: "#d97706" }}
            >
              !
            </span>
            <div>
              <div style={{ fontWeight: 600, marginBottom: 2 }}>
                列表已截断 · 未显示全部文件
              </div>
              <div style={{ color: "var(--text-3)" }}>
                目录或子项数超过上限（单目录 ≤ 2000 · 总条目 ≤ 8000 · 深度 ≤ 8）。
                文件并未丢失，使用顶部搜索可定位未显示项。
              </div>
            </div>
          </div>
        )}
        <VirtualizedTree
          roots={tree.children ?? []}
          activePath={activePath}
          onLoadDir={(path) => loadDir(ws.id, path)}
          onContext={(e, n) => {
            e.preventDefault();
            setCtx({ x: e.clientX, y: e.clientY, node: n });
          }}
        />
        <AttachmentSection />
        <TrashSection />
      </div>
      {ctx && (
        <TreeContextMenu
          x={ctx.x}
          y={ctx.y}
          node={ctx.node}
          onClose={() => setCtx(null)}
          onChangeIcon={(p, x2, y2) => {
            setCtx(null);
            setIconPicker({ x: x2, y: y2, path: p });
          }}
        />
      )}
      {iconPicker && (
        <IconPicker
          x={iconPicker.x}
          y={iconPicker.y}
          path={iconPicker.path}
          onClose={() => setIconPicker(null)}
        />
      )}
    </>
  );
}

function countMd(node: FileEntry): number {
  if (!node.isDir) return 1;
  return (node.children ?? []).reduce((acc, c) => acc + countMd(c), 0);
}

function parentPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.replace(/\/[^/]+$/, "") || normalized;
}

interface FlatRow {
  node: FileEntry;
  depth: number;
}

function flattenTree(roots: FileEntry[], expanded: Set<string>): FlatRow[] {
  const out: FlatRow[] = [];
  const visit = (node: FileEntry, depth: number) => {
    out.push({ node, depth });
    if (node.isDir && expanded.has(node.path)) {
      for (const child of node.children ?? []) {
        visit(child, depth + 1);
      }
    }
  };
  for (const r of roots) visit(r, 0);
  return out;
}

const ROW_HEIGHT = 26;

function VirtualizedTree({
  roots,
  activePath,
  onLoadDir,
  onContext,
}: {
  roots: FileEntry[];
  activePath?: string;
  onLoadDir: (path: string) => Promise<void>;
  onContext: (e: React.MouseEvent, n: FileEntry) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const flat = useMemo(() => flattenTree(roots, expanded), [roots, expanded]);

  const toggle = useCallback((node: FileEntry) => {
    const willOpen = !expanded.has(node.path);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(node.path)) next.delete(node.path);
      else next.add(node.path);
      return next;
    });
    if (willOpen && node.isDir && node.children == null) {
      void onLoadDir(node.path);
    }
  }, [expanded, onLoadDir]);

  const parentRef = useRef<HTMLDivElement>(null);
  const useVirtual = flat.length > 200;

  const virtualizer = useVirtualizer({
    count: flat.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    enabled: useVirtual,
  });

  if (!useVirtual) {
    return (
      <>
        {flat.map(({ node, depth }) => (
          <TreeRow
            key={node.path}
            node={node}
            depth={depth}
            isOpen={expanded.has(node.path)}
            activePath={activePath}
            onToggle={toggle}
            onContext={onContext}
          />
        ))}
      </>
    );
  }

  const items = virtualizer.getVirtualItems();
  return (
    <div
      ref={parentRef}
      style={{
        height: "100%",
        overflowY: "auto",
        position: "relative",
      }}
    >
      <div
        style={{
          height: virtualizer.getTotalSize(),
          position: "relative",
        }}
      >
        {items.map((vi) => {
          const row = flat[vi.index];
          return (
            <div
              key={row.node.path}
              style={{
                position: "absolute",
                top: vi.start,
                left: 0,
                right: 0,
                height: ROW_HEIGHT,
              }}
            >
              <TreeRow
                node={row.node}
                depth={row.depth}
                isOpen={expanded.has(row.node.path)}
                activePath={activePath}
                onToggle={toggle}
                onContext={onContext}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

const TreeRow = memo(function TreeRow({
  node,
  depth,
  isOpen,
  activePath,
  onToggle,
  onContext,
}: {
  node: FileEntry;
  depth: number;
  isOpen: boolean;
  activePath?: string;
  onToggle: (node: FileEntry) => void;
  onContext: (e: React.MouseEvent, n: FileEntry) => void;
}) {
  const ws = useWorkspace((s) => s.activeWorkspace());
  const openFile = useTabs((s) => s.openFile);
  const customIcon = useFileIcons((s) => s.icons[node.path]);

  const isActive = activePath === node.path;
  const onClick = async () => {
    if (node.isDir) {
      onToggle(node);
    } else if (ws) {
      await openFile(ws.id, node.path);
    }
  };

  return (
    <div
      className={
        "tree-row" +
        (node.isDir && isOpen ? " open" : "") +
        (isActive ? " selected" : "")
      }
      onClick={onClick}
      onContextMenu={(e) => onContext(e, node)}
      style={{ paddingLeft: 8 + depth * 12 }}
      role="treeitem"
    >
      <span
        className="chev"
        style={{ visibility: node.isDir ? "visible" : "hidden" }}
      >
        <Icon name="chevron" size={11} />
      </span>
      <span className="ico">
        {isIconName(customIcon) ? (
          <Icon name={customIcon} size={13} />
        ) : node.isDir ? (
          <Icon name="folder" size={13} />
        ) : (
          <Icon name="file" size={13} />
        )}
      </span>
      <span className="lbl">{node.name}</span>
    </div>
  );
});

function TreeContextMenu({
  x,
  y,
  node,
  onClose,
  onChangeIcon,
}: {
  x: number;
  y: number;
  node: FileEntry;
  onClose: () => void;
  onChangeIcon: (path: string, x: number, y: number) => void;
}) {
  const ws = useWorkspace((s) => s.activeWorkspace());
  const loadDir = useWorkspace((s) => s.loadDir);
  const setToast = useUI((s) => s.setToast);
  const openFile = useTabs((s) => s.openFile);
  const closeTabsForPath = useTabsForPath();

  const flash = (msg: string) => {
    setToast({ stage: "done", message: msg });
    setTimeout(() => setToast(null), 1800);
  };

  const baseItems: CtxItem[] = [];
  if (!node.isDir) {
    baseItems.push({
      label: "在新标签页打开",
      icon: "external",
      onClick: () => {
        if (ws) openFile(ws.id, node.path);
      },
    });
    baseItems.push({ sep: true });
  }
  const items: CtxItem[] = [
    ...baseItems,
    {
      label: "在 Finder 中显示",
      icon: "folder-open",
      onClick: async () => {
        try {
          await api.reveal(node.path);
        } catch (e) {
          setToast({ stage: "error", message: `打开失败：${(e as Error).message}` });
          setTimeout(() => setToast(null), 2500);
        }
      },
    },
    {
      label: "复制路径",
      icon: "copy",
      onClick: async () => {
        try {
          await navigator.clipboard.writeText(node.path);
          flash("已复制路径");
        } catch {
          /* ignore */
        }
      },
    },
    {
      label: "更改图标…",
      icon: "palette",
      onClick: () => onChangeIcon(node.path, x, y),
    },
    { sep: true },
    {
      label: "重命名…",
      icon: "edit",
      onClick: async () => {
        const next = window.prompt("新名字", node.name);
        if (!next || next === node.name) return;
        const parent = node.path.replace(/[\\/][^\\/]+$/, "");
        const to = `${parent}/${next}`;
        try {
          await api.rename(node.path, to);
          flash("已重命名");
          if (ws) {
            void ragRemoveSilently(ws.path, node.path);
            await loadDir(ws.id, parentPath(node.path));
          }
        } catch (e) {
          setToast({
            stage: "error",
            message: `重命名失败：${(e as Error).message}`,
          });
          setTimeout(() => setToast(null), 2500);
        }
      },
    },
    {
      label: node.isDir ? "移到回收站…" : "移到回收站",
      icon: "trash",
      danger: true,
      onClick: async () => {
        if (!ws) return;
        if (node.isDir) {
          setToast({
            stage: "error",
            message: "回收站暂不支持目录，请使用 删除文件夹（永久）",
          });
          setTimeout(() => setToast(null), 2500);
          return;
        }
        try {
          await api.trashMove(ws.path, node.path);
          closeTabsForPath(node.path);
          void ragRemoveSilently(ws.path, node.path);
          flash("已移到回收站");
          await loadDir(ws.id, parentPath(node.path));
        } catch (e) {
          setToast({
            stage: "error",
            message: `移到回收站失败：${(e as Error).message}`,
          });
          setTimeout(() => setToast(null), 2500);
        }
      },
    },
    {
      label: "永久删除…",
      icon: "trash",
      danger: true,
      onClick: async () => {
        const ok = window.confirm(
          `永久删除 ${node.name}？无法从回收站恢复。`,
        );
        if (!ok) return;
        try {
          await api.remove(node.path);
          closeTabsForPath(node.path);
          if (ws) {
            void ragRemoveSilently(ws.path, node.path);
            await loadDir(ws.id, parentPath(node.path));
          }
          flash("已永久删除");
        } catch (e) {
          setToast({
            stage: "error",
            message: `删除失败：${(e as Error).message}`,
          });
          setTimeout(() => setToast(null), 2500);
        }
      },
    },
  ];

  return <ContextMenu x={x} y={y} items={items} onClose={onClose} />;
}

/** 顺手把 RAG 索引里的旧记录擦掉；失败仅吞掉 */
async function ragRemoveSilently(workspace: string, file: string) {
  try {
    await useRag.getState().removeFile(workspace, file);
  } catch {
    /* ignore */
  }
}

/** 删除文件后顺手关闭已打开的相关 tab */
function useTabsForPath() {
  const tabs = useTabs((s) => s.tabs);
  const closeTab = useTabs((s) => s.closeTab);
  return (path: string) => {
    for (const t of tabs) {
      if (t.path === path || t.path.startsWith(path + "/")) {
        closeTab(t.id);
      }
    }
  };
}
