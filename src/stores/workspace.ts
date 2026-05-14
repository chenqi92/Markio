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

  /** App 启动时只把当前仓库告诉 Rust，避免为历史仓库启动递归 watcher */
  hydrate: () => Promise<void>;

  addWorkspace: (path: string) => Promise<string>;
  removeWorkspace: (id: string) => Promise<void>;
  setActive: (id: string) => Promise<void>;
  refreshTree: (id?: string) => Promise<void>;
  loadDir: (id: string, path: string) => Promise<void>;
  activeWorkspace: () => Workspace | undefined;
  activeTree: () => FileEntry | undefined;
}

function pathKey(path: string): string {
  const norm = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-zA-Z]:\//.test(norm) ? norm.toLowerCase() : norm;
}

function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

function mergeLoadedChildren(next: FileEntry, previous?: FileEntry): FileEntry {
  if (
    !next.isDir ||
    !previous?.isDir ||
    !next.children ||
    !previous.children
  ) {
    return next;
  }

  const previousByPath = new Map(
    previous.children.map((child) => [pathKey(child.path), child]),
  );
  let changed = false;
  const children = next.children.map((child) => {
    const oldChild = previousByPath.get(pathKey(child.path));
    if (
      child.isDir &&
      oldChild?.isDir &&
      child.children === undefined &&
      oldChild.children !== undefined
    ) {
      changed = true;
      return {
        ...child,
        children: oldChild.children,
        truncated: Boolean(child.truncated || oldChild.truncated),
      };
    }
    return child;
  });

  return changed ? { ...next, children } : next;
}

function replaceTreeNode(root: FileEntry, updated: FileEntry): FileEntry {
  if (samePath(root.path, updated.path)) {
    return mergeLoadedChildren(updated, root);
  }
  if (!root.children) return root;

  let changed = false;
  const children = root.children.map((child) => {
    const next = replaceTreeNode(child, updated);
    if (next !== child) changed = true;
    return next;
  });

  return changed ? { ...root, children } : root;
}

function rememberRegistered(registered: Set<string>, path: string, canon: string) {
  registered.add(path);
  registered.add(canon);
}

function isRegistered(registered: Set<string>, path: string): boolean {
  for (const p of registered) {
    if (samePath(p, path)) return true;
  }
  return false;
}

const treeRefreshInFlight = new Set<string>();
const treeRefreshQueued = new Set<string>();
const dirLoadInFlight = new Set<string>();

async function registerWorkspace(path: string, registered: Set<string>) {
  const canon = await api.workspaceRegister(path);
  rememberRegistered(registered, path, canon);
  return canon;
}

async function safeRegister(path: string, registered: Set<string>) {
  if (isRegistered(registered, path)) return path;
  try {
    return await registerWorkspace(path, registered);
  } catch (e) {
    console.error("workspaceRegister failed", path, e);
    return null;
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
        const activeId = get().activeId;
        const active = get().workspaces.find((w) => w.id === activeId);
        if (active) await safeRegister(active.path, registered);
      },

      addWorkspace: async (path) => {
        const canon = await registerWorkspace(path, get()._registered);
        const existing = get().workspaces.find(
          (w) => samePath(w.path, path) || samePath(w.path, canon),
        );
        if (existing) {
          await get().setActive(existing.id);
          return existing.id;
        }
        const name = basename(canon) || canon;
        const ws: Workspace = {
          id: uid(),
          name,
          path: canon,
          color: colorForName(name),
          initial: initialFor(name),
          lastOpenedAt: Date.now(),
        };
        set((s) => ({ workspaces: [...s.workspaces, ws] }));
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
            const canon = await api.workspaceUnregister(ws.path);
            get()._registered.delete(canon);
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
        if (treeRefreshInFlight.has(targetId)) {
          treeRefreshQueued.add(targetId);
          return;
        }
        treeRefreshInFlight.add(targetId);
        try {
          while (true) {
            treeRefreshQueued.delete(targetId);
            const ws = get().workspaces.find((w) => w.id === targetId);
            if (!ws) return;
            await safeRegister(ws.path, get()._registered);
            set({ loading: true });
            try {
              const previous = get().treeCache[targetId];
              const tree = mergeLoadedChildren(await api.readDir(ws.path), previous);
              set((s) => ({
                treeCache: { ...s.treeCache, [targetId]: tree },
              }));
            } catch (e) {
              console.error("readDir failed", e);
            } finally {
              set({ loading: false });
            }
            if (!treeRefreshQueued.has(targetId)) break;
          }
        } finally {
          treeRefreshInFlight.delete(targetId);
        }
      },

      loadDir: async (id, path) => {
        const ws = get().workspaces.find((w) => w.id === id);
        if (!ws) return;
        const key = `${id}:${pathKey(path)}`;
        if (dirLoadInFlight.has(key)) return;
        dirLoadInFlight.add(key);
        try {
          await safeRegister(ws.path, get()._registered);
          const dir = await api.readDir(path);
          set((s) => {
            const current = s.treeCache[id];
            if (!current) {
              return samePath(dir.path, ws.path)
                ? { treeCache: { ...s.treeCache, [id]: dir } }
                : {};
            }
            const next = replaceTreeNode(current, dir);
            if (next === current) return {};
            return { treeCache: { ...s.treeCache, [id]: next } };
          });
        } catch (e) {
          console.error("loadDir failed", path, e);
        } finally {
          dirLoadInFlight.delete(key);
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
