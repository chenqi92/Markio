// manifest 读写 + tombstone GC。
// 走仓库 .markio/sync-manifest.json，不上传到远端。
//
// 这里只暴露纯函数形态，I/O 走调用方传入的 reader/writer，方便：
//   1) 单测用内存 store
//   2) Tauri / 浏览器环境用 api.readText / api.save 接入

import type { SyncManifest, DriveId, SyncBaseline, Tombstone } from "./types";

export const MANIFEST_PATH = ".markio/sync-manifest.json";
const DEFAULT_TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface ManifestIO {
  /** 读 manifest 原文，文件不存在时返回 null */
  read(workspacePath: string): Promise<string | null>;
  /** 原子写 manifest（实现方负责 atomic）*/
  write(workspacePath: string, content: string): Promise<void>;
}

export function emptyManifest(drive: DriveId, remoteRoot: string): SyncManifest {
  return {
    version: 1,
    drive,
    remoteRoot,
    lastSyncAt: 0,
    files: {},
    tombstones: {},
  };
}

/**
 * 加载 manifest；若文件不存在 / 版本不兼容 / JSON 损坏，则返回 emptyManifest。
 * 设计上保守：损坏一律视为"重新冷启动同步"，由后续 diff 决定全量上传 / 下载。
 */
export async function loadManifest(
  workspacePath: string,
  drive: DriveId,
  remoteRoot: string,
  io: ManifestIO,
): Promise<SyncManifest> {
  const raw = await io.read(workspacePath);
  if (!raw) return emptyManifest(drive, remoteRoot);
  try {
    const parsed = JSON.parse(raw) as Partial<SyncManifest>;
    if (parsed.version !== 1) return emptyManifest(drive, remoteRoot);
    if (parsed.drive !== drive) return emptyManifest(drive, remoteRoot);
    return {
      version: 1,
      drive: parsed.drive,
      remoteRoot: parsed.remoteRoot ?? remoteRoot,
      lastSyncAt: typeof parsed.lastSyncAt === "number" ? parsed.lastSyncAt : 0,
      files: typeof parsed.files === "object" && parsed.files !== null
        ? (parsed.files as Record<string, SyncBaseline>)
        : {},
      tombstones:
        typeof parsed.tombstones === "object" && parsed.tombstones !== null
          ? (parsed.tombstones as Record<string, Tombstone>)
          : {},
    };
  } catch {
    return emptyManifest(drive, remoteRoot);
  }
}

export async function saveManifest(
  workspacePath: string,
  manifest: SyncManifest,
  io: ManifestIO,
): Promise<void> {
  await io.write(workspacePath, JSON.stringify(manifest, null, 2));
}

/** 清掉超过 TTL 的 tombstone，避免无限增长 */
export function pruneTombstones(
  manifest: SyncManifest,
  opts: { ttlMs?: number; now?: () => number } = {},
): SyncManifest {
  const ttl = opts.ttlMs ?? DEFAULT_TOMBSTONE_TTL_MS;
  const now = (opts.now ?? Date.now)();
  const kept: Record<string, Tombstone> = {};
  for (const [path, t] of Object.entries(manifest.tombstones)) {
    if (now - t.deletedAt < ttl) kept[path] = t;
  }
  return { ...manifest, tombstones: kept };
}

/** 添加 / 更新一条 baseline */
export function setBaseline(
  manifest: SyncManifest,
  relPath: string,
  baseline: SyncBaseline,
): SyncManifest {
  return {
    ...manifest,
    files: { ...manifest.files, [relPath]: baseline },
    tombstones: stripKey(manifest.tombstones, relPath),
  };
}

/** 添加 tombstone（本地删了的文件） */
export function addTombstone(
  manifest: SyncManifest,
  relPath: string,
  tombstone: Tombstone,
): SyncManifest {
  return {
    ...manifest,
    files: stripKey(manifest.files, relPath),
    tombstones: { ...manifest.tombstones, [relPath]: tombstone },
  };
}

/** 同步完成后双方都没的文件，清基线 */
export function clearBaseline(
  manifest: SyncManifest,
  relPath: string,
): SyncManifest {
  return {
    ...manifest,
    files: stripKey(manifest.files, relPath),
  };
}

function stripKey<V>(obj: Record<string, V>, key: string): Record<string, V> {
  if (!(key in obj)) return obj;
  const next = { ...obj };
  delete next[key];
  return next;
}
