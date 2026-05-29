import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { FileEntry, Workspace } from "@/types";
import { api } from "@/lib/api";
import {
  basename,
  colorForName,
  initialFor,
  pathKey,
  samePath,
  uid,
} from "@/lib/utils";
import { tauriStorage } from "@/lib/tauriStorage";
import { reportDiagnostic } from "./diagnostics";
import { runWorkspaceCleanups } from "./workspaceCleanup";

interface WorkspaceState {
  workspaces: Workspace[];
  activeId: string | null;
  treeCache: Record<string, FileEntry | undefined>;
  loading: boolean;
  /**
   * 当前注册失败的仓库路径（路径键 → true）。
   * 路径不存在 / 权限拒绝时设置；下次再次成功注册时清除。
   * 用于让上层 UI 显示"不可用"占位，并让 fs / vault-index 操作静默跳过。
   */
  unavailable: Record<string, true>;
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
  isUnavailable: (path: string) => boolean;
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
      child.children == null &&
      oldChild.children != null
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

export function removeTreePath(root: FileEntry, removedPath: string): FileEntry {
  if (!root.children || samePath(root.path, removedPath)) return root;

  let changed = false;
  const children: FileEntry[] = [];
  for (const child of root.children) {
    if (samePath(child.path, removedPath)) {
      changed = true;
      continue;
    }
    const next = removeTreePath(child, removedPath);
    if (next !== child) changed = true;
    children.push(next);
  }

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

/** os error 2 / ENOENT — 仓库根路径已被删除或挂载点已离线 */
function isMissingPathError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /os error 2|No such file or directory|找不到|不存在/i.test(msg);
}

type SetState = {
  (
    partial:
      | Partial<WorkspaceState>
      | ((state: WorkspaceState) => Partial<WorkspaceState>),
  ): void;
};

async function safeRegister(
  path: string,
  registered: Set<string>,
  set: SetState,
) {
  if (isRegistered(registered, path)) return path;
  try {
    const canon = await registerWorkspace(path, registered);
    set((s) => {
      if (!s.unavailable[pathKey(path)] && !s.unavailable[pathKey(canon)]) {
        return {};
      }
      const next = { ...s.unavailable };
      delete next[pathKey(path)];
      delete next[pathKey(canon)];
      return { unavailable: next };
    });
    return canon;
  } catch (e) {
    console.warn("workspaceRegister failed", path, e);
    set((s) => {
      const key = pathKey(path);
      if (s.unavailable[key]) return {};
      return { unavailable: { ...s.unavailable, [key]: true } };
    });
    // 路径缺失是常见场景（外接盘未挂载 / 目录被删 / 同步未拉下来），
    // 不再以错误弹窗打扰用户；UI 已经在文件树位置显示"不可用"占位。
    if (!isMissingPathError(e)) {
      reportDiagnostic({
        source: "workspace",
        severity: "error",
        message: "仓库注册失败",
        detail: e,
        workspace: path,
      });
    }
    return null;
  }
}

function pathErrorDetail(path: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `${path}: ${detail}`;
}

export const useWorkspace = create<WorkspaceState>()(
  persist(
    (set, get) => ({
      workspaces: [],
      activeId: null,
      treeCache: {},
      loading: false,
      unavailable: {},
      _registered: new Set<string>(),

      hydrate: async () => {
        const registered = get()._registered;
        const activeId = get().activeId;
        const active = get().workspaces.find((w) => w.id === activeId);
        if (active) await safeRegister(active.path, registered, set);
      },

      addWorkspace: async (path) => {
        const canon = await registerWorkspace(path, get()._registered);
        set((s) => {
          if (!s.unavailable[pathKey(path)] && !s.unavailable[pathKey(canon)]) {
            return {};
          }
          const next = { ...s.unavailable };
          delete next[pathKey(path)];
          delete next[pathKey(canon)];
          return { unavailable: next };
        });
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
          const nextUnavailable = ws ? { ...s.unavailable } : s.unavailable;
          if (ws) delete nextUnavailable[pathKey(ws.path)];
          return {
            workspaces: next,
            activeId: s.activeId === id ? next[0]?.id ?? null : s.activeId,
            treeCache: { ...s.treeCache, [id]: undefined },
            unavailable: nextUnavailable,
          };
        });
        if (ws) {
          // 走 workspaceCleanup registry，由 tabs / App 在自己模块加载时注册
          // 各自的清理函数；这样 workspace.ts 不需要直接 import tabs / App。
          runWorkspaceCleanups(ws.path);
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
        const ws = get().workspaces.find((w) => w.id === id);
        if (ws) {
          // 通知 MCP server 的 "默认 vault"，外部 AI 没指定 workspace 时用它
          void api.mcpSetActiveWorkspace(ws.path).catch(() => {});
        }
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
            const canon = await safeRegister(ws.path, get()._registered, set);
            // 注册失败（路径不存在等）→ 直接返回，避免连锁触发 readDir 报错
            if (!canon) {
              set((s) => ({
                treeCache: { ...s.treeCache, [targetId]: undefined },
              }));
              if (!treeRefreshQueued.has(targetId)) break;
              continue;
            }
            set({ loading: true });
            try {
              const previous = get().treeCache[targetId];
              const tree = mergeLoadedChildren(await api.readDir(ws.path), previous);
              set((s) => ({
                treeCache: { ...s.treeCache, [targetId]: tree },
              }));
            } catch (e) {
              console.error("readDir failed", e);
              if (!isMissingPathError(e)) {
                reportDiagnostic({
                  source: "workspace",
                  severity: "error",
                  message: "文件树刷新失败",
                  detail: e,
                  workspace: ws.path,
                });
              } else {
                set((s) => ({
                  unavailable: { ...s.unavailable, [pathKey(ws.path)]: true },
                  treeCache: { ...s.treeCache, [targetId]: undefined },
                }));
              }
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
          const canon = await safeRegister(ws.path, get()._registered, set);
          if (!canon) return;
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
          if (isMissingPathError(e)) {
            if (samePath(path, ws.path)) {
              set((s) => ({
                unavailable: { ...s.unavailable, [pathKey(ws.path)]: true },
                treeCache: { ...s.treeCache, [id]: undefined },
              }));
            } else {
              set((s) => {
                const current = s.treeCache[id];
                if (!current) return {};
                return {
                  treeCache: {
                    ...s.treeCache,
                    [id]: removeTreePath(current, path),
                  },
                };
              });
            }
          } else {
            reportDiagnostic({
              source: "workspace",
              severity: "warning",
              message: "目录加载失败",
              detail: pathErrorDetail(path, e),
              workspace: ws.path,
            });
          }
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
      isUnavailable: (path) => {
        const state = get();
        const key = pathKey(path);
        if (state.unavailable[key]) return true;
        const ws = state.workspaces.find((w) => samePath(w.path, path));
        return ws ? Boolean(state.unavailable[pathKey(ws.path)]) : false;
      },
    }),
    {
      name: "markio.workspaces.v1",
      storage: createJSONStorage(() => tauriStorage),
      skipHydration: true,
      partialize: (s) => ({
        workspaces: s.workspaces,
        activeId: s.activeId,
      }),
    },
  ),
);
