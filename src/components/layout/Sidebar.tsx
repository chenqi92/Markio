import { useState } from "react";
import { Icon } from "../ui/Icon";
import { FileTree } from "./FileTree";
import { useWorkspace } from "@/stores/workspace";
import { useUI } from "@/stores/ui";
import { pickDirectory } from "@/lib/api";
import { shortcutText } from "@/lib/shortcuts";

export function Sidebar() {
  const workspaces = useWorkspace((s) => s.workspaces);
  const activeId = useWorkspace((s) => s.activeId);
  const setActive = useWorkspace((s) => s.setActive);
  const addWorkspace = useWorkspace((s) => s.addWorkspace);
  const removeWorkspace = useWorkspace((s) => s.removeWorkspace);
  const active = useWorkspace((s) => s.activeWorkspace());
  const openCommand = useUI((s) => s.openCommand);

  const [open, setOpen] = useState(false);

  const handleAdd = async () => {
    const dir = await pickDirectory();
    if (dir) {
      setOpen(false);
      await addWorkspace(dir);
    }
  };

  return (
    <aside className="sidebar">
      <div className="repo-switcher">
        {active ? (
          <>
            <button
              className="repo-card"
              style={{ width: "100%", textAlign: "left" }}
              onClick={() => setOpen((v) => !v)}
              type="button"
            >
              <div
                className="repo-avatar"
                style={{
                  background: `linear-gradient(135deg, ${active.color}, var(--accent-2))`,
                }}
              >
                {active.initial}
              </div>
              <div className="repo-info">
                <div className="repo-name">{active.name}</div>
                <div className="repo-sub" title={active.path}>
                  <span
                    className="pulse"
                    style={{
                      width: 6,
                      height: 6,
                      background: "#28c840",
                      display: "inline-block",
                      borderRadius: 999,
                    }}
                  />
                  本地 · 已同步
                </div>
              </div>
              <div className="repo-chev">
                <Icon name="chevdown" size={14} />
              </div>
            </button>
            <div className="repo-sync" title="在 设置 → 同步 配置多端">
              <span className="repo-sync-l">同步至</span>
              <div className="repo-sync-dots">
                <span className="dot" style={{ background: "#5b8a6a" }} title="本地" />
                <span
                  className="dot"
                  style={{ background: "#0a84ff", opacity: 0.35 }}
                  title="iCloud · 未连接"
                />
                <span
                  className="dot"
                  style={{ background: "#1f1f23", opacity: 0.35 }}
                  title="GitHub · 未连接"
                />
                <span
                  className="dot"
                  style={{ background: "#a05a14", opacity: 0.35 }}
                  title="WebDAV · 未连接"
                />
              </div>
              <span className="repo-sync-stat" style={{ color: "#28c840" }}>
                <span className="pulse" />
                本地
              </span>
            </div>
          </>
        ) : (
          <button
            type="button"
            className="repo-card"
            style={{
              width: "100%",
              justifyContent: "center",
              color: "var(--accent)",
              fontWeight: 600,
            }}
            onClick={handleAdd}
          >
            <div
              className="repo-avatar"
              style={{
                background: "var(--bg-pane-2)",
                color: "var(--accent)",
                border: "0.5px dashed var(--border-strong)",
              }}
            >
              +
            </div>
            <div className="repo-info">
              <div className="repo-name">添加仓库</div>
              <div className="repo-sub">选择一个文件夹开始阅读</div>
            </div>
          </button>
        )}

        {open && (
          <div className="repo-dropdown" onMouseLeave={() => setOpen(false)}>
            {workspaces.length > 0 && (
              <div className="group">
                <div className="group-h">
                  <span>仓库</span>
                  <span style={{ color: "var(--text-4)", fontWeight: 500 }}>
                    {workspaces.length} 个
                  </span>
                </div>
                {workspaces.map((w) => (
                  <button
                    type="button"
                    key={w.id}
                    className={"item" + (w.id === activeId ? " active" : "")}
                    onClick={() => {
                      setActive(w.id);
                      setOpen(false);
                    }}
                  >
                    <div
                      className="av"
                      style={{
                        background: `linear-gradient(135deg, ${w.color}, var(--accent-2))`,
                      }}
                    >
                      {w.initial}
                    </div>
                    <div className="meta">
                      <div className="nm">{w.name}</div>
                      <div className="sb">{w.path}</div>
                    </div>
                    {w.id === activeId && (
                      <div className="check">
                        <Icon name="check" size={14} />
                      </div>
                    )}
                  </button>
                ))}
              </div>
            )}
            <div className="group">
              <button type="button" className="item" onClick={handleAdd}>
                <div
                  className="av"
                  style={{
                    background: "var(--bg-pane-2)",
                    color: "var(--accent)",
                    border: "0.5px dashed var(--border-strong)",
                  }}
                >
                  +
                </div>
                <div className="meta">
                  <div className="nm" style={{ color: "var(--accent)" }}>
                    添加文件夹…
                  </div>
                  <div className="sb">把任意文件夹当作 markdown 仓库打开</div>
                </div>
              </button>
              {active && (
                <button
                  type="button"
                  className="item"
                  onClick={() => {
                    removeWorkspace(active.id);
                    setOpen(false);
                  }}
                >
                  <div
                    className="av"
                    style={{
                      background: "var(--bg-pane-2)",
                      color: "var(--text-2)",
                      border: "0.5px solid var(--border)",
                    }}
                  >
                    <Icon name="trash" size={13} />
                  </div>
                  <div className="meta">
                    <div className="nm">从列表中移除当前仓库</div>
                    <div className="sb">不会删除磁盘上的文件</div>
                  </div>
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="sb-search">
        <div className="search-box">
          <span className="ico">
            <Icon name="search" size={13} />
          </span>
          <input
            placeholder="搜索笔记…"
            onFocus={() => openCommand(true)}
            readOnly
          />
          <span className="search-kbd">{shortcutText("⌘K")}</span>
        </div>
      </div>

      <FileTree />
    </aside>
  );
}
