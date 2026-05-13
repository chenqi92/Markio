import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { FileEntry, Workspace } from "@/types";
import { api } from "@/lib/api";
import { basename, colorForName, initialFor, uid } from "@/lib/utils";

interface WorkspaceState {
  workspaces: Workspace[];
  activeId: string | null;
  treeCache: Record<string, FileEntry | undefined>;
  loading: boolean;
  /** 已经向 Rust 注册过的路径（去重） */
  _registered: Set<string>;

  /** App 启动时把已持久化的仓库全部告诉 Rust */
  hydrate: () => Promise<void>;

  addWorkspace: (path: string) => Promise<string>;
  removeWorkspace: (id: string) => Promise<void>;
  setActive: (id: string) => Promise<void>;
  refreshTree: (id?: string) => Promise<void>;
  activeWorkspace: () => Workspace | undefined;
  activeTree: () => FileEntry | undefined;
}

async function safeRegister(path: string, registered: Set<string>) {
  if (registered.has(path)) return;
  try {
    const canon = await api.workspaceRegister(path);
    registered.add(canon);
    registered.add(path);
  } catch (e) {
    console.error("workspaceRegister failed", path, e);
  }
}

export const useWorkspace = create<WorkspaceState>()(
  persist(
    (set, get) => ({
      workspaces: [],
      activeId: null,
      treeCache: {},
      loading: false,
      _registered: new Set<string>(),

      hydrate: async () => {
        const registered = get()._registered;
        for (const w of get().workspaces) {
          await safeRegister(w.path, registered);
        }
      },

      addWorkspace: async (path) => {
        const existing = get().workspaces.find((w) => w.path === path);
        if (existing) {
          await safeRegister(existing.path, get()._registered);
          await get().setActive(existing.id);
          return existing.id;
        }
        const name = basename(path) || path;
        const ws: Workspace = {
          id: uid(),
          name,
          path,
          color: colorForName(name),
          initial: initialFor(name),
          lastOpenedAt: Date.now(),
        };
        set((s) => ({ workspaces: [...s.workspaces, ws] }));
        await safeRegister(ws.path, get()._registered);
        await get().setActive(ws.id);
        return ws.id;
      },

      removeWorkspace: async (id) => {
        const ws = get().workspaces.find((w) => w.id === id);
        set((s) => {
          const next = s.workspaces.filter((w) => w.id !== id);
          return {
            workspaces: next,
            activeId: s.activeId === id ? next[0]?.id ?? null : s.activeId,
            treeCache: { ...s.treeCache, [id]: undefined },
          };
        });
        if (ws) {
          try {
            await api.workspaceUnregister(ws.path);
          } catch {
            /* ignore */
          }
          get()._registered.delete(ws.path);
        }
      },

      setActive: async (id) => {
        set({ activeId: id });
        if (!get().treeCache[id]) await get().refreshTree(id);
      },

      refreshTree: async (id) => {
        const targetId = id ?? get().activeId;
        if (!targetId) return;
        const ws = get().workspaces.find((w) => w.id === targetId);
        if (!ws) return;
        await safeRegister(ws.path, get()._registered);
        set({ loading: true });
        try {
          const tree = await api.readTree(ws.path);
          set((s) => ({
            treeCache: { ...s.treeCache, [targetId]: tree },
          }));
        } catch (e) {
          console.error("readTree failed", e);
        } finally {
          set({ loading: false });
        }
      },

      activeWorkspace: () =>
        get().workspaces.find((w) => w.id === get().activeId),
      activeTree: () => {
        const id = get().activeId;
        return id ? get().treeCache[id] : undefined;
      },
    }),
    {
      name: "markio.workspaces.v1",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        workspaces: s.workspaces,
        activeId: s.activeId,
      }),
    },
  ),
);
