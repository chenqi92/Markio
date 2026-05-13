import { create } from "zustand";
import type { TabInfo } from "@/types";
import { api, parseError, type FileSig } from "@/lib/api";
import { basename, dirname, uid } from "@/lib/utils";
import { useWorkspace } from "./workspace";
import { useStreak } from "./streak";
import { useRecents } from "./recents";

interface TabsState {
  tabs: TabInfo[];
  activeId: string | null;
  /** 每个 tab 对应的磁盘签名（mtime + hash），保存时校验 */
  sigs: Record<string, FileSig>;

  openFile: (workspaceId: string, path: string) => Promise<void>;
  openPath: (path: string) => Promise<void>;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
  updateContent: (id: string, content: string) => void;
  saveTab: (id: string, force?: boolean) => Promise<"ok" | "conflict" | "error">;
  saveActive: () => Promise<"ok" | "conflict" | "error">;
  togglePin: (id: string) => void;
  reorderTabs: (fromIdx: number, toIdx: number) => void;
  activeTab: () => TabInfo | undefined;
}

export const useTabs = create<TabsState>((set, get) => ({
  tabs: [],
  activeId: null,
  sigs: {},

  openFile: async (workspaceId, path) => {
    const exist = get().tabs.find(
      (t) => t.workspaceId === workspaceId && t.path === path,
    );
    if (exist) {
      set({ activeId: exist.id });
      return;
    }
    let content = "";
    let sig: FileSig | undefined;
    try {
      const opened = await api.open(path);
      content = opened.content;
      sig = opened.sig;
    } catch (e) {
      content = `> 无法读取文件：${(e as Error).message}`;
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
      activeId: tab.id,
      sigs: sig ? { ...s.sigs, [tab.id]: sig } : s.sigs,
    }));
    useRecents.getState().push(workspaceId, path, basename(path));
  },

  openPath: async (path) => {
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
    await get().openFile(belong.id, path);
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
    try {
      const newSig = await api.save(
        tab.path,
        tab.content,
        sig?.mtime,
        force,
      );
      const ws = useWorkspace
        .getState()
        .workspaces.find((w) => w.id === tab.workspaceId);
      if (ws) {
        api
          .historySave(ws.path, tab.path, tab.content)
          .catch(() => undefined);
      }
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === id ? { ...t, baseline: t.content, dirty: false } : t,
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

  reorderTabs: (fromIdx, toIdx) =>
    set((s) => {
      const tabs = [...s.tabs];
      if (
        fromIdx < 0 ||
        fromIdx >= tabs.length ||
        toIdx < 0 ||
        toIdx >= tabs.length
      ) {
        return s;
      }
      const [it] = tabs.splice(fromIdx, 1);
      tabs.splice(toIdx, 0, it);
      return { tabs };
    }),

  activeTab: () => {
    const id = get().activeId;
    return id ? get().tabs.find((t) => t.id === id) : undefined;
  },
}));
