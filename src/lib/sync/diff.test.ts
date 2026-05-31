import { describe, expect, it } from "vitest";
import { planDiff } from "./diff";
import { emptyManifest } from "./manifest";
import type {
  FileEntry,
  SyncBaseline,
  SyncManifest,
  SyncOpts,
  Tombstone,
} from "./types";

const FIXED_NOW = 1_700_000_000_000;

function fe(relPath: string, hash: string, mtime = 1000): FileEntry {
  return { relPath, hash, mtime };
}

function baseline(hash: string, remoteEtag = hash, mtime = 500): SyncBaseline {
  return {
    localHash: hash,
    localMtime: mtime,
    remoteEtag,
    remoteMtime: mtime,
    lastSyncedAt: mtime,
  };
}

function tombstone(etag: string, deletedAt = FIXED_NOW - 1000): Tombstone {
  return { remoteEtag: etag, deletedAt };
}

function manifestWith(
  files: Record<string, SyncBaseline> = {},
  tombstones: Record<string, Tombstone> = {},
): SyncManifest {
  return {
    ...emptyManifest("webdav", "/markio"),
    files,
    tombstones,
  };
}

function opts(
  strategy: SyncOpts["conflictStrategy"] = "ask",
  patch: Partial<SyncOpts> = {},
): SyncOpts {
  return { conflictStrategy: strategy, now: () => FIXED_NOW, ...patch };
}

describe("planDiff —— 决策表覆盖", () => {
  // ─── 单边新增 / 删除 ────────────────────────────────────────────────
  it("仅本地新文件 → upload", () => {
    const plan = planDiff(
      [fe("a.md", "h1")],
      [],
      manifestWith(),
      opts(),
    );
    expect(plan.actions).toEqual([
      { relPath: "a.md", kind: "upload", reason: "new_local" },
    ]);
    expect(plan.summary.upload).toBe(1);
  });

  it("仅远端新文件 → download", () => {
    const plan = planDiff(
      [],
      [fe("a.md", "h1")],
      manifestWith(),
      opts(),
    );
    expect(plan.actions).toEqual([
      { relPath: "a.md", kind: "download", reason: "new_remote" },
    ]);
    expect(plan.summary.download).toBe(1);
  });

  // ─── 双方都有，无 baseline ─────────────────────────────────────────
  it("双方都新 + 哈希相同（罕见但合法）→ upload 路径短路", () => {
    const plan = planDiff(
      [fe("a.md", "h1")],
      [fe("a.md", "h1")],
      manifestWith(),
      opts(),
    );
    expect(plan.actions[0]?.kind).toBe("upload");
    expect(plan.actions[0]?.reason).toBe("same_hash_no_baseline");
  });

  it("双方都新 + 哈希不同 → conflict", () => {
    const plan = planDiff(
      [fe("a.md", "local")],
      [fe("a.md", "remote")],
      manifestWith(),
      opts(),
    );
    expect(plan.actions[0]?.kind).toBe("conflict");
    expect(plan.actions[0]?.reason).toBe("both_new_no_baseline");
  });

  // ─── 双方都有 + baseline ────────────────────────────────────────────
  it("本地改 + 远端未改 → upload", () => {
    const plan = planDiff(
      [fe("a.md", "h2")],
      [fe("a.md", "h1")],
      manifestWith({ "a.md": baseline("h1") }),
      opts(),
    );
    expect(plan.actions[0]).toMatchObject({
      kind: "upload",
      reason: "local_modified",
    });
  });

  it("远端改 + 本地未改 → download", () => {
    const plan = planDiff(
      [fe("a.md", "h1")],
      [fe("a.md", "h2")],
      manifestWith({ "a.md": baseline("h1") }),
      opts(),
    );
    expect(plan.actions[0]).toMatchObject({
      kind: "download",
      reason: "remote_modified",
    });
  });

  it("双方都改 → conflict", () => {
    const plan = planDiff(
      [fe("a.md", "h2")],
      [fe("a.md", "h3")],
      manifestWith({ "a.md": baseline("h1") }),
      opts(),
    );
    expect(plan.actions[0]).toMatchObject({
      kind: "conflict",
      reason: "both_modified",
    });
  });

  it("双方都没变 → 无动作", () => {
    const plan = planDiff(
      [fe("a.md", "h1")],
      [fe("a.md", "h1")],
      manifestWith({ "a.md": baseline("h1") }),
      opts(),
    );
    expect(plan.actions).toEqual([]);
  });

  // ─── 远端消失 ───────────────────────────────────────────────────────
  it("远端消失 + 本地未改 → delete_local", () => {
    const plan = planDiff(
      [fe("a.md", "h1")],
      [],
      manifestWith({ "a.md": baseline("h1") }),
      opts(),
    );
    expect(plan.actions[0]).toMatchObject({
      kind: "delete_local",
      reason: "remote_deleted_local_unchanged",
    });
  });

  it("远端消失 + 本地改了 → conflict", () => {
    const plan = planDiff(
      [fe("a.md", "h2")],
      [],
      manifestWith({ "a.md": baseline("h1") }),
      opts(),
    );
    expect(plan.actions[0]).toMatchObject({
      kind: "conflict",
      reason: "remote_deleted_local_modified",
    });
  });

  // ─── 本地有 tombstone ───────────────────────────────────────────────
  it("本地 tombstone + 远端 etag 没变 → delete_remote", () => {
    const plan = planDiff(
      [],
      [fe("a.md", "h1")],
      manifestWith({}, { "a.md": tombstone("h1") }),
      opts(),
    );
    expect(plan.actions[0]).toMatchObject({
      kind: "delete_remote",
      reason: "local_tombstone_remote_unchanged",
    });
  });

  it("本地 tombstone + 远端 etag 变了 → download（其他设备改过）", () => {
    const plan = planDiff(
      [],
      [fe("a.md", "h2")],
      manifestWith({}, { "a.md": tombstone("h1") }),
      opts(),
    );
    expect(plan.actions[0]).toMatchObject({
      kind: "download",
      reason: "local_tombstone_remote_modified",
    });
  });

  it("tombstone 过期 → download", () => {
    const oneMonth = 30 * 24 * 60 * 60 * 1000;
    const plan = planDiff(
      [],
      [fe("a.md", "h1")],
      manifestWith({}, { "a.md": tombstone("h1", FIXED_NOW - oneMonth) }),
      opts(),
    );
    expect(plan.actions[0]).toMatchObject({
      kind: "download",
      reason: "tombstone_expired",
    });
  });

  it("本地丢失但远端未变 → delete_remote（同步本地删除）", () => {
    const plan = planDiff(
      [],
      [fe("a.md", "h1")],
      manifestWith({ "a.md": baseline("h1") }),
      opts(),
    );
    expect(plan.actions[0]).toMatchObject({
      kind: "delete_remote",
      reason: "local_missing_remote_unchanged",
    });
  });

  it("本地丢失但远端已改 → download（保留其它设备新编辑）", () => {
    const plan = planDiff(
      [],
      [fe("a.md", "h2")],
      manifestWith({ "a.md": baseline("h1") }),
      opts(),
    );
    expect(plan.actions[0]).toMatchObject({
      kind: "download",
      reason: "local_missing_remote_modified",
    });
  });

  // ─── 冲突策略 → resolution ─────────────────────────────────────────
  it("策略 ask → resolution = undefined", () => {
    const plan = planDiff(
      [fe("a.md", "local")],
      [fe("a.md", "remote")],
      manifestWith(),
      opts("ask"),
    );
    expect(plan.actions[0]?.resolution).toBeUndefined();
  });

  it("策略 newest 本地新 → keep_local", () => {
    const plan = planDiff(
      [fe("a.md", "x", 2000)],
      [fe("a.md", "y", 1000)],
      manifestWith(),
      opts("newest"),
    );
    expect(plan.actions[0]?.resolution).toEqual({ kind: "keep_local" });
  });

  it("策略 newest 远端新 → keep_remote", () => {
    const plan = planDiff(
      [fe("a.md", "x", 1000)],
      [fe("a.md", "y", 2000)],
      manifestWith(),
      opts("newest"),
    );
    expect(plan.actions[0]?.resolution).toEqual({ kind: "keep_remote" });
  });

  it("策略 local → keep_local", () => {
    const plan = planDiff(
      [fe("a.md", "x")],
      [fe("a.md", "y")],
      manifestWith(),
      opts("local"),
    );
    expect(plan.actions[0]?.resolution).toEqual({ kind: "keep_local" });
  });

  it("策略 remote → keep_remote", () => {
    const plan = planDiff(
      [fe("a.md", "x")],
      [fe("a.md", "y")],
      manifestWith(),
      opts("remote"),
    );
    expect(plan.actions[0]?.resolution).toEqual({ kind: "keep_remote" });
  });

  // ─── summary + 综合 ────────────────────────────────────────────────
  it("summary 各类型计数", () => {
    const plan = planDiff(
      [
        fe("up.md", "new"),
        fe("local_mod.md", "h2"),
        fe("both_mod.md", "lo2"),
      ],
      [
        fe("local_mod.md", "h1"),
        fe("both_mod.md", "re2"),
        fe("dl.md", "h1"),
      ],
      manifestWith(
        {
          "local_mod.md": baseline("h1"),
          "both_mod.md": baseline("lo1", "re1"),
        },
        { "dead.md": tombstone("dx") },
      ),
      opts("newest"),
    );
    expect(plan.summary).toEqual({
      upload: 2, // up.md + local_mod.md（up.md 走 new_local；local_mod 走 local_modified）
      download: 1, // dl.md
      deleteRemote: 0, // dead.md 的 tombstone 远端 dx 但远端没有 dead.md → 不处理
      deleteLocal: 0,
      conflict: 1, // both_mod.md
    });
  });

  it("双方都没的 baseline 项 → 不产生 action（finalize 时清）", () => {
    const plan = planDiff(
      [],
      [],
      manifestWith({ "gone.md": baseline("h1") }),
      opts(),
    );
    expect(plan.actions).toEqual([]);
  });
});
