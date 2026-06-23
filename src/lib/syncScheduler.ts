import { api, isDesktop, type GitStatus } from "@/lib/api";
import { useSettings } from "@/stores/settings";
import { useSync } from "@/stores/sync";
import { reportDiagnostic } from "@/stores/diagnostics";
import { createCloudSyncTargets, type CloudSyncSettings, type CloudSyncTarget } from "@/lib/sync/adapters";
import { createLocalFs, createManifestIO } from "@/lib/sync/local";
import { runSync } from "@/lib/sync/engine";
import { resolvePeerToken, runP2PSync } from "@/lib/sync/p2pAdapter";
import type { SyncReport, SyncStage as CloudSyncStage } from "@/lib/sync/types";

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
    strategy: "ours" | "theirs" | "newest",
    files: string[],
  ) => Promise<void>;
  sync: () => SyncStoreApi;
  settings: () => CloudSyncSettings;
  createCloudTargets?: (settings: CloudSyncSettings) => CloudSyncTarget[];
  runCloudTarget?: (
    workspace: string,
    target: CloudSyncTarget,
    settings: CloudSyncSettings,
    callbacks: {
      onStage: (stage: CloudSyncStage, detail?: string) => void;
      onProgress: (done: number, total: number, current?: string) => void;
    },
  ) => Promise<SyncReport>;
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
  return `${message}\n自动同步未能完成「${strategy}」策略，请在 Git 设置中手动确认后解决。`;
}

function gitResolutionForStrategy(
  strategy: ReturnType<typeof useSettings.getState>["syncConflictStrategy"],
): "ours" | "theirs" | "newest" | null {
  if (strategy === "local") return "ours";
  if (strategy === "remote") return "theirs";
  if (strategy === "newest") return "newest";
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
    createCloudTargets: createCloudSyncTargets,
    runCloudTarget: runCloudSyncTarget,
    report: reportDiagnostic,
    now: () => new Date(),
    online: () =>
      typeof navigator === "undefined" ? true : navigator.onLine,
  };
}

export function cloudStageLabel(stage: CloudSyncStage): string {
  switch (stage) {
    case "scan_local":
      return "扫描本地";
    case "scan_remote":
      return "获取远端";
    case "diff":
      return "计算差异";
    case "execute":
      return "执行同步";
    case "finalize":
      return "写入同步状态";
    case "cancelled":
      return "已取消";
    case "error":
      return "同步失败";
    case "idle":
    default:
      return "准备同步";
  }
}

export function cloudStoreStage(stage: CloudSyncStage): Parameters<SyncStoreApi["setStage"]>[0] {
  switch (stage) {
    case "scan_remote":
      return "fetch";
    case "execute":
      return "push";
    case "finalize":
      return "done";
    case "error":
      return "error";
    case "cancelled":
    case "idle":
      return "idle";
    case "scan_local":
    case "diff":
    default:
      return "preflight";
  }
}

function summarizeCloudReports(reports: Array<{ target: CloudSyncTarget; report: SyncReport }>): string {
  const parts = reports.map(({ target, report }) => {
    const s = report.plan.summary;
    const changed = s.upload + s.download + s.deleteLocal + s.deleteRemote;
    if (changed === 0) return `${target.label} 无变更`;
    const details = [
      s.upload ? `上传 ${s.upload}` : "",
      s.download ? `下载 ${s.download}` : "",
      s.deleteRemote ? `删远端 ${s.deleteRemote}` : "",
      s.deleteLocal ? `删本地 ${s.deleteLocal}` : "",
    ].filter(Boolean);
    return `${target.label} ${details.join(" · ")}`;
  });
  return `同步完成 · ${parts.join("；")}`;
}

async function runCloudSyncTarget(
  workspace: string,
  target: CloudSyncTarget,
  settings: CloudSyncSettings,
  callbacks: {
    onStage: (stage: CloudSyncStage, detail?: string) => void;
    onProgress: (done: number, total: number, current?: string) => void;
  },
): Promise<SyncReport> {
  return runSync(
    workspace,
    target.remoteRoot,
    {
      conflictStrategy: settings.syncConflictStrategy,
      now: Date.now,
    },
    {
      adapter: target.adapter,
      manifestIo: createManifestIO(target.manifestId),
      localFs: createLocalFs(),
      onStage: callbacks.onStage,
      onProgress: callbacks.onProgress,
    },
  );
}

async function runCloudSyncWorkflow(
  workspace: string,
  targets: CloudSyncTarget[],
  settings: CloudSyncSettings,
  deps: SyncWorkflowDeps,
  sync: SyncStoreApi,
): Promise<void> {
  const runner = deps.runCloudTarget ?? runCloudSyncTarget;
  const reports: Array<{ target: CloudSyncTarget; report: SyncReport }> = [];

  for (const target of targets) {
    sync.setStage("preflight", `${target.label} · 准备同步`);
    const report = await runner(workspace, target, settings, {
      onStage(stage, detail) {
        if (stage === "idle") return;
        const label = detail || cloudStageLabel(stage);
        sync.setStage(cloudStoreStage(stage), `${target.label} · ${label}`);
      },
      onProgress(done, total, current) {
        if (total <= 0) return;
        sync.setStage("push", `${target.label} · ${done}/${total}${current ? ` · ${current}` : ""}`);
      },
    });
    reports.push({ target, report });

    if (report.fatalError) {
      throw new Error(`${target.label} 同步失败：${report.fatalError}`);
    }

    const failed = report.results.filter((r) => !r.ok);
    if (failed.length > 0) {
      const failedPaths = new Set(failed.map((r) => r.relPath));
      const conflicts = report.plan.actions
        .filter((action) => action.kind === "conflict" && failedPaths.has(action.relPath))
        .map((action) => action.relPath);
      if (conflicts.length > 0) {
        const message = `${target.label} 同步冲突：${conflicts.length} 个文件需要处理`;
        sync.setConflict(conflicts, message);
        deps.report({
          source: "sync",
          severity: "error",
          message: "云同步冲突",
          detail: message,
          workspace,
        });
        return;
      }
      throw new Error(
        `${target.label} 同步有 ${failed.length} 个动作失败：${failed
          .slice(0, 3)
          .map((r) => `${r.relPath}: ${r.error}`)
          .join("；")}`,
      );
    }
  }

  sync.setLastSync(deps.now().getTime());
  sync.setStage("done", summarizeCloudReports(reports));
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
  let activeMode: "git" | "cloud" = "git";
  try {
    const settings = deps.settings();
    const cloudTargets = deps.createCloudTargets?.(settings) ?? [];
    if (cloudTargets.length > 0) {
      activeMode = "cloud";
      await runCloudSyncWorkflow(workspace, cloudTargets, settings, deps, sync);
      return;
    }

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
        const label =
          resolution === "ours"
            ? "保留本地"
            : resolution === "theirs"
              ? "采用远端"
              : "采用较新版本";
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
      message: conflictFiles
        ? activeMode === "cloud"
          ? "云同步冲突"
          : "Git 同步冲突"
        : activeMode === "cloud"
          ? "云同步失败"
          : "Git 同步失败",
      detail: message,
      workspace,
    });
  } finally {
    sync.setInflight(workspace, false);
  }
}

async function runOnce(workspace: string): Promise<void> {
  await runSyncWorkflow(workspace);
  // 主同步（git/cloud）完成后，再 best-effort 跑一遍 P2P 自动同步
  await runP2PAutoSync(workspace);
}

/**
 * P2P 自动同步：对「当前 mDNS 在线」的已配对对端逐个 best-effort 同步。
 * - 只在 mobileP2pEnabled && mobileP2pAutoSync 时触发
 * - 仅同步在线对端（离线的不尝试，避免每次 10s WS 超时拖慢）
 * - 单个对端失败不影响其它；全程复用全局 sync 状态栏
 */
async function runP2PAutoSync(workspace: string): Promise<void> {
  if (!isDesktop()) return;
  const s = useSettings.getState();
  if (!s.mobileP2pEnabled || !s.mobileP2pAutoSync) return;
  const paired = s.mobileDevices.filter(
    (d) => d.peerId && d.host && d.port,
  );
  if (paired.length === 0) return;

  let live: Awaited<ReturnType<typeof api.p2pStatus>>;
  try {
    live = await api.p2pStatus();
  } catch {
    return;
  }
  const liveById = new Map(live.peers.map((p) => [p.deviceId, p]));

  const sync = useSync.getState();
  if (sync.isInflight(workspace)) return;

  const targets = paired.filter((d) => liveById.has(d.peerId!));
  if (targets.length === 0) return;

  sync.setInflight(workspace, true);
  try {
    for (const d of targets) {
      const peer = liveById.get(d.peerId!)!;
      const token = await resolvePeerToken(d);
      if (!token) continue;
      sync.setStage("preflight", `P2P · ${d.name} 准备同步`);
      try {
        const report = await runP2PSync(
          {
            peerId: d.peerId!,
            name: d.name,
            // 用 mDNS 当前解析到的 host/port（IP 可能变）
            host: peer.host || d.host!,
            port: peer.port || d.port!,
            token,
          },
          workspace,
          s.syncConflictStrategy,
          {
            onStage: (stage, detail) => {
              const st = stage as CloudSyncStage;
              sync.setStage(
                cloudStoreStage(st),
                `P2P · ${d.name} · ${cloudStageLabel(st)}${detail ? ` · ${detail}` : ""}`,
              );
            },
            onProgress: (done, total, current) => {
              sync.setStage(
                "push",
                `P2P · ${d.name} · ${done}/${total}${current ? ` · ${current}` : ""}`,
              );
            },
          },
        );
        if (report.stage === "error") {
          reportDiagnostic({
            source: "sync",
            severity: "warning",
            message: `P2P 自动同步失败（${d.name}）`,
            detail: report.fatalError ?? "",
            workspace,
          });
        }
      } catch (e) {
        reportDiagnostic({
          source: "sync",
          severity: "warning",
          message: `P2P 自动同步失败（${d.name}）`,
          detail: e,
          workspace,
        });
      }
    }
    sync.setStage("done", "P2P 自动同步完成");
    sync.setLastSync(Date.now());
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
