import { create } from "zustand";
import { api, isDesktop, type VaultIndex } from "@/lib/api";

interface VaultIndexState {
  /** workspace path → 内存中的 index */
  index: Record<string, VaultIndex | undefined>;
  /** workspace path → 上次完整构建结束的时间 */
  builtAt: Record<string, number>;
  /** 正在构建的 workspace 集合 */
  building: Set<string>;
  /** 等待重建的 workspace（在 building 时收到 fs 变化） */
  rebuildQueued: Set<string>;

  /**
   * 拉取 index：
   * 1) 内存或磁盘 cache 先填进来（让 UI 立刻有数据）
   * 2) 后台触发一次 mtime-diff 增量构建
   *
   * `force=true` 会跳过节流，直接重建。
   */
  ensure: (workspace: string, force?: boolean) => Promise<void>;
  /** 文件改 / 增 / 删时调用：debounce 后重建 */
  scheduleRebuild: (workspace: string) => void;
  /** 取当前缓存（不触发拉取） */
  get: (workspace: string) => VaultIndex | undefined;
}

const TTL_MS = 5 * 60 * 1000;
const REBUILD_DEBOUNCE_MS = 4_000;
const rebuildTimers = new Map<string, ReturnType<typeof setTimeout>>();

async function runBuild(workspace: string) {
  const { building, rebuildQueued } = useVaultIndex.getState();
  if (building.has(workspace)) {
    const next = new Set(rebuildQueued);
    next.add(workspace);
    useVaultIndex.setState({ rebuildQueued: next });
    return;
  }
  const startBuilding = new Set(building);
  startBuilding.add(workspace);
  useVaultIndex.setState({ building: startBuilding });
  try {
    const next = await api.vaultIndexBuild(workspace, true);
    useVaultIndex.setState((s) => ({
      index: { ...s.index, [workspace]: next },
      builtAt: { ...s.builtAt, [workspace]: Date.now() },
    }));
  } catch (e) {
    console.warn("[vaultIndex] build failed", workspace, e);
  } finally {
    useVaultIndex.setState((s) => {
      const stillBuilding = new Set(s.building);
      stillBuilding.delete(workspace);
      const queued = new Set(s.rebuildQueued);
      const needs = queued.delete(workspace);
      return needs
        ? { building: stillBuilding, rebuildQueued: queued }
        : { building: stillBuilding };
    });
    if (useVaultIndex.getState().rebuildQueued.has(workspace)) {
      void runBuild(workspace);
    }
  }
}

export const useVaultIndex = create<VaultIndexState>((set, get) => ({
  index: {},
  builtAt: {},
  building: new Set(),
  rebuildQueued: new Set(),

  get: (workspace) => get().index[workspace],

  ensure: async (workspace, force = false) => {
    if (!isDesktop() || !workspace) return;
    const state = get();
    const last = state.builtAt[workspace] ?? 0;
    if (!force && Date.now() - last < TTL_MS && state.index[workspace]) return;

    // 1) 内存里没有 → 立刻拿磁盘 cache 填进来（不阻塞后台重建）
    if (!state.index[workspace]) {
      try {
        const cached = await api.vaultIndexLoad(workspace);
        if (cached) {
          set((s) => ({ index: { ...s.index, [workspace]: cached } }));
        }
      } catch (e) {
        console.warn("[vaultIndex] load failed", workspace, e);
      }
    }

    // 2) 后台重建（mtime diff）
    void runBuild(workspace);
  },

  scheduleRebuild: (workspace) => {
    if (!isDesktop() || !workspace) return;
    const current = rebuildTimers.get(workspace);
    if (current) clearTimeout(current);
    const handle = setTimeout(() => {
      rebuildTimers.delete(workspace);
      void runBuild(workspace);
    }, REBUILD_DEBOUNCE_MS);
    rebuildTimers.set(workspace, handle);
  },
}));
