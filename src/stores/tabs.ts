import { create } from "zustand";
import type { TabInfo } from "@/types";
import { api } from "@/lib/api";
import { basename, dirname, uid } from "@/lib/utils";
import { useWorkspace } from "./workspace";
import { useStreak } from "./streak";
import { useRecents } from "./recents";

interface TabsState {
  tabs: TabInfo[];
  activeId: string | null;

  openFile: (workspaceId: string, path: string) => Promise<void>;
  /** 直接用绝对路径打开 .md，自动归属到已有 workspace；找不到时新建一个临时 workspace（基于父目录） */
  openPath: (path: string) => Promise<void>;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
  updateContent: (id: string, content: string) => void;
  saveTab: (id: string) => Promise<void>;
  saveActive: () => Promise<void>;
  togglePin: (id: string) => void;
  reorderTabs: (fromIdx: number, toIdx: number) => void;
  activeTab: () => TabInfo | undefined;
}

export const useTabs = create<TabsState>((set, get) => ({
  tabs: [],
  activeId: null,

  openFile: async (workspaceId, path) => {
    const exist = get().tabs.find(
      (t) => t.workspaceId === workspaceId && t.path === path,
    );
    if (exist) {
      set({ activeId: exist.id });
      return;
    }
    let content = "";
    try {
      content = await api.readText(path);
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
    set((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id }));
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
      return { tabs: next, activeId };
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

  saveTab: async (id) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab) return;
    try {
      await api.writeText(tab.path, tab.content);
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
      }));
    } catch (e) {
      console.error("saveTab failed", e);
    }
  },

  saveActive: async () => {
    const id = get().activeId;
    if (id) await get().saveTab(id);
  },

  togglePin: (id) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t)),
    })),

  reorderTabs: (fromIdx, toIdx) =>
    set((s) => {
      const tabs = [...s.tabs];
      if (fromIdx < 0 || fromIdx >= tabs.length || toIdx < 0 || toIdx >= tabs.length) {
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
