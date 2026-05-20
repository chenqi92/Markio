import { api, isDesktop, type GitStatus } from "@/lib/api";
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

type SyncStoreApi = Pick<
  ReturnType<typeof useSync.getState>,
  "isInflight" | "setInflight" | "setStage" | "setStatus" | "setConflict" | "setLastSync"
>;

export interface SyncWorkflowDeps {
  gitStatus: (workspace: string) => Promise<GitStatus>;
  gitFetch: (workspace: string) => Promise<void>;
  gitCommit: (
    workspace: string,
    message: string,
    authorName: string,
    authorEmail: string,
  ) => Promise<string>;
  gitPull: (workspace: string) => Promise<unknown>;
  gitPush: (workspace: string) => Promise<void>;
  gitResolveConflict: (
    workspace: string,
    strategy: "ours" | "theirs",
    files: string[],
  ) => Promise<void>;
  sync: () => SyncStoreApi;
  settings: () => Pick<ReturnType<typeof useSettings.getState>, "syncConflictStrategy">;
  report: typeof reportDiagnostic;
  now: () => Date;
  online: () => boolean;
}

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

function isNotGitRepoError(message: string): boolean {
  return /not a git repository|不是 git 仓库|不是一个 git 仓库/i.test(message);
}

function autoSyncMessage(message: string, conflict: boolean, strategy: string): string {
  if (!conflict || strategy === "ask") return message;
  if (strategy === "newest") {
    return `${message}\n「最新版本」策略需要人工确认文件内容，自动同步已停在冲突状态。`;
  }
  return `${message}\n自动同步未能完成「${strategy}」策略，请在 Git 设置中手动确认后解决。`;
}

function gitResolutionForStrategy(
  strategy: ReturnType<typeof useSettings.getState>["syncConflictStrategy"],
): "ours" | "theirs" | null {
  if (strategy === "local") return "ours";
  if (strategy === "remote") return "theirs";
  return null;
}

function defaultDeps(): SyncWorkflowDeps {
  return {
    gitStatus: api.gitStatus,
    gitFetch: (workspace) => api.gitFetch(workspace),
    gitCommit: (workspace, message, authorName, authorEmail) =>
      api.gitCommit(workspace, message, authorName, authorEmail),
    gitPull: (workspace) => api.gitPull(workspace, { rebase: false }),
    gitPush: (workspace) => api.gitPush(workspace),
    gitResolveConflict: (workspace, strategy, files) =>
      api.gitResolveConflict(workspace, strategy, files),
    sync: () => useSync.getState(),
    settings: () => useSettings.getState(),
    report: reportDiagnostic,
    now: () => new Date(),
    online: () =>
      typeof navigator === "undefined" ? true : navigator.onLine,
  };
}

export async function runSyncWorkflow(
  workspace: string,
  deps: SyncWorkflowDeps = defaultDeps(),
): Promise<void> {
  const sync = deps.sync();
  if (sync.isInflight(workspace)) return;
  // 显然离线时跳过：触发 git push 只会徒增超时，让 statusbar 显示离线
  // 而不是后续的"同步失败"误导用户。online 转 true 时设置变化会重新拉一次定时器。
  if (!deps.online()) {
    sync.setStatus("idle");
    return;
  }
  sync.setInflight(workspace, true);
  sync.setStage("preflight", "检查 Git 状态");
  try {
    let status: GitStatus;
    try {
      status = await deps.gitStatus(workspace);
    } catch (e) {
      const message = errorMessage(e);
      if (isNotGitRepoError(message)) {
        sync.setStage("idle", "当前仓库未初始化 Git");
        return;
      }
      throw new Error(`git status 失败：${message}`, { cause: e });
    }
    if (!status.upstream && (status.files.length > 0 || status.ahead > 0)) {
      throw new Error("当前分支没有 upstream，请先在 Git 设置中执行 push -u。");
    }
    if (!status.upstream) {
      sync.setStage("idle", "当前分支没有 upstream，跳过同步");
      return;
    }
    if (status.files.length > 0) {
      sync.setStage("snapshot", `提交 ${status.files.length} 个本地变更`);
      const ts = deps.now().toISOString().replace("T", " ").slice(0, 19);
      await deps.gitCommit(
        workspace,
        `markio: auto sync ${ts}`,
        "markio",
        "markio@local",
      );
      status = await deps.gitStatus(workspace);
    }
    sync.setStage("fetch", "获取远端状态");
    await deps.gitFetch(workspace);
    status = await deps.gitStatus(workspace);
    if (status.behind > 0) {
      sync.setStage("pull", "拉取远端变更");
      try {
        await deps.gitPull(workspace);
      } catch (e) {
        const pullMessage = errorMessage(e);
        const conflictFiles = conflictFilesFromError(pullMessage);
        const resolution = conflictFiles
          ? gitResolutionForStrategy(deps.settings().syncConflictStrategy)
          : null;
        if (!conflictFiles || !resolution) {
          throw new Error(`git pull 失败：${pullMessage}`, { cause: e });
        }
        const label = resolution === "ours" ? "保留本地" : "采用远端";
        sync.setStage("conflict", `按策略自动处理冲突 · ${label}`);
        try {
          await deps.gitResolveConflict(workspace, resolution, conflictFiles);
          sync.setStage("snapshot", "提交冲突解决结果");
          const ts = deps.now().toISOString().replace("T", " ").slice(0, 19);
          await deps.gitCommit(
            workspace,
            `markio: resolve sync conflicts ${ts}`,
            "markio",
            "markio@local",
          );
        } catch (resolveError) {
          throw new Error(
            `git pull 冲突自动处理失败：${errorMessage(resolveError)}\nCONFLICT:${conflictFiles.join("\n")}`,
            { cause: resolveError },
          );
        }
      }
      status = await deps.gitStatus(workspace);
    }
    if (status.ahead > 0) {
      sync.setStage("push", "推送本地提交");
      await deps.gitPush(workspace).catch((e) => {
        throw new Error(`git push 失败：${errorMessage(e)}`);
      });
      status = await deps.gitStatus(workspace);
    }
    sync.setLastSync(deps.now().getTime());
    const summary =
      status.ahead === 0 && status.behind === 0
        ? "同步完成"
        : `同步完成 · 未推 ${status.ahead} · 未拉 ${status.behind}`;
    sync.setStage("done", summary);
  } catch (e) {
    const rawMessage = errorMessage(e);
    const conflictFiles = conflictFilesFromError(rawMessage);
    const message = autoSyncMessage(
      rawMessage,
      !!conflictFiles,
      deps.settings().syncConflictStrategy,
    );
    if (conflictFiles) {
      sync.setConflict(conflictFiles, message);
    } else {
      sync.setStatus("error", message);
    }
    deps.report({
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

async function runOnce(workspace: string): Promise<void> {
  await runSyncWorkflow(workspace);
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
