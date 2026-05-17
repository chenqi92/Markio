import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { useSettings } from "@/stores/settings";
import { useSync } from "@/stores/sync";
import { useTabs } from "@/stores/tabs";
import { useWorkspace } from "@/stores/workspace";
import { formatBytes } from "@/lib/utils";
import { api, isDesktop, type WatcherHealthDto } from "@/lib/api";
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
  const [watcher, setWatcher] = useState<WatcherHealthDto | null>(null);

  // 文件监听健康度：每 60s 拉一次。仅在异常（未运行 / 有 backend 错误）时显示，
  // 避免占用 StatusBar 视觉空间；正常运行用户感知不到。
  useEffect(() => {
    if (!isDesktop() || !ws) {
      setWatcher(null);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      if (cancelled || document.hidden) return;
      try {
        const all = await api.watcherHealth();
        if (cancelled) return;
        const wsNorm = ws.path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
        const mine = all.find(
          (h) =>
            h.workspace.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === wsNorm,
        );
        setWatcher(mine ?? null);
      } catch {
        if (!cancelled) setWatcher(null);
      }
    };
    void tick();
    const timer = window.setInterval(tick, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [ws?.path]);

  // git status 轮询：用 setTimeout 链而非 setInterval，避免大仓库 / 网络挂载盘
  // 导致请求堆积。失败时指数退避（30s → 60s → 120s → 封顶 5min），
  // 窗口隐藏时延后一次以省电。桌面长跑场景这两点都比"固定 30s 间隔"重要。
  useEffect(() => {
    if (!isDesktop() || !ws) {
      setGit(null);
      return;
    }
    let cancelled = false;
    let timer: number | null = null;
    let failureBackoff = 0;
    const BASE_INTERVAL = 30_000;
    const MAX_INTERVAL = 300_000;
    const tick = async () => {
      if (cancelled) return;
      if (document.hidden) {
        timer = window.setTimeout(tick, BASE_INTERVAL);
        return;
      }
      try {
        const s = await api.gitStatus(ws.path);
        if (cancelled) return;
        setGit({
          branch: s.branch,
          ahead: s.ahead,
          behind: s.behind,
          files: s.files.length,
        });
        failureBackoff = 0;
      } catch {
        if (cancelled) return;
        setGit(null);
        failureBackoff = Math.min(failureBackoff === 0 ? 1 : failureBackoff + 1, 4);
      }
      if (cancelled) return;
      const next = Math.min(BASE_INTERVAL * 2 ** failureBackoff, MAX_INTERVAL);
      timer = window.setTimeout(tick, next);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
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
      {watcher && (!watcher.running || watcher.backendErrors > 0) && (
        <span
          className="item"
          title={
            !watcher.running
              ? "文件监听已停止，仓库变动可能不会被自动索引。重新打开仓库可重启监听。"
              : `文件监听有 ${watcher.backendErrors} 次错误${
                  watcher.lastError ? `：${watcher.lastError}` : ""
                }。RAG 索引可能与磁盘脱节，建议在「设置 → 本地知识库」重建索引。`
          }
          style={{ color: !watcher.running ? "#ff453a" : "#ff9500" }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: !watcher.running ? "#ff453a" : "#ff9500",
              display: "inline-block",
              marginRight: 4,
            }}
          />
          {!watcher.running ? "监听已停止" : `监听 ${watcher.backendErrors} 错误`}
        </span>
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
