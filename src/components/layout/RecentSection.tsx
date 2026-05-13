import { useState } from "react";
import { Icon } from "../ui/Icon";
import { useRecents } from "@/stores/recents";
import { useWorkspace } from "@/stores/workspace";
import { useTabs } from "@/stores/tabs";
import { useFileIcons } from "@/stores/fileIcons";
import { isIconName } from "../ui/Icon";

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
  const [open, setOpen] = useState(true);

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
          onClick={(e) => {
            e.stopPropagation();
            const ok = window.confirm("清空当前仓库的最近列表？");
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
    </div>
  );
}
