import { create } from "zustand";

export type SyncStatus = "idle" | "syncing" | "error";

interface SyncState {
  status: SyncStatus;
  lastSyncAt: number | null;
  lastError: string | null;
  /** workspace path → 是否正在跑（防并发） */
  inflight: Record<string, boolean>;
  setStatus: (status: SyncStatus, error?: string | null) => void;
  setLastSync: (ts: number) => void;
  setInflight: (workspace: string, value: boolean) => void;
  isInflight: (workspace: string) => boolean;
}

export const useSync = create<SyncState>((set, get) => ({
  status: "idle",
  lastSyncAt: null,
  lastError: null,
  inflight: {},
  setStatus: (status, error) =>
    set({ status, lastError: error === undefined ? null : error }),
  setLastSync: (ts) => set({ lastSyncAt: ts }),
  setInflight: (workspace, value) =>
    set((s) => ({ inflight: { ...s.inflight, [workspace]: value } })),
  isInflight: (workspace) => !!get().inflight[workspace],
}));
