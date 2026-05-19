import { create } from "zustand";

export type SyncStatus = "idle" | "syncing" | "error";
export type SyncStage =
  | "idle"
  | "preflight"
  | "snapshot"
  | "fetch"
  | "pull"
  | "push"
  | "done"
  | "conflict"
  | "error";

interface SyncState {
  status: SyncStatus;
  stage: SyncStage;
  lastSyncAt: number | null;
  lastError: string | null;
  lastSummary: string | null;
  conflictFiles: string[];
  /** workspace path → 是否正在跑（防并发） */
  inflight: Record<string, boolean>;
  setStatus: (status: SyncStatus, error?: string | null) => void;
  setStage: (stage: SyncStage, summary?: string | null) => void;
  setConflict: (files: string[], error: string) => void;
  setLastSync: (ts: number) => void;
  setInflight: (workspace: string, value: boolean) => void;
  isInflight: (workspace: string) => boolean;
}

export const useSync = create<SyncState>((set, get) => ({
  status: "idle",
  stage: "idle",
  lastSyncAt: null,
  lastError: null,
  lastSummary: null,
  conflictFiles: [],
  inflight: {},
  setStatus: (status, error) =>
    set({
      status,
      stage:
        status === "syncing"
          ? get().stage
          : status === "error"
            ? get().stage === "conflict"
              ? "conflict"
              : "error"
            : "idle",
      lastError: error === undefined ? null : error,
      conflictFiles: status === "error" ? get().conflictFiles : [],
    }),
  setStage: (stage, summary) =>
    set({
      stage,
      status:
        stage === "idle" || stage === "done"
          ? "idle"
          : stage === "conflict" || stage === "error"
            ? "error"
            : "syncing",
      lastSummary: summary === undefined ? get().lastSummary : summary,
      lastError:
        stage === "conflict" || stage === "error" ? get().lastError : null,
      conflictFiles: stage === "conflict" ? get().conflictFiles : [],
    }),
  setConflict: (files, error) =>
    set({
      status: "error",
      stage: "conflict",
      lastError: error,
      lastSummary: `同步冲突：${files.length} 个文件`,
      conflictFiles: files,
    }),
  setLastSync: (ts) => set({ lastSyncAt: ts }),
  setInflight: (workspace, value) =>
    set((s) => ({ inflight: { ...s.inflight, [workspace]: value } })),
  isInflight: (workspace) => !!get().inflight[workspace],
}));
