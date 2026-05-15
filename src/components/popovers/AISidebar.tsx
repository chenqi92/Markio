import { useEffect, useMemo, useState } from "react";
import { Icon, type IconName } from "../ui/Icon";
import { useWorkspace } from "@/stores/workspace";
import { useTabs } from "@/stores/tabs";
import { useVaultIndex } from "@/stores/vaultIndex";
import { useAISessions, type AIScope } from "@/stores/aiSessions";
import { useSettings } from "@/stores/settings";
import { useRag } from "@/stores/rag";
import { useUI } from "@/stores/ui";
import type { Workspace } from "@/types";

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
  const vaultFiles = useVaultIndex((s) => (ws ? s.index[ws.path]?.files : undefined));
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

  const fileCount = vaultFiles?.length ?? 0;
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

        {ws && <RagIndexCard ws={ws} />}

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

function formatIndexedAt(ts?: number | null): string {
  if (!ts) return "尚未构建";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  const d = new Date(ts);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function RagIndexCard({ ws }: { ws: Workspace }) {
  const ragEnabled = useSettings((s) => s.ragEnabled);
  const setPreference = useSettings((s) => s.setPreference);
  const status = useRag((s) => s.status[ws.id]);
  const refresh = useRag((s) => s.refresh);
  const reindex = useRag((s) => s.reindex);
  const openSettings = useUI((s) => s.openSettings);
  const setToast = useUI((s) => s.setToast);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (ragEnabled) void refresh(ws.id, ws.path);
  }, [ragEnabled, ws.id, ws.path, refresh]);

  if (!ragEnabled) {
    return (
      <div className="rag-cta rag-cta-hint">
        <div className="rag-cta-title">
          <Icon name="info" size={12} />
          <span>仅关键词检索</span>
        </div>
        <div className="rag-cta-sub">
          启用本地索引可使用向量检索，回答更精准。
        </div>
        <div className="rag-cta-actions">
          <button
            type="button"
            className="rag-cta-btn rag-cta-btn-primary"
            onClick={() => {
              setPreference("ragEnabled", true);
              void refresh(ws.id, ws.path);
            }}
          >
            启用本地索引
          </button>
          <button
            type="button"
            className="rag-cta-btn"
            onClick={() => openSettings(true)}
          >
            打开设置
          </button>
        </div>
      </div>
    );
  }

  const running = status?.progress?.running ?? false;
  const totalChunks = status?.totalChunks ?? 0;
  const totalDocs = status?.totalDocs ?? 0;
  const indexedAt = status?.indexedAt ?? null;
  const processed = status?.progress?.processed ?? 0;
  const total = status?.progress?.total ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : null;

  const runBuild = async () => {
    if (busy || running) return;
    setBusy(true);
    try {
      await reindex(ws.path);
      setToast({ stage: "done", message: "索引构建已开始" });
      setTimeout(() => setToast(null), 1500);
    } catch (e) {
      setToast({
        stage: "error",
        message: `构建失败：${(e as Error).message}`,
      });
      setTimeout(() => setToast(null), 2500);
    } finally {
      setBusy(false);
    }
  };

  if (running) {
    return (
      <div className="rag-cta rag-cta-progress">
        <div className="rag-cta-title">
          <Icon name="sync" size={12} />
          <span>正在构建本地索引…</span>
        </div>
        <div className="rag-cta-sub">
          {processed} / {total || "…"} {pct != null ? `· ${pct}%` : ""}
        </div>
        {pct != null && (
          <div className="rag-cta-bar">
            <div className="rag-cta-bar-fill" style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
    );
  }

  if (totalChunks === 0) {
    return (
      <div className="rag-cta rag-cta-warn">
        <div className="rag-cta-title">
          <Icon name="lightbulb" size={12} />
          <span>本地索引未构建</span>
        </div>
        <div className="rag-cta-sub">
          构建后才能用向量检索回答跨笔记问题。
        </div>
        <div className="rag-cta-actions">
          <button
            type="button"
            className="rag-cta-btn rag-cta-btn-primary"
            disabled={busy}
            onClick={runBuild}
          >
            {busy ? "正在启动…" : "构建本地索引"}
          </button>
          <button
            type="button"
            className="rag-cta-btn"
            onClick={() => openSettings(true)}
          >
            参数…
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rag-cta rag-cta-ready">
      <div className="rag-cta-title">
        <Icon name="check" size={12} />
        <span>本地索引已就绪</span>
      </div>
      <div className="rag-cta-sub">
        {totalDocs} 篇 · {totalChunks} 片段 · {formatIndexedAt(indexedAt)}
      </div>
      <div className="rag-cta-actions">
        <button
          type="button"
          className="rag-cta-btn"
          disabled={busy}
          onClick={runBuild}
        >
          {busy ? "重建中…" : "重建"}
        </button>
        <button
          type="button"
          className="rag-cta-btn"
          onClick={() => openSettings(true)}
        >
          参数…
        </button>
      </div>
    </div>
  );
}
