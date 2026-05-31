import { describe, expect, it } from "vitest";
import {
  addTombstone,
  clearBaseline,
  emptyManifest,
  loadManifest,
  pruneTombstones,
  saveManifest,
  setBaseline,
  type ManifestIO,
} from "./manifest";
import type { SyncBaseline, SyncManifest, Tombstone } from "./types";

function makeIo(initial: Record<string, string> = {}): ManifestIO & {
  store: Record<string, string>;
} {
  const store = { ...initial };
  return {
    store,
    async read(ws) {
      return store[ws] ?? null;
    },
    async write(ws, content) {
      store[ws] = content;
    },
  };
}

const BASE: SyncBaseline = {
  localHash: "h",
  localMtime: 100,
  remoteEtag: "h",
  remoteMtime: 100,
  lastSyncedAt: 100,
};

describe("emptyManifest", () => {
  it("返回空的初始 manifest", () => {
    const m = emptyManifest("webdav", "/markio");
    expect(m).toEqual({
      version: 1,
      drive: "webdav",
      remoteRoot: "/markio",
      lastSyncAt: 0,
      files: {},
      tombstones: {},
    });
  });
});

describe("loadManifest", () => {
  it("文件不存在 → emptyManifest", async () => {
    const io = makeIo();
    const m = await loadManifest("/ws", "webdav", "/markio", io);
    expect(m.files).toEqual({});
    expect(m.tombstones).toEqual({});
  });

  it("JSON 损坏 → emptyManifest（保守回退）", async () => {
    const io = makeIo({ "/ws": "{not json" });
    const m = await loadManifest("/ws", "webdav", "/markio", io);
    expect(m.files).toEqual({});
  });

  it("版本不一致 → emptyManifest", async () => {
    const io = makeIo({
      "/ws": JSON.stringify({ version: 999, drive: "webdav" }),
    });
    const m = await loadManifest("/ws", "webdav", "/markio", io);
    expect(m.lastSyncAt).toBe(0);
  });

  it("drive 不匹配（用户换了 transport）→ emptyManifest", async () => {
    const io = makeIo({
      "/ws": JSON.stringify({
        version: 1,
        drive: "s3",
        remoteRoot: "/markio",
        lastSyncAt: 123,
        files: { "a.md": BASE },
        tombstones: {},
      }),
    });
    const m = await loadManifest("/ws", "webdav", "/markio", io);
    expect(m.files).toEqual({});
  });

  it("remoteRoot 不匹配（用户换了远端目录）→ emptyManifest", async () => {
    const io = makeIo({
      "/ws": JSON.stringify({
        version: 1,
        drive: "webdav",
        remoteRoot: "/old",
        lastSyncAt: 123,
        files: { "a.md": BASE },
        tombstones: {},
      }),
    });
    const m = await loadManifest("/ws", "webdav", "/markio", io);
    expect(m.remoteRoot).toBe("/markio");
    expect(m.files).toEqual({});
  });

  it("正常解析", async () => {
    const original: SyncManifest = {
      version: 1,
      drive: "webdav",
      remoteRoot: "/markio",
      lastSyncAt: 123,
      files: { "a.md": BASE },
      tombstones: { "b.md": { deletedAt: 50, remoteEtag: "x" } },
    };
    const io = makeIo({ "/ws": JSON.stringify(original) });
    const m = await loadManifest("/ws", "webdav", "/markio", io);
    expect(m).toEqual(original);
  });
});

describe("saveManifest", () => {
  it("写 JSON 到 io", async () => {
    const io = makeIo();
    const m: SyncManifest = {
      version: 1,
      drive: "webdav",
      remoteRoot: "/markio",
      lastSyncAt: 1,
      files: { "a.md": BASE },
      tombstones: {},
    };
    await saveManifest("/ws", m, io);
    const written = JSON.parse(io.store["/ws"]!);
    expect(written.files["a.md"]).toEqual(BASE);
  });
});

describe("setBaseline / addTombstone / clearBaseline", () => {
  const start = emptyManifest("webdav", "/markio");

  it("setBaseline 同时清同名 tombstone", () => {
    const withTomb = addTombstone(start, "a.md", {
      deletedAt: 1,
      remoteEtag: "old",
    });
    const next = setBaseline(withTomb, "a.md", BASE);
    expect(next.files["a.md"]).toEqual(BASE);
    expect(next.tombstones["a.md"]).toBeUndefined();
  });

  it("addTombstone 同时清同名 baseline", () => {
    const withBase = setBaseline(start, "a.md", BASE);
    const next = addTombstone(withBase, "a.md", {
      deletedAt: 200,
      remoteEtag: "h",
    });
    expect(next.tombstones["a.md"]).toEqual({
      deletedAt: 200,
      remoteEtag: "h",
    });
    expect(next.files["a.md"]).toBeUndefined();
  });

  it("clearBaseline 清单条目", () => {
    const withBase = setBaseline(start, "a.md", BASE);
    const next = clearBaseline(withBase, "a.md");
    expect(next.files["a.md"]).toBeUndefined();
  });
});

describe("pruneTombstones", () => {
  it("清掉过期 tombstone", () => {
    const now = 10_000;
    const ttl = 1000;
    const tombs: Record<string, Tombstone> = {
      fresh: { deletedAt: 9500, remoteEtag: "x" },
      stale: { deletedAt: 8000, remoteEtag: "y" },
    };
    const m: SyncManifest = {
      ...emptyManifest("webdav", "/markio"),
      tombstones: tombs,
    };
    const pruned = pruneTombstones(m, { ttlMs: ttl, now: () => now });
    expect(pruned.tombstones).toEqual({
      fresh: { deletedAt: 9500, remoteEtag: "x" },
    });
  });
});
