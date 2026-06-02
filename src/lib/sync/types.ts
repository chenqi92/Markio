// 通用同步引擎类型。引擎本身不知道任何具体云盘协议；
// 各 driveId（webdav / s3 / dropbox / gdrive）通过实现 DriveAdapter 接入。

export type DriveId = "webdav" | "s3" | "dropbox" | "gdrive";

/** 同步策略，复用 settings.syncConflictStrategy */
export type ConflictStrategy = "ask" | "newest" | "local" | "remote";

/** 同步状态机各阶段；UI 上靠这个画进度条 */
export type SyncStage =
  | "idle"
  | "scan_local"
  | "scan_remote"
  | "diff"
  | "execute"
  | "finalize"
  | "error"
  | "cancelled";

/** 本地或远端的一个文件条目 */
export interface FileEntry {
  /** 仓库根相对路径，'/' 分隔，无前导斜杠 */
  relPath: string;
  /** 远端 mtime（Unix ms）或本地 mtime */
  mtime: number;
  /** 本地用 sha256，远端用各家归一化后的 etag 字符串 */
  hash: string;
  /** 字节数；可选，diff 算法不依赖 */
  size?: number;
}

/** manifest 里每个文件的基线 */
export interface SyncBaseline {
  localMtime: number;
  localHash: string;
  remoteEtag: string;
  remoteMtime: number;
  lastSyncedAt: number;
}

export interface Tombstone {
  /** 本地删除时间（Unix ms） */
  deletedAt: number;
  /** 删除时本地最后一次同步的远端 etag，用来判断"远端有没有在删之后被改" */
  remoteEtag: string;
}

export interface SyncManifest {
  version: 1;
  drive: DriveId;
  /** 远端根（webdav 路径 / s3 prefix / dropbox 路径 / gdrive folder id） */
  remoteRoot: string;
  lastSyncAt: number;
  files: Record<string, SyncBaseline>;
  tombstones: Record<string, Tombstone>;
}

/** 同步动作类型 */
export type ActionKind =
  | "upload"           // 本地新文件 / 本地变 → 推到远端
  | "download"         // 远端新文件 / 远端变 → 拉到本地
  | "delete_remote"    // 本地删了（且策略允许）→ 远端也删
  | "delete_local"     // 远端删了（且本地没变）→ 本地进回收站
  | "conflict";        // 两边都变，需要 ConflictResolution

/** 冲突如何处理（由策略 / 用户选择决定） */
export type ConflictResolution =
  | { kind: "keep_local" }
  | { kind: "keep_remote" }
  | { kind: "fork"; forkPath: string }; // 远端版本另存为 forkPath

export interface SyncAction {
  relPath: string;
  kind: ActionKind;
  /** conflict 类型的初始决策（来自策略 / 用户）；undefined 表示等用户在 ask 模式选 */
  resolution?: ConflictResolution;
  /** 调试用：决策原因，单测断言友好 */
  reason: string;
}

export interface SyncPlan {
  actions: SyncAction[];
  /** 一些汇总数字，方便 UI 显示 */
  summary: {
    upload: number;
    download: number;
    deleteRemote: number;
    deleteLocal: number;
    conflict: number;
  };
}

export interface SyncOpts {
  conflictStrategy: ConflictStrategy;
  /** tombstone 保留窗口；默认 7 天 */
  tombstoneTtlMs?: number;
  /** 上层注入的 "现在" 时间戳，给单测稳定时间 */
  now?: () => number;
}

/** 执行单步动作的结果 */
export type ActionResult =
  | {
      ok: true;
      relPath: string;
      baseline: SyncBaseline;
      /** 同一动作额外产生的、需要写入基线的路径（如 fork 把远端另存为 forkPath 后也推到远端） */
      extraBaselines?: Array<{ relPath: string; baseline: SyncBaseline }>;
    }
  | { ok: false; relPath: string; error: string; transient: boolean };

export interface SyncReport {
  stage: SyncStage;
  startedAt: number;
  finishedAt: number;
  plan: SyncPlan;
  results: ActionResult[];
  /** 整轮失败原因（状态机崩到 error 时填） */
  fatalError?: string;
}
