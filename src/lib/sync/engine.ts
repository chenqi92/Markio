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
    let remoteByPath = new Map<string, FileEntry>();

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
    remoteByPath = new Map(remoteFiles.map((file) => [file.relPath, file]));

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
    let cancelledMidway = false;
    const total = plan.actions.length;
    for (const action of plan.actions) {
      if (deps.isCancelled?.()) {
        cancelledMidway = true;
        break;
      }
      deps.onProgress?.(done, total, action.relPath);
      const r = await executeAction(
        workspacePath,
        remoteRoot,
        action,
        manifest,
        localByPath,
        remoteByPath,
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
        // fork 等动作可能额外产生需要落基线的路径（如 forkPath 推到远端后）
        for (const extra of r.extraBaselines ?? []) {
          manifest = setBaseline(manifest, extra.relPath, extra.baseline);
        }
      }
      done++;
    }
    deps.onProgress?.(done, total);

    if (cancelledMidway) {
      // 被取消的部分同步：保存已完成动作的基线，但不刷新 lastSyncAt，
      // 避免把未完成的一轮记成"成功完成时间点"。
      setStage("cancelled");
      await saveManifest(workspacePath, manifest, deps.manifestIo);
      report.finishedAt = now();
      return report;
    }

    setStage("finalize");
    // 清掉两边都已不存在的基线（双删）。否则将来重建同名文件时，diff 会看到
    // 「本地有、远端无、基线在且 hash 与基线一致」而判成本地删除，把刚重建的文件
    // 再次扔进回收站（diff.ts:210 的注释承诺这里清，但之前从未真正清）。
    for (const relPath of Object.keys(manifest.files)) {
      if (!localByPath.has(relPath) && !remoteByPath.has(relPath)) {
        manifest = clearBaseline(manifest, relPath);
      }
    }
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
  remoteByPath: Map<string, FileEntry>,
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
          remoteByPath.get(action.relPath),
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
          remoteByPath,
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
  remoteFile: FileEntry | undefined,
  deps: SyncDeps,
  now: () => number,
): Promise<ActionResult> {
  // 内容相同短路：远端已存在且 hash 与本地一致（仅当该 adapter 的 etag 与内容 hash 可比时才会相等，
  // 不可比的 adapter 永远不相等，不会误判），直接收编为已同步，省一次整文件上传。
  if (remoteFile && localFile && remoteFile.hash === localFile.hash) {
    return {
      ok: true,
      relPath,
      baseline: {
        localMtime: localFile.mtime,
        localHash: localFile.hash,
        remoteEtag: remoteFile.hash,
        remoteMtime: remoteFile.mtime,
        lastSyncedAt: now(),
      },
    };
  }
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
  remoteByPath: Map<string, FileEntry>,
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
        remoteByPath.get(action.relPath),
        deps,
        now,
      );
    case "keep_remote":
      // 「远端删 / 本地改」冲突里，远端其实已不存在。keep_remote = 接受远端删除 =
      // 删本地，不能去 download 一个不存在的远端文件（否则 404 每轮重试、永不收敛）。
      if (!remoteByPath.has(action.relPath)) {
        await deps.localFs.softDelete(workspacePath, action.relPath);
        return placeholderOk(action.relPath, now);
      }
      return await doDownload(workspacePath, remoteRoot, action.relPath, deps, now);
    case "fork": {
      // 远端版本另存到 forkPath 并推回远端（两边都保留该副本）；当前路径走 keep_local。
      const remote = await deps.adapter.get(remoteRoot, action.relPath);
      const { hash: forkHash, mtime: forkLocalMtime } = await deps.localFs.write(
        workspacePath,
        res.forkPath,
        remote.content,
      );
      await deps.adapter.ensureParentDir(remoteRoot, res.forkPath);
      const forkPut = await deps.adapter.put(remoteRoot, res.forkPath, remote.content);
      const localResult = await doUpload(
        workspacePath,
        remoteRoot,
        action.relPath,
        localByPath.get(action.relPath),
        remoteByPath.get(action.relPath),
        deps,
        now,
      );
      if (!localResult.ok) return localResult;
      // forkPath 已在本地与远端都落地，立即记录基线，避免下一轮把它当全新本地文件再次上传。
      return {
        ...localResult,
        extraBaselines: [
          ...(localResult.extraBaselines ?? []),
          {
            relPath: res.forkPath,
            baseline: {
              localMtime: forkLocalMtime,
              localHash: forkHash,
              remoteEtag: forkPut.etag,
              remoteMtime: forkPut.mtime,
              lastSyncedAt: now(),
            },
          },
        ],
      };
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
