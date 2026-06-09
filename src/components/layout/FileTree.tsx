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
import { useRecents } from "@/stores/recents";
import { writeText } from "@/lib/clipboard";
import { useFileIcons } from "@/stores/fileIcons";
import { useFileMeta, FILE_COLOR_PALETTE } from "@/stores/fileMeta";
import { api, parseError, pickDirectory } from "@/lib/api";
import { displayPath } from "@/lib/utils";
import { useUI } from "@/stores/ui";
import { useRag } from "@/stores/rag";
import { useDialog } from "@/stores/dialog";
import { FilePropertiesDialog } from "../popovers/FilePropertiesDialog";
import type { FileEntry, TabInfo } from "@/types";

export function FileTree() {
  const ws = useWorkspace((s) => s.activeWorkspace());
  const tree = useWorkspace((s) => s.activeTree());
  const loading = useWorkspace((s) => s.loading);
  const addWorkspace = useWorkspace((s) => s.addWorkspace);
  const refreshTree = useWorkspace((s) => s.refreshTree);
  const loadDir = useWorkspace((s) => s.loadDir);
  const openGlobalSearch = useUI((s) => s.openGlobalSearch);
  const promptDialog = useDialog((s) => s.prompt);
  const confirmDialog = useDialog((s) => s.confirm);
  const alertDialog = useDialog((s) => s.alert);
  const unavailable = useWorkspace((s) =>
    ws ? s.isUnavailable(ws.path) : false,
  );
  const activePath = useTabs((s) =>
    s.tabs.find((t) => t.id === s.activeId)?.path,
  );

  const [ctx, setCtx] = useState<{ x: number; y: number; node: FileEntry } | null>(null);
  const [blankCtx, setBlankCtx] = useState<{ x: number; y: number } | null>(null);
  const [iconPicker, setIconPicker] = useState<{
    x: number;
    y: number;
    path: string;
  } | null>(null);
  const [propertiesFor, setPropertiesFor] = useState<FileEntry | null>(null);
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

  if (unavailable) {
    return (
      <div className="tree scroll tree-empty tree-unavailable">
        <span className="tree-empty-icon" aria-hidden>
          <Icon name="alert" size={18} />
        </span>
        <strong>仓库路径不可用</strong>
        <span className="tree-empty-path">{displayPath(ws.path)}</span>
        <span className="tree-empty-note">
          外接盘未挂载、目录被删除或同步未拉下来时会出现此状态。
        </span>
        <div className="tree-empty-actions">
          <button
            type="button"
            onClick={() => {
              void refreshTree(ws.id);
            }}
          >
            重试
          </button>
          <button
            type="button"
            className="secondary"
            onClick={async () => {
              const dir = await pickDirectory();
              if (dir) await addWorkspace(dir);
            }}
          >
            选择其它文件夹…
          </button>
        </div>
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

  const newNoteAtRoot = async () => {
    if (!ws) return;
    const name = await promptDialog({
      title: "新建笔记",
      message: "输入文件名；未包含 .md 时会自动追加。",
      defaultValue: "未命名",
      confirmLabel: "创建",
    });
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
        const reuse = await confirmDialog({
          title: "文件已存在",
          message: `${fname} 已存在。要打开它吗？`,
          confirmLabel: "打开",
        });
        if (reuse) await useTabs.getState().openFile(ws.id, path);
      } else {
        await alertDialog({ title: "创建失败", message: err.message });
      }
    }
  };
  const newFolderAtRoot = async () => {
    if (!ws) return;
    const name = await promptDialog({
      title: "新建文件夹",
      message: "输入文件夹名称。",
      defaultValue: "新文件夹",
      confirmLabel: "创建",
    });
    if (!name) return;
    try {
      await api.mkdir(`${ws.path}/${name}`);
      await useWorkspace.getState().refreshTree(ws.id);
    } catch (e) {
      await alertDialog({
        title: "创建失败",
        message: (e as Error).message,
      });
    }
  };
  const onBlankContext = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest(".tree-row, .tree-section, .sec-act")) {
      return;
    }
    e.preventDefault();
    setBlankCtx({ x: e.clientX, y: e.clientY });
  };

  return (
    <>
      <div className="tree scroll" onContextMenu={onBlankContext}>
        <RecentSection />
        <div className="tree-section">
          <span style={{ flex: 1 }}>文件</span>
          <span className="count">{mdCount}</span>
          <button
            type="button"
            className="sec-act"
            title="新建笔记"
            style={{ opacity: 1 }}
            onClick={newNoteAtRoot}
          >
            +
          </button>
        </div>
        {tree.truncated && (
          <div role="alert" className="tree-limit-alert">
            <span aria-hidden className="tree-limit-icon">!</span>
            <div>
              <div className="tree-limit-title">列表已截断 · 未显示全部文件</div>
              <div className="tree-limit-copy">
                目录或子项数超过上限（单目录 ≤ 2000 · 总条目 ≤ 8000 · 深度 ≤ 8）。
                文件并未丢失，可用全局搜索定位未显示项。
              </div>
              <button
                type="button"
                className="tree-limit-action"
                onClick={() => openGlobalSearch(true)}
              >
                全局搜索
              </button>
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
          onShowProperties={(n) => {
            setCtx(null);
            setPropertiesFor(n);
          }}
        />
      )}
      {blankCtx && ws && (
        <ContextMenu
          x={blankCtx.x}
          y={blankCtx.y}
          onClose={() => setBlankCtx(null)}
          items={[
            {
              label: "在根目录新建笔记…",
              icon: "file",
              kbd: "⌘N",
              onClick: () => {
                void newNoteAtRoot();
              },
            },
            {
              label: "在根目录新建文件夹…",
              icon: "folder",
              onClick: () => {
                void newFolderAtRoot();
              },
            },
            { sep: true },
            {
              label: "刷新目录树",
              icon: "history",
              onClick: () => {
                void refreshTree(ws.id);
              },
            },
            {
              label: "在 Finder 中显示仓库",
              icon: "folder-open",
              onClick: () => {
                void api.reveal(ws.path);
              },
            },
            {
              label: "复制仓库路径",
              icon: "copy",
              onClick: () => {
                void writeText(ws.path);
              },
            },
          ]}
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
      {propertiesFor && ws && (
        <FilePropertiesDialog
          node={propertiesFor}
          workspacePath={ws.path}
          onClose={() => setPropertiesFor(null)}
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

// 用栈代替递归：JavaScript 引擎对深递归有性能罚分，5000 文件 + 嵌套深的仓库下
// 切换 expanded 的延迟主要花在调用栈管理而非数组 push。栈式实现还能 short-circuit。
function flattenTree(roots: FileEntry[], expanded: Set<string>): FlatRow[] {
  const out: FlatRow[] = [];
  const stack: FlatRow[] = [];
  for (let i = roots.length - 1; i >= 0; i--) {
    stack.push({ node: roots[i]!, depth: 0 });
  }
  while (stack.length > 0) {
    const row = stack.pop()!;
    out.push(row);
    if (row.node.isDir && expanded.has(row.node.path)) {
      const children = row.node.children;
      if (children) {
        for (let i = children.length - 1; i >= 0; i--) {
          stack.push({ node: children[i]!, depth: row.depth + 1 });
        }
      }
    }
  }
  return out;
}

const ROW_HEIGHT = 26;
// 阈值从 200 降到 100：中等仓库（百级文件）开始就用虚拟化，
// React reconcile 量从 N 降到可见窗口（~20），expand/collapse 立刻流畅。
const VIRTUAL_THRESHOLD = 100;

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
  const useVirtual = flat.length > VIRTUAL_THRESHOLD;

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
          const row = flat[vi.index]!;
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
  const meta = useFileMeta((s) => s.byPath[node.path]) ?? {};

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
      <span
        className="lbl"
        style={meta.color ? { color: meta.color, fontWeight: 500 } : undefined}
      >
        {node.name}
      </span>
      {meta.bookmark && (
        <span
          className="tree-meta-pin"
          title="已收藏"
          aria-hidden
          style={{ color: "var(--accent)", marginLeft: 4, fontSize: 10 }}
        >
          ★
        </span>
      )}
      {meta.marks && meta.marks.length > 0 && (
        <span
          className="tree-meta-marks"
          title={meta.marks.join(" / ")}
          style={{
            marginLeft: 4,
            fontSize: 9,
            color: "var(--text-3)",
            fontFamily: "var(--font-mono)",
          }}
        >
          ·{meta.marks.length}
        </span>
      )}
      {node.truncated && (
        <span className="badge warn" title="此目录已达到显示上限，仍可用全局搜索定位其中的文件">
          截断
        </span>
      )}
    </div>
  );
});

function TreeContextMenu({
  x,
  y,
  node,
  onClose,
  onChangeIcon,
  onShowProperties,
}: {
  x: number;
  y: number;
  node: FileEntry;
  onClose: () => void;
  onChangeIcon: (path: string, x: number, y: number) => void;
  onShowProperties: (node: FileEntry) => void;
}) {
  const ws = useWorkspace((s) => s.activeWorkspace());
  const loadDir = useWorkspace((s) => s.loadDir);
  const setToast = useUI((s) => s.setToast);
  const openHistory = useUI((s) => s.openHistory);
  const openFile = useTabs((s) => s.openFile);
  const openPath = useTabs((s) => s.openPath);
  const closeTabsForPath = useTabs((s) => s.closeTabsForPath);
  const relocateTabs = useTabs((s) => s.relocateTabs);
  const dirtyTabsUnder = useTabs((s) => s.dirtyTabsUnder);
  const promptDialog = useDialog((s) => s.prompt);
  const confirmDialog = useDialog((s) => s.confirm);
  const fileMeta = useFileMeta((s) => s.byPath[node.path]) ?? {};
  const toggleBookmark = useFileMeta((s) => s.toggleBookmark);
  const setColor = useFileMeta((s) => s.setColor);
  const addMark = useFileMeta((s) => s.addMark);
  const moveFileMeta = useFileMeta((s) => s.movePath);

  const flash = (msg: string) => {
    setToast({ stage: "done", message: msg });
    setTimeout(() => setToast(null), 1800);
  };
  const errToast = (msg: string) => {
    setToast({ stage: "error", message: msg });
    setTimeout(() => setToast(null), 2500);
  };

  // 把"显示但不可用"的菜单项也放在 menu 里，让 23 项分组结构稳定；
  // 没拼通的能力（标签 / 颜色 / 收藏 / 移动至 / 公开发布 / 导出 / 属性 / 复制剪切）
  // 暂时不进 menu，避免空跑误操作。等对应模块（P4 publish、P10 advanced 等）落地再补。
  const isFile = !node.isDir;
  const isDir = node.isDir;
  const dirOfNode = isDir ? node.path : parentPath(node.path);

  const items: CtxItem[] = [];

  // 组 1：打开
  if (isFile) {
    items.push({
      label: "在新标签页打开",
      icon: "external",
      kbd: "↵",
      onClick: () => {
        if (ws) openFile(ws.id, node.path);
      },
    });
  }
  if (isDir) {
    items.push({
      label: "在此目录搜索",
      icon: "search",
      onClick: () => {
        // 全局搜索面板没有 scope 选项，先开搜索；后续 P10 AdvancedSearch 再补 scope
        useUI.getState().openGlobalSearch(true);
      },
    });
  }

  // 组 2：收藏 + 元数据
  items.push({ sep: true });
  items.push({
    label: fileMeta.bookmark ? "取消收藏" : "加入收藏",
    icon: "pin",
    onClick: () => toggleBookmark(node.path),
  });
  items.push({
    label: "更改图标…",
    icon: "palette",
    onClick: () => onChangeIcon(node.path, x, y),
  });
  // 颜色子菜单：6 个调色板 + 清除
  items.push({
    label: fileMeta.color
      ? `颜色 · 当前 ${FILE_COLOR_PALETTE.find((c) => c.id === fileMeta.color)?.label ?? "自定义"}`
      : "标颜色…",
    icon: "palette",
    onClick: async () => {
      // 用 prompt 输入色号或预设名（保留极简，无嵌套 picker）
      const label = await promptDialog({
        title: "标颜色",
        message:
          "输入颜色名或 #hex：" +
          FILE_COLOR_PALETTE.filter((c) => c.id)
            .map((c) => c.label)
            .join(" / ") +
          " 或空清除",
        defaultValue: fileMeta.color ?? "",
        confirmLabel: "应用",
      });
      if (label === null) return;
      const v = label.trim();
      if (!v) {
        setColor(node.path, undefined);
        return;
      }
      const preset = FILE_COLOR_PALETTE.find((c) => c.label === v);
      setColor(node.path, preset?.id ?? v);
    },
  });
  items.push({
    label: "添加标记…",
    icon: "edit",
    onClick: async () => {
      const mark = await promptDialog({
        title: "添加标记",
        message: "用户自定义标记（区别于内容里的 #tag）",
        defaultValue: "",
        confirmLabel: "添加",
      });
      if (mark?.trim()) addMark(node.path, mark.trim());
    },
  });

  // 组 3：编辑
  items.push({ sep: true });
  items.push({
    label: "重命名…",
    icon: "edit",
    kbd: "F2",
    onClick: async () => {
      const next = await promptDialog({
        title: "重命名",
        message: "输入新的文件或文件夹名称。",
        defaultValue: node.name,
        confirmLabel: "重命名",
      });
      if (!next || next === node.name) return;
      const parent = parentPath(node.path);
      const to = `${parent}/${next}`;
      try {
        await api.rename(node.path, to);
        // 已打开的 tab / 用户元数据需要同步指向新路径，否则保存会落到旧路径上
        relocateTabs(node.path, to);
        moveFileMeta(node.path, to);
        useRecents.getState().relocate(node.path, to);
        flash("已重命名");
        if (ws) {
          void ragUpdateAfterPathRemoval(ws.path, node.path, node.isDir);
          await loadDir(ws.id, parent);
        }
      } catch (e) {
        errToast(`重命名失败：${(e as Error).message}`);
      }
    },
  });
  items.push({
    label: "复制路径",
    icon: "copy",
    kbd: "⌘⌥C",
    onClick: async () => {
      try {
        await writeText(node.path);
        flash("已复制路径");
      } catch {
        /* ignore */
      }
    },
  });
  if (isFile) {
    items.push({
      label: "复制 Markdown 链接",
      icon: "link",
      kbd: "⌘⇧M",
      onClick: async () => {
        const base = node.name.replace(/\.(md|markdown|mdown|mkd|txt)$/i, "");
        const rel = ws ? node.path.replace(ws.path, "").replace(/^[\\/]/, "") : node.path;
        const md = `[${base}](${rel})`;
        try {
          await writeText(md);
          flash("已复制 Markdown 链接");
        } catch {
          /* ignore */
        }
      },
    });
  }

  // 移动至…：选目标目录后通过 rename(srcPath, targetDir/name) 完成移动；
  // 同步迁移 fileMeta（书签 / 颜色 / 标记）到新路径，避免元数据丢失。
  items.push({
    label: "移动至…",
    icon: "folder-open",
    onClick: async () => {
      if (!ws) return;
      const target = await pickDirectory();
      if (!target) return;
      const norm = target.replace(/[\\/]+$/, "");
      // 不允许把节点移到自己内部
      if (node.isDir && (norm === node.path || norm.startsWith(node.path + "/") || norm.startsWith(node.path + "\\"))) {
        errToast("目标目录在此节点内");
        return;
      }
      // 不允许目标 = 当前所在目录（原地不动）
      const curParent = parentPath(node.path);
      if (norm === curParent.replace(/[\\/]+$/, "")) {
        errToast("已在该目录下");
        return;
      }
      const dest = `${norm}/${node.name}`;
      try {
        await api.rename(node.path, dest);
        relocateTabs(node.path, dest);
        moveFileMeta(node.path, dest);
        useRecents.getState().relocate(node.path, dest);
        flash("已移动");
        await loadDir(ws.id, curParent);
        await loadDir(ws.id, norm);
      } catch (e) {
        errToast(`移动失败：${(e as Error).message}`);
      }
    },
  });

  // 组 4：创建（只在目录上）
  if (isDir) {
    items.push({ sep: true });
    items.push({
      label: "在此新建笔记…",
      icon: "file",
      kbd: "⌘N",
      onClick: async () => {
        const name = await promptDialog({
          title: "新建笔记",
          message: "输入文件名；未包含 .md 时自动追加。",
          defaultValue: "未命名",
          confirmLabel: "创建",
        });
        if (!name || !ws) return;
        const fname = name.endsWith(".md") ? name : `${name}.md`;
        const target = `${dirOfNode}/${fname}`;
        try {
          await api.createNew(target, `# ${fname.replace(/\.md$/i, "")}\n\n`);
          await loadDir(ws.id, dirOfNode);
          await openFile(ws.id, target);
          flash("已新建");
        } catch (e) {
          const pe = parseError(e);
          if (pe.code === "ALREADY_EXISTS") {
            errToast("同名文件已存在");
          } else {
            errToast(`创建失败：${pe.message}`);
          }
        }
      },
    });
    items.push({
      label: "新建子文件夹…",
      icon: "folder",
      onClick: async () => {
        const name = await promptDialog({
          title: "新建文件夹",
          message: "输入文件夹名称。",
          defaultValue: "新文件夹",
          confirmLabel: "创建",
        });
        if (!name || !ws) return;
        const target = `${dirOfNode}/${name}`;
        try {
          await api.mkdir(target);
          await loadDir(ws.id, dirOfNode);
          flash("已新建");
        } catch (e) {
          errToast(`创建失败：${(e as Error).message}`);
        }
      },
    });
  }

  // 组 5：工具
  items.push({ sep: true });
  items.push({
    label: "在 Finder 中显示",
    icon: "folder-open",
    onClick: async () => {
      try {
        await api.reveal(node.path);
      } catch (e) {
        errToast(`打开失败：${(e as Error).message}`);
      }
    },
  });
  if (isFile) {
    items.push({
      label: "历史版本",
      icon: "clock",
      kbd: "⌘Y",
      onClick: async () => {
        if (ws) {
          try {
            await openPath(node.path);
          } catch {
            /* 文件可能已不存在 */
          }
        }
        openHistory(true);
      },
    });
  }

  // 组 6：属性
  items.push({ sep: true });
  items.push({
    label: "属性…",
    icon: "info",
    kbd: "⌘I",
    onClick: () => onShowProperties(node),
  });

  // 组 7：危险
  items.push({ sep: true });
  items.push({
    label: node.isDir ? "移到回收站…" : "移到回收站",
    icon: "trash",
    kbd: "⌫",
    danger: true,
    onClick: async () => {
      if (!ws) return;
      if (!(await confirmDirtyLoss(node, dirtyTabsUnder, confirmDialog, "trash"))) {
        return;
      }
      try {
        await api.trashMove(ws.path, node.path);
        closeTabsForPath(node.path);
        useRecents.getState().forgetUnder(node.path);
        void ragUpdateAfterPathRemoval(ws.path, node.path, node.isDir);
        flash(node.isDir ? "文件夹已移到回收站" : "已移到回收站");
        await loadDir(ws.id, parentPath(node.path));
      } catch (e) {
        errToast(`移到回收站失败：${(e as Error).message}`);
      }
    },
  });
  items.push({
    label: "永久删除…",
    icon: "trash",
    kbd: "⇧⌫",
    danger: true,
    onClick: async () => {
      const dirty = dirtyTabsUnder(node.path);
      const baseMsg = `永久删除 ${node.name}？无法从回收站恢复。`;
      const message =
        dirty.length > 0
          ? `${baseMsg}\n\n${dirtyHint(dirty)}`
          : baseMsg;
      const ok = await confirmDialog({
        title: "永久删除",
        message,
        confirmLabel: dirty.length > 0 ? "删除并丢弃未保存修改" : "永久删除",
        danger: true,
      });
      if (!ok) return;
      try {
        await api.remove(node.path);
        closeTabsForPath(node.path);
        useRecents.getState().forgetUnder(node.path);
        if (ws) {
          void ragUpdateAfterPathRemoval(ws.path, node.path, node.isDir);
          await loadDir(ws.id, parentPath(node.path));
        }
        flash("已永久删除");
      } catch (e) {
        errToast(`删除失败：${(e as Error).message}`);
      }
    },
  });

  return <ContextMenu x={x} y={y} items={items} onClose={onClose} />;
}

/** 删除 / 移到回收站前若命中未保存的 tab，弹 confirm；用户取消即返回 false。 */
async function confirmDirtyLoss(
  node: FileEntry,
  dirtyTabsUnder: (path: string) => TabInfo[],
  confirmDialog: (opts: {
    title: string;
    message?: string;
    confirmLabel?: string;
    danger?: boolean;
  }) => Promise<boolean>,
  mode: "trash" | "delete",
): Promise<boolean> {
  const dirty = dirtyTabsUnder(node.path);
  if (dirty.length === 0) return true;
  const action = mode === "trash" ? "移到回收站" : "永久删除";
  return confirmDialog({
    title: `${action}前确认`,
    message: `${node.name} ${dirtyHint(dirty)}\n继续将丢失未保存的修改。`,
    confirmLabel: `${action}并丢弃修改`,
    danger: true,
  });
}

function dirtyHint(dirty: TabInfo[]): string {
  if (dirty.length === 1) {
    return `有 1 个未保存的 tab（${dirty[0]!.title}）。`;
  }
  return `下有 ${dirty.length} 个未保存的 tab。`;
}

/** 顺手更新 RAG 索引；目录变更用全量重建来清理前缀下的旧记录。 */
async function ragUpdateAfterPathRemoval(workspace: string, path: string, isDir: boolean) {
  try {
    if (isDir) {
      await useRag.getState().reindex(workspace);
    } else {
      await useRag.getState().removeFile(workspace, path);
    }
  } catch {
    /* ignore */
  }
}
