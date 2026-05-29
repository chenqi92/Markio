import { create } from "zustand";
import type { TabInfo } from "@/types";
import { api, parseError, type FileSig } from "@/lib/api";
import {
  basename,
  dirname,
  pathContains,
  pathKey,
  samePath,
  uid,
} from "@/lib/utils";
import { useWorkspace } from "./workspace";
import { useStreak } from "./streak";
import { useRecents } from "./recents";
import { useUI } from "./ui";
import { useSettings } from "./settings";
import { useRag } from "./rag";
import { useVaultIndex } from "./vaultIndex";
import { reportDiagnostic } from "./diagnostics";
import { spaceCJK } from "@/lib/pangu";
import { createKeyedTimers } from "@/lib/keyedTimers";
import { registerWorkspaceCleanup } from "./workspaceCleanup";

/** 同一文件 5 分钟内只写一次快照，避免自动保存把磁盘塞满 */
const SNAPSHOT_DEDUP_MS = 5 * 60 * 1000;
const lastSnapshotAt = new Map<string, number>();

interface TabsState {
  tabs: TabInfo[];
  activeId: string | null;
  /** 每个 tab 对应的磁盘签名（mtime + hash），保存时校验 */
  sigs: Record<string, FileSig>;

  openFile: (workspaceId: string, path: string, opts?: { silent?: boolean }) => Promise<void>;
  openPath: (path: string, opts?: { silent?: boolean }) => Promise<void>;
  closeTab: (id: string) => void;
  closeTabsForPath: (path: string) => void;
  /** 文件/文件夹被重命名或移动后，迁移所有 path 命中 from 或位于 from 下的 tab。 */
  relocateTabs: (from: string, to: string) => void;
  /** 列出当前 path（或其子路径）对应的未保存 tab；删除前用于提示。 */
  dirtyTabsUnder: (path: string) => TabInfo[];
  setActive: (id: string) => void;
  updateContent: (id: string, content: string) => void;
  saveTab: (id: string, force?: boolean) => Promise<"ok" | "conflict" | "error">;
  saveActive: () => Promise<"ok" | "conflict" | "error">;
  togglePin: (id: string) => void;
  reorderTabs: (fromId: string, toId: string) => void;
  activeTab: () => TabInfo | undefined;
}

const POST_SAVE_RAG_DELAY_MS = 4_000;
const POST_SAVE_TOKEN_DELAY_MS = 2_500;
const ragReindexTimers = createKeyedTimers();
const tokenRefreshTimers = createKeyedTimers();

export function cancelPendingTimersForWorkspace(workspacePath: string) {
  ragReindexTimers.clearPrefix(`${workspacePath}\0`);
  tokenRefreshTimers.cancel(workspacePath);
}

registerWorkspaceCleanup(cancelPendingTimersForWorkspace);

function scheduleRagReindex(workspacePath: string, filePath: string) {
  const key = `${workspacePath}\0${filePath}`;
  ragReindexTimers.schedule(
    key,
    () => {
      void (async () => {
        try {
          const s = useSettings.getState();
          if (!s.ragEnabled || !s.ragAutoReindexOnSave) return;
          await useRag.getState().reindexFile(workspacePath, filePath);
        } catch (err) {
          console.warn("[rag.reindexFile] post-save failed", err);
          reportDiagnostic({
            source: "rag",
            severity: "warning",
            message: "保存后索引更新失败",
            detail: err,
            workspace: workspacePath,
          });
        }
      })();
    },
    POST_SAVE_RAG_DELAY_MS,
  );
}

function scheduleVaultTokenRefresh(workspacePath: string) {
  tokenRefreshTimers.schedule(
    workspacePath,
    () => useVaultIndex.getState().scheduleRebuild(workspacePath),
    POST_SAVE_TOKEN_DELAY_MS,
  );
}

export const useTabs = create<TabsState>((set, get) => ({
  tabs: [],
  activeId: null,
  sigs: {},

  openFile: async (workspaceId, path, opts) => {
    const silent = opts?.silent === true;
    const exist = get().tabs.find(
      (t) => t.workspaceId === workspaceId && t.path === path,
    );
    if (exist) {
      if (!silent) set({ activeId: exist.id });
      return;
    }
    let content: string;
    let sig: FileSig;
    try {
      const opened = await api.open(path);
      content = opened.content;
      sig = opened.sig;
    } catch (e) {
      useUI.getState().setToast({
        stage: "error",
        message: `无法读取文件：${(e as Error).message}`,
      });
      setTimeout(() => useUI.getState().setToast(null), 2500);
      return;
    }
    const tab: TabInfo = {
      id: uid(),
      workspaceId,
      path,
      title: basename(path),
      baseline: content,
      content,
      dirty: false,
      scrollTop: 0,
      pinned: false,
    };
    set((s) => ({
      tabs: [...s.tabs, tab],
      // silent = true 时不切活跃，给 session restore 用，避免每打开一个就
      // 切一次 active 把编辑器频繁 unmount/mount。
      activeId: silent ? s.activeId : tab.id,
      sigs: { ...s.sigs, [tab.id]: sig },
    }));
    useRecents.getState().push(workspaceId, path, basename(path));
  },

  openPath: async (path, opts) => {
    const norm = path.replace(/\\/g, "/");
    const ws = useWorkspace.getState();
    let belong = ws.workspaces.find(
      (w) => norm === w.path || norm.startsWith(w.path.replace(/\\/g, "/") + "/"),
    );
    if (!belong) {
      const parent = dirname(path);
      const id = await ws.addWorkspace(parent);
      belong = useWorkspace.getState().workspaces.find((w) => w.id === id);
    }
    if (!belong) return;
    await get().openFile(belong.id, path, opts);
  },

  closeTab: (id) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      if (idx === -1) return s;
      const next = s.tabs.filter((t) => t.id !== id);
      let activeId = s.activeId;
      if (s.activeId === id) {
        const fallback = next[idx] ?? next[idx - 1] ?? null;
        activeId = fallback?.id ?? null;
      }
      // 没有其它 tab 再持有同一路径时通知 Rust 关闭
      const closing = s.tabs.find((t) => t.id === id);
      if (closing) {
        const stillOpen = next.some((t) => t.path === closing.path);
        if (!stillOpen) {
          api.close(closing.path).catch(() => undefined);
        }
      }
      const newSigs = { ...s.sigs };
      delete newSigs[id];
      return { tabs: next, activeId, sigs: newSigs };
    }),

  closeTabsForPath: (path) =>
    set((s) => {
      const closing = s.tabs.filter((t) => pathContains(path, t.path));
      if (closing.length === 0) return s;

      const closingIds = new Set(closing.map((t) => t.id));
      const closingPaths = new Set(closing.map((t) => t.path));
      const next = s.tabs.filter((t) => !closingIds.has(t.id));
      const activeWasClosed = s.activeId ? closingIds.has(s.activeId) : false;
      let activeId = s.activeId;
      if (activeWasClosed) {
        const activeIdx = s.tabs.findIndex((t) => t.id === s.activeId);
        const fallback = next[activeIdx] ?? next[activeIdx - 1] ?? next[0] ?? null;
        activeId = fallback?.id ?? null;
      }

      const newSigs = { ...s.sigs };
      for (const id of closingIds) delete newSigs[id];

      for (const p of closingPaths) {
        const stillOpen = next.some((t) => samePath(t.path, p));
        if (!stillOpen) api.close(p).catch(() => undefined);
      }

      return { tabs: next, activeId, sigs: newSigs };
    }),

  relocateTabs: (from, to) =>
    set((s) => {
      if (!from || !to || samePath(from, to)) return s;
      const fromKey = pathKey(from);
      let changed = false;
      const tabs = s.tabs.map((t) => {
        const tKey = pathKey(t.path);
        if (tKey === fromKey) {
          changed = true;
          return { ...t, path: to, title: basename(to) };
        }
        if (tKey.startsWith(`${fromKey}/`)) {
          changed = true;
          // 保留 from 之下的相对 suffix，拼到 to；pathKey 已经把 \ 统一成 /
          const suffix = tKey.slice(fromKey.length);
          const newPath = to + suffix;
          return { ...t, path: newPath, title: basename(newPath) };
        }
        return t;
      });
      return changed ? { tabs } : s;
    }),

  dirtyTabsUnder: (path) =>
    get().tabs.filter((t) => t.dirty && pathContains(path, t.path)),

  setActive: (id) => set({ activeId: id }),

  updateContent: (id, content) => {
    const prev = get().tabs.find((t) => t.id === id);
    if (prev) {
      const delta = content.length - prev.content.length;
      if (delta > 0) useStreak.getState().track(delta);
    }
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id ? { ...t, content, dirty: content !== t.baseline } : t,
      ),
    }));
  },

  saveTab: async (id, force = false) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab) return "error";
    const sig = get().sigs[id];
    const settings = useSettings.getState();
    // 保存前若开启 CJK 空格，先对 content 做一遍 pangu
    let content = tab.content;
    if (settings.autoSpaceCJK) {
      const normalized = spaceCJK(content);
      if (normalized !== content) {
        content = normalized;
        // 把规范化后的内容回灌到当前 tab，避免下一次 saveTab 再算一遍
        set((s) => ({
          tabs: s.tabs.map((t) => (t.id === id ? { ...t, content } : t)),
        }));
      }
    }
    try {
      let shouldSnapshot = false;
      if (settings.snapshotOnSave) {
        const last = lastSnapshotAt.get(tab.path) ?? 0;
        shouldSnapshot = Date.now() - last > SNAPSHOT_DEDUP_MS;
      }
      const newSig = await api.save(
        tab.path,
        content,
        sig?.mtime,
        sig?.hash,
        force,
        shouldSnapshot,
      );
      const ws = useWorkspace
        .getState()
        .workspaces.find((w) => w.id === tab.workspaceId);
      if (ws) {
        // 自动保存可能很频繁，后台索引和 token 扫描必须合并触发。
        scheduleRagReindex(ws.path, tab.path);
        scheduleVaultTokenRefresh(ws.path);
        if (shouldSnapshot) {
          lastSnapshotAt.set(tab.path, Date.now());
        }
      }
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === id ? { ...t, baseline: content, dirty: false } : t,
        ),
        sigs: { ...s.sigs, [id]: newSig },
      }));
      return "ok";
    } catch (e) {
      const err = parseError(e);
      if (err.code === "CONFLICT") return "conflict";
      console.error("saveTab failed", err.message);
      return "error";
    }
  },

  saveActive: async () => {
    const id = get().activeId;
    if (!id) return "error";
    return get().saveTab(id);
  },

  togglePin: (id) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t)),
    })),

  reorderTabs: (fromId, toId) =>
    set((s) => {
      const tabs = [...s.tabs].sort((a, b) => {
        if (a.pinned === b.pinned) return 0;
        return a.pinned ? -1 : 1;
      });
      const fromIdx = tabs.findIndex((t) => t.id === fromId);
      const toIdx = tabs.findIndex((t) => t.id === toId);
      if (fromIdx < 0 || toIdx < 0) {
        return s;
      }
      const [it] = tabs.splice(fromIdx, 1);
      tabs.splice(toIdx, 0, it!);
      return { tabs };
    }),

  activeTab: () => {
    const id = get().activeId;
    return id ? get().tabs.find((t) => t.id === id) : undefined;
  },
}));
