import { api, isDesktop } from "@/lib/api";
import { useSettings } from "@/stores/settings";
import { useSync } from "@/stores/sync";
import { reportDiagnostic } from "@/stores/diagnostics";

const FREQ_MS: Record<string, number> = {
  "30s": 30_000,
  "1m": 60_000,
  "5m": 300_000,
};

let timer: number | null = null;
let activeWorkspace: string | null = null;
let unsubscribeSettings: (() => void) | null = null;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function conflictFilesFromError(message: string): string[] | null {
  const idx = message.indexOf("CONFLICT:");
  if (idx < 0) return null;
  const rest = message.slice(idx + "CONFLICT:".length);
  const files = rest
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  return files.length > 0 ? files : [];
}

async function runOnce(workspace: string): Promise<void> {
  const sync = useSync.getState();
  if (sync.isInflight(workspace)) return;
  // 显然离线时跳过：触发 git push 只会徒增超时，让 statusbar 显示离线
  // 而不是后续的"同步失败"误导用户。online 转 true 时设置变化会重新拉一次定时器。
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    sync.setStatus("idle");
    return;
  }
  sync.setInflight(workspace, true);
  sync.setStage("preflight", "检查 Git 状态");
  try {
    let status = await api.gitStatus(workspace).catch(() => null);
    if (!status) {
      sync.setStage("idle", "当前仓库未初始化 Git");
      return;
    }
    if (status.files.length > 0) {
      sync.setStage("snapshot", `提交 ${status.files.length} 个本地变更`);
      const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
      await api.gitCommit(
        workspace,
        `markio: auto sync ${ts}`,
        "markio",
        "markio@local",
      );
      status = await api.gitStatus(workspace);
    }
    if (status.upstream) {
      sync.setStage("pull", "拉取远端变更");
      await api.gitPull(workspace, { rebase: false }).catch((e) => {
        throw new Error(`git pull 失败：${errorMessage(e)}`);
      });
      sync.setStage("push", "推送本地提交");
      await api.gitPush(workspace).catch((e) => {
        throw new Error(`git push 失败：${errorMessage(e)}`);
      });
    } else if (status.ahead > 0 || status.files.length > 0) {
      throw new Error("当前分支没有 upstream，请先在 Git 设置中执行 push -u。");
    }
    sync.setLastSync(Date.now());
    sync.setStage("done", "同步完成");
  } catch (e) {
    const message = errorMessage(e);
    const conflictFiles = conflictFilesFromError(message);
    if (conflictFiles) {
      sync.setConflict(conflictFiles, message);
    } else {
      sync.setStatus("error", message);
    }
    reportDiagnostic({
      source: "sync",
      severity: "error",
      message: conflictFiles ? "Git 同步冲突" : "Git 同步失败",
      detail: message,
      workspace,
    });
  } finally {
    sync.setInflight(workspace, false);
  }
}

function clearTimer() {
  if (timer != null) {
    window.clearInterval(timer);
    timer = null;
  }
}

function applyTimer() {
  clearTimer();
  if (!activeWorkspace) return;
  const { autoSyncEnabled, syncFrequency } = useSettings.getState();
  if (!autoSyncEnabled) return;
  const interval = FREQ_MS[syncFrequency];
  if (!interval) return;
  timer = window.setInterval(() => {
    if (activeWorkspace) void runOnce(activeWorkspace);
  }, interval);
}

/** 应用启动后调用一次：根据当前 workspace + 设置启动 / 停止调度器。 */
export function startSyncScheduler(workspace: string | null): void {
  if (!isDesktop()) return;
  activeWorkspace = workspace;
  applyTimer();
  unsubscribeSettings?.();
  unsubscribeSettings = useSettings.subscribe((state, prev) => {
    if (
      state.autoSyncEnabled !== prev.autoSyncEnabled ||
      state.syncFrequency !== prev.syncFrequency
    ) {
      applyTimer();
    }
  });
}

export function stopSyncScheduler(): void {
  clearTimer();
  unsubscribeSettings?.();
  unsubscribeSettings = null;
  activeWorkspace = null;
}

/** 用户从 StatusBar / Settings 手动触发一次。 */
export async function runSyncNow(): Promise<void> {
  if (!activeWorkspace) return;
  await runOnce(activeWorkspace);
}
