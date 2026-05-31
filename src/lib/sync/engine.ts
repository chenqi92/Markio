// 同步状态机入口。
//
// runSync 由 UI / 调度器调用，串起：
//   1. scan_local + scan_remote
//   2. diff -> SyncPlan
//   3. execute（按 plan 调 transport / localFs）
//   4. finalize（更新 manifest + lastSyncAt）
//
// 所有 I/O 通过传入的 deps 注入，便于单测。

import type {
  ActionResult,
  SyncManifest,
  SyncOpts,
  SyncReport,
  SyncStage,
  FileEntry,
} from "./types";
import type { DriveAdapter } from "./transport";
import { TransportError } from "./transport";
import { planDiff } from "./diff";
import {
  loadManifest,
  saveManifest,
  setBaseline,
  clearBaseline,
  pruneTombstones,
  type ManifestIO,
} from "./manifest";

export interface LocalFs {
  /** 列本地仓库的所有 markdown / 资源文件（排除 .markio/） */
  scan(workspacePath: string): Promise<FileEntry[]>;
  /** 读本地文件内容。当前 Tauri 实现统一传 base64，避免二进制资源损坏。 */
  read(workspacePath: string, relPath: string): Promise<string>;
  /** 写本地文件，返回新的 hash + mtime */
  write(
    workspacePath: string,
    relPath: string,
    content: string,
  ): Promise<{ hash: string; mtime: number }>;
  /** 软删本地文件（进回收站），返回原文件最后一次的 hash */
  softDelete(workspacePath: string, relPath: string): Promise<{ hash: string }>;
}

export interface SyncDeps {
  adapter: DriveAdapter;
  manifestIo: ManifestIO;
  localFs: LocalFs;
  /** UI 进度回调 */
  onStage?: (stage: SyncStage, detail?: string) => void;
  onProgress?: (done: number, total: number, current?: string) => void;
  /** 外部取消：状态机每步进入前 / 每个 action 前会检查 */
  isCancelled?: () => boolean;
}

const MAX_RETRY = 3;
const RETRY_BACKOFF_MS = [500, 1500, 4000];

export async function runSync(
  workspacePath: string,
  remoteRoot: string,
  opts: SyncOpts,
  deps: SyncDeps,
): Promise<SyncReport> {
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const report: SyncReport = {
    stage: "idle",
    startedAt,
    finishedAt: startedAt,
    plan: { actions: [], summary: emptySummary() },
    results: [],
  };

  const setStage = (s: SyncStage, detail?: string) => {
    report.stage = s;
    deps.onStage?.(s, detail);
  };

  try {
    if (deps.isCancelled?.()) {
      setStage("cancelled");
      report.finishedAt = now();
      return report;
    }

    setStage("scan_local");
    const localFiles = await deps.localFs.scan(workspacePath);
    const localByPath = new Map(localFiles.map((file) => [file.relPath, file]));

    if (deps.isCancelled?.()) {
      setStage("cancelled");
      report.finishedAt = now();
      return report;
    }

    setStage("scan_remote");
    let remoteFiles: FileEntry[] = [];
    try {
      remoteFiles = await deps.adapter.list(remoteRoot);
    } catch (e) {
      throw new TransportError(`远端 list 失败：${(e as Error).message}`, {
        transient: false,
      });
    }

    let manifest = await loadManifest(
      workspacePath,
      deps.adapter.id as SyncManifest["drive"],
      remoteRoot,
      deps.manifestIo,
    );
    manifest = pruneTombstones(manifest, { now });

    setStage("diff");
    const plan = planDiff(localFiles, remoteFiles, manifest, opts);
    report.plan = plan;

    if (deps.isCancelled?.()) {
      setStage("cancelled");
      await saveManifest(workspacePath, manifest, deps.manifestIo);
      report.finishedAt = now();
      return report;
    }

    setStage("execute");
    let done = 0;
    const total = plan.actions.length;
    for (const action of plan.actions) {
      if (deps.isCancelled?.()) {
        setStage("cancelled");
        break;
      }
      deps.onProgress?.(done, total, action.relPath);
      const r = await executeAction(
        workspacePath,
        remoteRoot,
        action,
        manifest,
        localByPath,
        deps,
        now,
      );
      report.results.push(r);
      if (r.ok) {
        if (action.kind === "delete_local" || action.kind === "delete_remote") {
          // 双方都没了 → 基线清掉、不留 tombstone（因为对端也确认删了）
          manifest = clearBaseline(manifest, action.relPath);
        } else {
          manifest = setBaseline(manifest, action.relPath, r.baseline);
        }
      }
      done++;
    }
    deps.onProgress?.(done, total);

    setStage("finalize");
    manifest = { ...manifest, lastSyncAt: now() };
    await saveManifest(workspacePath, manifest, deps.manifestIo);
    setStage("idle");
  } catch (e) {
    report.fatalError = (e as Error).message || String(e);
    setStage("error", report.fatalError);
  }

  report.finishedAt = now();
  return report;
}

async function executeAction(
  workspacePath: string,
  remoteRoot: string,
  action: SyncReport["plan"]["actions"][number],
  manifest: SyncManifest,
  localByPath: Map<string, FileEntry>,
  deps: SyncDeps,
  now: () => number,
): Promise<ActionResult> {
  return withRetry(action.relPath, async () => {
    switch (action.kind) {
      case "upload":
        return await doUpload(
          workspacePath,
          remoteRoot,
          action.relPath,
          localByPath.get(action.relPath),
          deps,
          now,
        );
      case "download":
        return await doDownload(workspacePath, remoteRoot, action.relPath, deps, now);
      case "delete_remote": {
        await deps.adapter.delete(remoteRoot, action.relPath);
        // baseline 在外层 setBaseline / clearBaseline 处理
        return placeholderOk(action.relPath, now);
      }
      case "delete_local": {
        await deps.localFs.softDelete(workspacePath, action.relPath);
        return placeholderOk(action.relPath, now);
      }
      case "conflict":
        return await doConflict(
          workspacePath,
          remoteRoot,
          action,
          manifest,
          localByPath,
          deps,
          now,
        );
    }
  });
}

async function doUpload(
  workspacePath: string,
  remoteRoot: string,
  relPath: string,
  localFile: FileEntry | undefined,
  deps: SyncDeps,
  now: () => number,
): Promise<ActionResult> {
  const content = await deps.localFs.read(workspacePath, relPath);
  await deps.adapter.ensureParentDir(remoteRoot, relPath);
  const { etag, mtime } = await deps.adapter.put(remoteRoot, relPath, content);
  return {
    ok: true,
    relPath,
    baseline: {
      localMtime: localFile?.mtime ?? now(),
      localHash: localFile?.hash ?? etag,
      remoteEtag: etag,
      remoteMtime: mtime,
      lastSyncedAt: now(),
    },
  };
}

async function doDownload(
  workspacePath: string,
  remoteRoot: string,
  relPath: string,
  deps: SyncDeps,
  now: () => number,
): Promise<ActionResult> {
  const { content, etag, mtime } = await deps.adapter.get(remoteRoot, relPath);
  const { hash, mtime: localMtime } = await deps.localFs.write(
    workspacePath,
    relPath,
    content,
  );
  return {
    ok: true,
    relPath,
    baseline: {
      localMtime,
      localHash: hash,
      remoteEtag: etag,
      remoteMtime: mtime,
      lastSyncedAt: now(),
    },
  };
}

async function doConflict(
  workspacePath: string,
  remoteRoot: string,
  action: SyncReport["plan"]["actions"][number],
  _manifest: SyncManifest,
  localByPath: Map<string, FileEntry>,
  deps: SyncDeps,
  now: () => number,
): Promise<ActionResult> {
  const res = action.resolution;
  if (!res) {
    return {
      ok: false,
      relPath: action.relPath,
      error: "等待用户选择（ask 模式未提供 resolution）",
      transient: false,
    };
  }
  switch (res.kind) {
    case "keep_local":
      return await doUpload(
        workspacePath,
        remoteRoot,
        action.relPath,
        localByPath.get(action.relPath),
        deps,
        now,
      );
    case "keep_remote":
      return await doDownload(workspacePath, remoteRoot, action.relPath, deps, now);
    case "fork": {
      // 远端版本另存到 forkPath；当前路径走 keep_local
      const remote = await deps.adapter.get(remoteRoot, action.relPath);
      await deps.localFs.write(workspacePath, res.forkPath, remote.content);
      return await doUpload(
        workspacePath,
        remoteRoot,
        action.relPath,
        localByPath.get(action.relPath),
        deps,
        now,
      );
    }
  }
}

function placeholderOk(relPath: string, now: () => number): ActionResult {
  return {
    ok: true,
    relPath,
    baseline: {
      localMtime: now(),
      localHash: "",
      remoteEtag: "",
      remoteMtime: now(),
      lastSyncedAt: now(),
    },
  };
}

async function withRetry<T extends ActionResult>(
  relPath: string,
  fn: () => Promise<T>,
): Promise<ActionResult> {
  let lastErr: unknown;
  for (let i = 0; i < MAX_RETRY; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const transient = e instanceof TransportError ? e.transient : true;
      if (!transient || i === MAX_RETRY - 1) break;
      await sleep(RETRY_BACKOFF_MS[i] ?? 4000);
    }
  }
  return {
    ok: false,
    relPath,
    error: (lastErr as Error)?.message || String(lastErr),
    transient: lastErr instanceof TransportError ? lastErr.transient : true,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function emptySummary() {
  return { upload: 0, download: 0, deleteRemote: 0, deleteLocal: 0, conflict: 0 };
}
