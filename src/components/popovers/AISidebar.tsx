import { useEffect, useMemo } from "react";
import { Icon, type IconName } from "../ui/Icon";
import { useWorkspace } from "@/stores/workspace";
import { useTabs } from "@/stores/tabs";
import { useAISessions, type AIScope } from "@/stores/aiSessions";

interface ScopeMode {
  id: AIScope;
  icon: IconName;
  label: string;
  hint: (ctx: { fileCount: number; folder: string | null; openCount: number }) => string;
}

const SCOPE_MODES: ScopeMode[] = [
  {
    id: "all",
    icon: "database",
    label: "整个仓库",
    hint: ({ fileCount }) => `${fileCount} 篇`,
  },
  {
    id: "folder",
    icon: "folder",
    label: "当前文件夹",
    hint: ({ folder }) => (folder ? folder : "未选中文件"),
  },
  {
    id: "open",
    icon: "note",
    label: "当前打开的笔记",
    hint: ({ openCount }) => `${openCount} 个标签页`,
  },
  {
    id: "tag",
    icon: "tag",
    label: "按标签",
    hint: () => "选择标签…",
  },
  {
    id: "custom",
    icon: "sparkle",
    label: "手动选择",
    hint: ({}) => "0 篇",
  },
];

function countMd(node: ReturnType<typeof useWorkspace.getState>["treeCache"][string]): number {
  if (!node) return 0;
  if (!node.isDir) return 1;
  return (node.children ?? []).reduce((acc, c) => acc + countMd(c), 0);
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `今天 ${new Date(ts).toTimeString().slice(0, 5)}`;
  const d = Math.floor(diff / 86_400_000);
  if (d < 7) return `${d} 天前`;
  const date = new Date(ts);
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function AISidebar({ aiMode }: { aiMode: string }) {
  const ws = useWorkspace((s) => s.activeWorkspace());
  const tree = useWorkspace((s) => s.activeTree());
  const tabs = useTabs((s) => s.tabs);
  const activeTab = useTabs((s) => s.activeTab());

  const sessions = useAISessions((s) => s.sessions);
  const activeId = useAISessions((s) => s.activeId);
  const scope = useAISessions((s) => s.scope);
  const setScope = useAISessions((s) => s.setScope);
  const createSession = useAISessions((s) => s.createSession);
  const setActive = useAISessions((s) => s.setActive);
  const deleteSession = useAISessions((s) => s.deleteSession);

  // 只显示当前仓库下的会话（null workspaceId 视为"全局"也显示）
  const visible = useMemo(() => {
    const wsId = ws?.id ?? null;
    return sessions
      .filter((s) => s.workspaceId === wsId || s.workspaceId === null)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [sessions, ws?.id]);

  // 首次进入：如果没有 active session，自动建一个
  useEffect(() => {
    if (!activeId) {
      createSession(ws?.id ?? null, aiMode);
    }
  }, [activeId, ws?.id, aiMode, createSession]);

  const fileCount = countMd(tree);
  const folder = activeTab
    ? activeTab.path.replace(/[\\/][^\\/]+$/, "").split(/[\\/]/).pop() ?? null
    : null;

  return (
    <aside className="ai-sidebar">
      <div className="ai-sb-section" style={{ paddingTop: 14 }}>
        <div className="ai-sb-section-h">索引范围</div>
        {ws ? (
          <div className="ai-scope-repo">
            <div
              className="ai-scope-av"
              style={{
                background: `linear-gradient(135deg, ${ws.color}, var(--accent-2))`,
              }}
            >
              {ws.initial}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="ai-scope-name">{ws.name}</div>
              <div className="ai-scope-meta">{fileCount} 篇 · 本地索引</div>
            </div>
            <button
              type="button"
              className="ai-scope-switch"
              title="使用整个仓库索引"
              onClick={() => setScope("all")}
            >
              <Icon name="sync" size={12} />
            </button>
          </div>
        ) : (
          <div
            style={{
              padding: "8px 12px",
              fontSize: 11,
              color: "var(--text-3)",
              background: "var(--bg-pane-2)",
              border: "0.5px solid var(--border)",
              borderRadius: 8,
              margin: "0 8px 8px",
            }}
          >
            未打开仓库
          </div>
        )}

        <div className="ai-scope-modes">
          {SCOPE_MODES.map((m) => (
            <button
              type="button"
              key={m.id}
              className={"ai-scope-mode" + (m.id === scope ? " active" : "")}
              onClick={() => setScope(m.id)}
            >
              <span className="ic">
                <Icon name={m.icon} size={13} />
              </span>
              <span className="l">{m.label}</span>
              <span className="s">
                {m.hint({
                  fileCount,
                  folder,
                  openCount: tabs.length,
                })}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="ai-sb-section ai-sb-sessions">
        <div className="ai-sb-section-h">
          <span style={{ flex: 1 }}>历史对话</span>
          <button
            type="button"
            className="ai-new-chat"
            title="开始新对话"
            onClick={() => createSession(ws?.id ?? null, aiMode)}
          >
            <Icon name="plus" size={11} />
          </button>
        </div>
        <div className="ai-sessions-list scroll">
          {visible.length === 0 ? (
            <div
              style={{
                padding: "12px 14px",
                fontSize: 11,
                color: "var(--text-3)",
                textAlign: "center",
              }}
            >
              暂无历史对话
            </div>
          ) : (
            visible.map((s) => (
              <div
                key={s.id}
                className={"ai-session" + (s.id === activeId ? " active" : "")}
                onClick={() => setActive(s.id)}
              >
                <div className="ai-session-t">{s.title}</div>
                <div className="ai-session-m">
                  {formatRelative(s.updatedAt)} · {s.messages.length} 条
                </div>
                <button
                  type="button"
                  className="ai-session-x"
                  title="删除会话"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (window.confirm(`删除「${s.title}」？`)) deleteSession(s.id);
                  }}
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </aside>
  );
}
