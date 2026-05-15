import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { useSettings } from "@/stores/settings";
import { useSync } from "@/stores/sync";
import { useTabs } from "@/stores/tabs";
import { useWorkspace } from "@/stores/workspace";
import { formatBytes } from "@/lib/utils";
import { api, isDesktop } from "@/lib/api";
import { runSyncNow } from "@/lib/syncScheduler";
import { PomodoroChip } from "../popovers/PomodoroChip";
import { WritingGoalChip } from "../popovers/WritingGoalChip";

function relativeTime(ts: number | null): string {
  if (!ts) return "尚未同步";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚同步";
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `${mins} 分钟前同步`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} 小时前同步`;
  const days = Math.round(hours / 24);
  return `${days} 天前同步`;
}

const textEncoder = new TextEncoder();

function countLines(content: string): number {
  if (!content) return 0;
  let lines = 1;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) lines++;
  }
  return lines;
}

export function StatusBar({
  words,
  readingMinutes,
}: {
  words?: number;
  readingMinutes?: number;
}) {
  const tab = useTabs((s) => s.activeTab());
  const ws = useWorkspace((s) => s.activeWorkspace());
  const theme = useSettings((s) => s.theme);
  const autosave = useSettings((s) => s.autosave);
  const autoSyncEnabled = useSettings((s) => s.autoSyncEnabled);
  const syncStatus = useSync((s) => s.status);
  const lastSyncAt = useSync((s) => s.lastSyncAt);
  const lastSyncError = useSync((s) => s.lastError);
  const [, force] = useState(0);
  useEffect(() => {
    const handle = window.setInterval(() => force((n) => n + 1), 30_000);
    return () => window.clearInterval(handle);
  }, []);
  const [git, setGit] = useState<{
    branch?: string;
    ahead: number;
    behind: number;
    files: number;
  } | null>(null);

  // 每 30s 轮询一次 git status（仅当存在 .git 目录时才显示）
  useEffect(() => {
    if (!isDesktop() || !ws) {
      setGit(null);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await api.gitStatus(ws.path);
        if (cancelled) return;
        setGit({
          branch: s.branch,
          ahead: s.ahead,
          behind: s.behind,
          files: s.files.length,
        });
      } catch {
        if (!cancelled) setGit(null);
      }
    };
    void tick();
    const handle = window.setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [ws?.path]);

  const content = tab?.content ?? "";
  const deferredContent = useDeferredValue(content);
  const charCount = content.length;
  const lineCount = useMemo(
    () => countLines(deferredContent),
    [deferredContent],
  );
  const byteCount = useMemo(
    () => textEncoder.encode(deferredContent).length,
    [deferredContent],
  );
  const saveLabel = tab
    ? tab.dirty
      ? autosave
        ? "正在保存…"
        : "未保存"
      : "已保存"
    : null;
  const saveColor = tab
    ? tab.dirty
      ? autosave
        ? "#ff9500"
        : "#ff453a"
      : "var(--text-3)"
    : "var(--text-3)";

  return (
    <div className="statusbar">
      <span className="item">
        <span className="pulse" />
        <span>{ws ? ws.name : "未连接仓库"}</span>
      </span>
      {tab && (
        <>
          <span className="item" style={{ color: saveColor }}>
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: saveColor,
                display: "inline-block",
              }}
            />
            {saveLabel}
          </span>
          <span className="item">{lineCount} 行 · {charCount} 字符</span>
          <span className="item">{formatBytes(byteCount)}</span>
          {words !== undefined && (
            <span className="item">{words} 字</span>
          )}
          {readingMinutes !== undefined && (
            <span className="item">阅读约 {readingMinutes} 分钟</span>
          )}
        </>
      )}
      {git && git.branch && (
        <span
          className="item"
          title={`Git · ${git.files} 处变更 · 未推 ${git.ahead} · 未拉 ${git.behind}`}
          style={{ color: git.ahead + git.behind > 0 ? "var(--accent)" : "var(--text-3)" }}
        >
          {"⎇ "}{git.branch}
          {git.ahead > 0 ? ` ↑${git.ahead}` : ""}
          {git.behind > 0 ? ` ↓${git.behind}` : ""}
          {git.files > 0 ? ` ·${git.files}` : ""}
        </span>
      )}
      {git && git.branch && (
        <button
          type="button"
          className="item"
          title={
            lastSyncError
              ? `同步失败：${lastSyncError}`
              : autoSyncEnabled
              ? "自动同步开启 · 点击立刻同步"
              : "自动同步未启用 · 点击立刻同步"
          }
          onClick={() => void runSyncNow()}
          disabled={syncStatus === "syncing"}
          style={{
            background: "transparent",
            border: "none",
            color:
              syncStatus === "error"
                ? "#ff453a"
                : syncStatus === "syncing"
                ? "var(--accent)"
                : "var(--text-3)",
            cursor: syncStatus === "syncing" ? "wait" : "pointer",
            padding: 0,
            font: "inherit",
          }}
        >
          {syncStatus === "syncing"
            ? "↻ 正在同步…"
            : syncStatus === "error"
            ? "⚠ 同步失败"
            : autoSyncEnabled
            ? `↺ ${relativeTime(lastSyncAt)}`
            : "↺ 立刻同步"}
        </button>
      )}
      <span className="item right">
        <PomodoroChip />
      </span>
      <span className="item">
        <WritingGoalChip />
      </span>
      <span className="item">UTF-8</span>
      <span className="item">Markdown</span>
      <span className="item">主题 · {theme}</span>
    </div>
  );
}
