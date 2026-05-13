import { create } from "zustand";
import { api, type RagEmbedConfig, type RagHit, type RagStatus } from "@/lib/api";
import { useSettings } from "./settings";

interface RagState {
  /** workspace.id → status 缓存 */
  status: Record<string, RagStatus>;
  pollingTimer: number | null;
  refresh: (workspaceId: string, workspacePath: string) => Promise<void>;
  startPolling: (workspaceId: string, workspacePath: string) => void;
  stopPolling: () => void;
  reindex: (workspacePath: string) => Promise<void>;
  reindexFile: (workspacePath: string, file: string) => Promise<void>;
  removeFile: (workspacePath: string, file: string) => Promise<void>;
  clear: (workspaceId: string, workspacePath: string) => Promise<void>;
  search: (workspacePath: string, query: string) => Promise<RagHit[]>;
}

/** 把 settings 里的 RAG 偏好折算成后端要的 EmbedConfig */
export function resolveEmbedConfig(): RagEmbedConfig {
  const s = useSettings.getState();
  if (s.ragProvider === "openai") {
    return {
      provider: "openai",
      model: s.ragOpenaiModel,
      dim: s.ragOpenaiDim,
      baseUrl: s.ragOpenaiBaseUrl || undefined,
    };
  }
  return {
    provider: "ollama",
    model: s.ragOllamaModel,
    dim: s.ragOllamaDim,
    baseUrl: s.ragOllamaBaseUrl || undefined,
  };
}

export const useRag = create<RagState>((set, get) => ({
  status: {},
  pollingTimer: null,

  refresh: async (workspaceId, workspacePath) => {
    try {
      const r = await api.ragStatus(workspacePath);
      set((st) => ({ status: { ...st.status, [workspaceId]: r } }));
    } catch (e) {
      console.warn("[rag.status] failed", e);
    }
  },

  startPolling: (workspaceId, workspacePath) => {
    const cur = get().pollingTimer;
    if (cur) window.clearInterval(cur);
    void get().refresh(workspaceId, workspacePath);
    const timer = window.setInterval(() => {
      void get().refresh(workspaceId, workspacePath);
    }, 1500);
    set({ pollingTimer: timer });
  },

  stopPolling: () => {
    const cur = get().pollingTimer;
    if (cur) {
      window.clearInterval(cur);
      set({ pollingTimer: null });
    }
  },

  reindex: async (workspacePath) => {
    const cfg = resolveEmbedConfig();
    await api.ragReindex(workspacePath, cfg);
  },

  reindexFile: async (workspacePath, file) => {
    const s = useSettings.getState();
    if (!s.ragEnabled) return;
    const cfg = resolveEmbedConfig();
    try {
      await api.ragReindexFile(workspacePath, file, cfg);
    } catch (e) {
      console.warn("[rag.reindex_file] failed", e);
    }
  },

  removeFile: async (workspacePath, file) => {
    try {
      await api.ragRemoveFile(workspacePath, file);
    } catch (e) {
      console.warn("[rag.remove_file] failed", e);
    }
  },

  clear: async (workspaceId, workspacePath) => {
    await api.ragClear(workspacePath);
    set((st) => {
      const { [workspaceId]: _, ...rest } = st.status;
      return { status: rest };
    });
  },

  search: async (workspacePath, query) => {
    const s = useSettings.getState();
    const cfg = resolveEmbedConfig();
    return api.ragSearch({
      workspace: workspacePath,
      query,
      limit: s.ragTopK,
      expandLinks: s.ragExpandLinks,
      config: cfg,
    });
  },
}));
