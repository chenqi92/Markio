import { create } from "zustand";
import { api, type RagEmbedConfig, type RagHit, type RagStatus } from "@/lib/api";
import { useSettings } from "./settings";
import { reportDiagnostic } from "./diagnostics";

interface RagState {
  /** workspace.id → status 缓存 */
  status: Record<string, RagStatus>;
  refresh: (workspaceId: string, workspacePath: string) => Promise<void>;
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

  refresh: async (workspaceId, workspacePath) => {
    try {
      const r = await api.ragStatus(workspacePath);
      set((st) => ({ status: { ...st.status, [workspaceId]: r } }));
    } catch (e) {
      console.warn("[rag.status] failed", e);
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
      reportDiagnostic({
        source: "rag",
        severity: "warning",
        message: "RAG 单文件索引失败",
        detail: e,
        workspace: workspacePath,
      });
    }
  },

  removeFile: async (workspacePath, file) => {
    try {
      await api.ragRemoveFile(workspacePath, file);
    } catch (e) {
      console.warn("[rag.remove_file] failed", e);
      reportDiagnostic({
        source: "rag",
        severity: "warning",
        message: "RAG 删除索引失败",
        detail: e,
        workspace: workspacePath,
      });
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
    const rerank =
      s.rerankEnabled && s.rerankModel
        ? {
            provider: "cohere" as const,
            model: s.rerankModel,
            baseUrl: s.rerankBaseUrl || undefined,
          }
        : undefined;
    return api.ragSearch({
      workspace: workspacePath,
      query,
      limit: s.ragTopK,
      expandLinks: s.ragExpandLinks,
      config: cfg,
      rerank,
    });
  },
}));
