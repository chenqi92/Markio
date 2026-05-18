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
  sync.setStatus("syncing");
  try {
    const status = await api.gitStatus(workspace).catch(() => null);
    if (!status) {
      sync.setStatus("idle");
      return;
    }
    if (status.files.length > 0) {
      const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
      await api.gitCommit(
        workspace,
        `markio: auto sync ${ts}`,
        "markio",
        "markio@local",
      );
    }
    if (status.upstream) {
      await api.gitPull(workspace, { rebase: false }).catch((e) => {
        throw new Error(`git pull 失败：${errorMessage(e)}`);
      });
      await api.gitPush(workspace).catch((e) => {
        throw new Error(`git push 失败：${errorMessage(e)}`);
      });
    }
    sync.setLastSync(Date.now());
    sync.setStatus("idle");
  } catch (e) {
    const message = errorMessage(e);
    sync.setStatus("error", message);
    reportDiagnostic({
      source: "sync",
      severity: "error",
      message: "Git 同步失败",
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
