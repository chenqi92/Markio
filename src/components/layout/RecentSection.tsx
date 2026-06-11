import { useState } from "react";
import { Icon } from "../ui/Icon";
import { useRecents } from "@/stores/recents";
import { useWorkspace } from "@/stores/workspace";
import { useTabs } from "@/stores/tabs";
import { useFileIcons } from "@/stores/fileIcons";
import { useDialog } from "@/stores/dialog";
import { useUI } from "@/stores/ui";
import { isIconName } from "../ui/Icon";
import { ContextMenu } from "../popovers/ContextMenu";
import { api } from "@/lib/api";
import { writeText } from "@/lib/clipboard";

/**
 * 侧边栏顶部"最近"分区。
 * - 数据源：`useRecents` store（每次 openFile 都会 push 进去）
 * - 仅显示当前 workspace 下的最近文件
 * - 折叠 / 展开状态独立，默认展开
 */
export function RecentSection() {
  const ws = useWorkspace((s) => s.activeWorkspace());
  const items = useRecents((s) => s.items);
  const forget = useRecents((s) => s.forget);
  const openFile = useTabs((s) => s.openFile);
  const activePath = useTabs((s) =>
    s.tabs.find((t) => t.id === s.activeId)?.path,
  );
  const customIcons = useFileIcons((s) => s.icons);
  const confirmDialog = useDialog((s) => s.confirm);
  const setToast = useUI((s) => s.setToast);
  const [open, setOpen] = useState(false);
  const [ctx, setCtx] = useState<
    | { x: number; y: number; path: string; wsId: string; name: string }
    | null
  >(null);
  const [headerCtx, setHeaderCtx] = useState<{ x: number; y: number } | null>(
    null,
  );
  const flash = (msg: string) => {
    setToast({ stage: "done", message: msg });
  };

  if (!ws) return null;
  const recents = items
    .filter((it) => it.workspaceId === ws.id)
    .slice(0, 6);
  if (recents.length === 0) return null;

  return (
    <div className="recent-section">
      <div
        className="tree-section"
        style={{ cursor: "pointer" }}
        onClick={() => setOpen((v) => !v)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setHeaderCtx({ x: e.clientX, y: e.clientY });
        }}
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
        <span style={{ flex: 1 }}>最近</span>
        <span className="count">{recents.length}</span>
        <button
          type="button"
          className="sec-act"
          title="清除最近"
          style={{ opacity: 1 }}
          onClick={async (e) => {
            e.stopPropagation();
            const ok = await confirmDialog({
              title: "清空最近列表？",
              message: "将清空当前仓库的最近文件记录，不会删除文件本身。",
              confirmLabel: "清空",
            });
            if (!ok) return;
            for (const it of recents) forget(it.path);
          }}
        >
          <Icon name="x" size={10} />
        </button>
      </div>
      {open &&
        recents.map((r) => {
          const custom = customIcons[r.path];
          const isActive = activePath === r.path;
          return (
            <div
              key={r.path}
              className={"tree-row" + (isActive ? " selected" : "")}
              onClick={() => openFile(r.workspaceId, r.path)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setCtx({
                  x: e.clientX,
                  y: e.clientY,
                  path: r.path,
                  wsId: r.workspaceId,
                  name: r.name,
                });
              }}
              style={{ paddingLeft: 16 }}
              title={r.path}
            >
              <span className="chev" style={{ visibility: "hidden" }}>
                <Icon name="chevron" size={11} />
              </span>
              <span className="ico">
                {custom && isIconName(custom) ? (
                  <Icon name={custom} size={13} />
                ) : (
                  <Icon name="clock" size={13} />
                )}
              </span>
              <span className="lbl">{r.name.replace(/\.md$/i, "")}</span>
            </div>
          );
        })}
      {ctx && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          onClose={() => setCtx(null)}
          items={[
            {
              label: "打开",
              icon: "external",
              onClick: () => openFile(ctx.wsId, ctx.path),
            },
            { sep: true },
            {
              label: "在 Finder 中显示",
              icon: "folder-open",
              onClick: () => {
                void api.reveal(ctx.path);
              },
            },
            {
              label: "复制路径",
              icon: "copy",
              onClick: async () => {
                try {
                  await writeText(ctx.path);
                  flash("已复制路径");
                } catch {
                  /* ignore */
                }
              },
            },
            { sep: true },
            {
              label: "从最近列表移除",
              icon: "x",
              onClick: () => forget(ctx.path),
            },
          ]}
        />
      )}
      {headerCtx && (
        <ContextMenu
          x={headerCtx.x}
          y={headerCtx.y}
          onClose={() => setHeaderCtx(null)}
          items={[
            {
              label: open ? "折叠" : "展开",
              icon: "chevron",
              onClick: () => setOpen((v) => !v),
            },
            { sep: true },
            {
              label: "清空最近列表…",
              icon: "trash",
              danger: true,
              onClick: async () => {
                const ok = await confirmDialog({
                  title: "清空最近列表？",
                  message:
                    "将清空当前仓库的最近文件记录，不会删除文件本身。",
                  confirmLabel: "清空",
                });
                if (!ok) return;
                for (const it of recents) forget(it.path);
              },
            },
          ]}
        />
      )}
    </div>
  );
}
