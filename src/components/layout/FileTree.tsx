import { memo, useMemo, useState } from "react";
import { Icon, isIconName } from "../ui/Icon";
import { ContextMenu, type CtxItem } from "../popovers/ContextMenu";
import { IconPicker } from "../popovers/IconPicker";
import { RecentSection } from "./RecentSection";
import { TrashSection } from "./TrashSection";
import { useWorkspace } from "@/stores/workspace";
import { useTabs } from "@/stores/tabs";
import { useFileIcons } from "@/stores/fileIcons";
import { api, pickDirectory } from "@/lib/api";
import { useUI } from "@/stores/ui";
import type { FileEntry } from "@/types";

export function FileTree() {
  const ws = useWorkspace((s) => s.activeWorkspace());
  const tree = useWorkspace((s) => s.activeTree());
  const loading = useWorkspace((s) => s.loading);
  const addWorkspace = useWorkspace((s) => s.addWorkspace);
  const activePath = useTabs((s) =>
    s.tabs.find((t) => t.id === s.activeId)?.path,
  );

  const [ctx, setCtx] = useState<{ x: number; y: number; node: FileEntry } | null>(null);
  const [iconPicker, setIconPicker] = useState<{
    x: number;
    y: number;
    path: string;
  } | null>(null);

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
          正在扫描…
        </div>
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    );
  }

  if (!tree || !tree.children?.length) {
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
          <span className="count">{countMd(tree)}</span>
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
                const { parseError } = await import("@/lib/api");
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
        {tree.children?.map((node) => (
          <TreeNode
            key={node.path}
            node={node}
            depth={0}
            activePath={activePath}
            onContext={(e, n) => {
              e.preventDefault();
              setCtx({ x: e.clientX, y: e.clientY, node: n });
            }}
          />
        ))}
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

const TreeNode = memo(function TreeNode({
  node,
  depth,
  activePath,
  onContext,
}: {
  node: FileEntry;
  depth: number;
  activePath?: string;
  onContext: (e: React.MouseEvent, n: FileEntry) => void;
}) {
  const [open, setOpen] = useState(depth < 1);
  const ws = useWorkspace((s) => s.activeWorkspace());
  const openFile = useTabs((s) => s.openFile);
  const customIcon = useFileIcons((s) => s.icons[node.path]);

  const isActive = activePath === node.path;
  const onClick = async () => {
    if (node.isDir) {
      setOpen((v) => !v);
    } else if (ws) {
      await openFile(ws.id, node.path);
    }
  };

  const indent = useMemo(
    () => ({ paddingLeft: 8 + depth * 12 }),
    [depth],
  );

  return (
    <>
      <div
        className={
          "tree-row" +
          (node.isDir && open ? " open" : "") +
          (isActive ? " selected" : "")
        }
        onClick={onClick}
        onContextMenu={(e) => onContext(e, node)}
        style={indent}
        role="treeitem"
      >
        <span className="chev" style={{ visibility: node.isDir ? "visible" : "hidden" }}>
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
      {node.isDir && open &&
        node.children?.map((c) => (
          <TreeNode
            key={c.path}
            node={c}
            depth={depth + 1}
            activePath={activePath}
            onContext={onContext}
          />
        ))}
    </>
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
  const refreshTree = useWorkspace((s) => s.refreshTree);
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
          if (ws) await refreshTree(ws.id);
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
          flash("已移到回收站");
          await refreshTree(ws.id);
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
          flash("已永久删除");
          if (ws) await refreshTree(ws.id);
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
