// 同步引擎的核心：三方 diff（local / remote / manifest 基线）→ 同步动作清单。
// 不读盘、不发网络请求，纯算法；上层负责把扫描结果喂进来。
//
// 算法对照 docs/ 设计文档 §4 决策表。每条 action 都带 reason 字符串，方便：
//   1) 单测断言用哪条规则
//   2) UI 上对用户解释"为什么要删这个"

import type {
  ConflictResolution,
  FileEntry,
  SyncAction,
  SyncManifest,
  SyncOpts,
  SyncPlan,
} from "./types";

const DEFAULT_TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function toMap(entries: FileEntry[]): Map<string, FileEntry> {
  const m = new Map<string, FileEntry>();
  for (const e of entries) m.set(e.relPath, e);
  return m;
}

function resolutionFromStrategy(
  local: FileEntry,
  remote: FileEntry,
  strategy: SyncOpts["conflictStrategy"],
): ConflictResolution | undefined {
  switch (strategy) {
    case "local":
      return { kind: "keep_local" };
    case "remote":
      return { kind: "keep_remote" };
    case "newest":
      return local.mtime >= remote.mtime
        ? { kind: "keep_local" }
        : { kind: "keep_remote" };
    case "ask":
    default:
      return undefined; // 等用户在 ask UI 里选
  }
}

/**
 * planDiff —— 决策核心。
 *
 * 输入：
 *   localFiles  本地仓库扫到的所有文件（已排除 .markio/）
 *   remoteFiles 远端列表（adapter.list 返回）
 *   manifest    上次 finalize 写的基线 + tombstones
 *   opts        冲突策略、tombstone TTL、now()
 *
 * 输出：SyncPlan，actions 列表 + summary 汇总。
 */
export function planDiff(
  localFiles: FileEntry[],
  remoteFiles: FileEntry[],
  manifest: SyncManifest,
  opts: SyncOpts,
): SyncPlan {
  const localMap = toMap(localFiles);
  const remoteMap = toMap(remoteFiles);
  const baseline = manifest.files;
  const tombstones = manifest.tombstones;
  const now = (opts.now ?? Date.now)();
  const ttl = opts.tombstoneTtlMs ?? DEFAULT_TOMBSTONE_TTL_MS;

  const actions: SyncAction[] = [];
  const visited = new Set<string>();

  for (const [relPath, local] of localMap.entries()) {
    visited.add(relPath);
    // 超大文件（Rust 扫描标记 oversize:*）：不读全文哈希，也无法整文件上传。
    // 这里直接跳过任何动作——关键是它"在场"已经避免被当作本地删除而误删远端副本。
    if (local.hash.startsWith("oversize:")) continue;
    const remote = remoteMap.get(relPath);
    const base = baseline[relPath];

    if (!remote && !base) {
      actions.push({
        relPath,
        kind: "upload",
        reason: "new_local",
      });
      continue;
    }

    if (!remote && base) {
      // 曾经同步过、现在远端没了 → 远端被删
      if (local.hash === base.localHash) {
        // 本地没动 → 本地也跟着删
        actions.push({
          relPath,
          kind: "delete_local",
          reason: "remote_deleted_local_unchanged",
        });
      } else {
        // 本地变了 → 冲突
        actions.push({
          relPath,
          kind: "conflict",
          resolution: resolutionFromStrategy(
            local,
            { relPath, mtime: base.remoteMtime, hash: base.remoteEtag },
            opts.conflictStrategy,
          ),
          reason: "remote_deleted_local_modified",
        });
      }
      continue;
    }

    if (remote && !base) {
      // 双方都有但没基线 → 同名新文件冲突
      if (local.hash === remote.hash) {
        // 内容相同（少见但可能：用户预先复制过去）→ 直接收编为已同步
        actions.push({
          relPath,
          kind: "upload", // upload 路径里会处理 "实际上是 same" 的 short-circuit
          reason: "same_hash_no_baseline",
        });
      } else {
        actions.push({
          relPath,
          kind: "conflict",
          resolution: resolutionFromStrategy(local, remote, opts.conflictStrategy),
          reason: "both_new_no_baseline",
        });
      }
      continue;
    }

    // remote && base 都有
    const localChanged = local.hash !== base!.localHash;
    const remoteChanged = remote!.hash !== base!.remoteEtag;

    if (!localChanged && !remoteChanged) continue; // 无需动作
    if (localChanged && !remoteChanged) {
      actions.push({ relPath, kind: "upload", reason: "local_modified" });
      continue;
    }
    if (!localChanged && remoteChanged) {
      actions.push({ relPath, kind: "download", reason: "remote_modified" });
      continue;
    }
    // 两边都变
    actions.push({
      relPath,
      kind: "conflict",
      resolution: resolutionFromStrategy(local, remote!, opts.conflictStrategy),
      reason: "both_modified",
    });
  }

  // 处理只在远端 / 只在基线的文件
  for (const [relPath, remote] of remoteMap.entries()) {
    if (visited.has(relPath)) continue;
    visited.add(relPath);
    const base = baseline[relPath];
    const tomb = tombstones[relPath];

    if (!base && !tomb) {
      actions.push({ relPath, kind: "download", reason: "new_remote" });
      continue;
    }

    if (tomb && now - tomb.deletedAt < ttl) {
      // 本地最近删过；如果远端 etag 没在删除之后改 → 远端也跟着删；否则当回来了
      if (remote.hash === tomb.remoteEtag) {
        actions.push({
          relPath,
          kind: "delete_remote",
          reason: "local_tombstone_remote_unchanged",
        });
      } else {
        // 远端在删除后被改过 → 用户其他设备改了，拉下来
        actions.push({
          relPath,
          kind: "download",
          reason: "local_tombstone_remote_modified",
        });
      }
      continue;
    }

    if (base && !tomb) {
      // 本地曾同步过但现在没了。若远端仍是上次同步版本，则把本地删除传播到远端；
      // 若远端之后又变了，保守拉回远端版本，避免抹掉其它设备的新编辑。
      if (remote.hash === base.remoteEtag) {
        actions.push({
          relPath,
          kind: "delete_remote",
          reason: "local_missing_remote_unchanged",
        });
      } else {
        actions.push({
          relPath,
          kind: "download",
          reason: "local_missing_remote_modified",
        });
      }
      continue;
    }

    // tomb 但已过期 → 拉回来
    actions.push({ relPath, kind: "download", reason: "tombstone_expired" });
  }

  // 只在基线 / tombstone 里、双方都没的文件
  for (const relPath of Object.keys(baseline)) {
    if (visited.has(relPath)) continue;
    // 本地和远端都不存在但基线里有 → 双方都删了，啥也不用做（finalize 时清基线）
  }

  const summary = {
    upload: 0,
    download: 0,
    deleteRemote: 0,
    deleteLocal: 0,
    conflict: 0,
  };
  for (const a of actions) {
    if (a.kind === "upload") summary.upload++;
    else if (a.kind === "download") summary.download++;
    else if (a.kind === "delete_remote") summary.deleteRemote++;
    else if (a.kind === "delete_local") summary.deleteLocal++;
    else if (a.kind === "conflict") summary.conflict++;
  }

  return { actions, summary };
}
