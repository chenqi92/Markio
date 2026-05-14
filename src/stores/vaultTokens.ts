import { create } from "zustand";
import { api, isDesktop } from "@/lib/api";

interface Tokens {
  tags: string[];
  mentions: string[];
  files: string[];
}

interface VaultTokenState {
  /** workspace path → tokens */
  cache: Record<string, Tokens>;
  /** workspace path → 上次刷新时间戳 */
  loadedAt: Record<string, number>;
  /** 当前正在刷新的 workspace path 集合 */
  loading: Set<string>;
  /** 拉取（节流：5 分钟内只刷一次） */
  ensure: (workspace: string, force?: boolean) => Promise<void>;
  /** 取当前缓存（不触发拉取） */
  get: (workspace: string) => Tokens;
}

const TTL_MS = 5 * 60 * 1000;
const EMPTY: Tokens = { tags: [], mentions: [], files: [] };

export const useVaultTokens = create<VaultTokenState>((set, get) => ({
  cache: {},
  loadedAt: {},
  loading: new Set(),
  get: (workspace) => get().cache[workspace] ?? EMPTY,
  ensure: async (workspace, force = false) => {
    if (!isDesktop() || !workspace) return;
    const state = get();
    const last = state.loadedAt[workspace] ?? 0;
    if (!force && Date.now() - last < TTL_MS) return;
    if (state.loading.has(workspace)) return;
    const nextLoading = new Set(state.loading);
    nextLoading.add(workspace);
    set({ loading: nextLoading });
    try {
      const tokens = await api.indexTokens(workspace);
      set((s) => ({
        cache: { ...s.cache, [workspace]: tokens },
        loadedAt: { ...s.loadedAt, [workspace]: Date.now() },
      }));
    } catch {
      /* keep previous cache */
    } finally {
      set((s) => {
        const updated = new Set(s.loading);
        updated.delete(workspace);
        return { loading: updated };
      });
    }
  },
}));
