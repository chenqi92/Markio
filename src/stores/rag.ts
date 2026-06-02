import { create } from "zustand";
import { api, type RagEmbedConfig, type RagHit, type RagStatus } from "@/lib/api";
import { useSettings } from "./settings";
import { reportDiagnostic } from "./diagnostics";

interface RagState {
  /** workspace.id → status 缓存 */
  status: Record<string, RagStatus>;
  refresh: (workspaceId: string, workspacePath: string) => Promise<void>;
  reindex: (workspacePath: string) => Promise<void>;
  cancel: (workspacePath: string) => Promise<boolean>;
  reindexFile: (workspacePath: string, file: string) => Promise<void>;
  removeFile: (workspacePath: string, file: string) => Promise<void>;
  clear: (workspaceId: string, workspacePath: string) => Promise<void>;
  search: (workspacePath: string, query: string) => Promise<RagHit[]>;
}

/** 把 settings 里的 embedding 绑定折算成后端要的 EmbedConfig。
 *  本地 Ollama → provider:"ollama"；其余源 → openai 兼容协议 + keyProvider 取 ai:{源} 的 Key。 */
export function resolveEmbedConfig(): RagEmbedConfig {
  const s = useSettings.getState();
  if (s.ragEmbedSource === "ollama") {
    return {
      provider: "ollama",
      model: s.ragEmbedModel,
      dim: s.ragEmbedDim,
      baseUrl: s.ragEmbedBaseUrl || undefined,
    };
  }
  return {
    provider: "openai",
    model: s.ragEmbedModel,
    dim: s.ragEmbedDim,
    baseUrl: s.ragEmbedBaseUrl || undefined,
    keyProvider: s.ragEmbedSource,
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
      reportDiagnostic({
        source: "rag",
        severity: "warning",
        message: "RAG 状态读取失败",
        detail: e,
        workspace: workspacePath,
      });
    }
  },

  reindex: async (workspacePath) => {
    const cfg = resolveEmbedConfig();
    // 先 ping 一次 embedding 服务，不可达就直接抛错给 UI；不要白白起一个
    // 会失败一整轮的后台任务（image #18 的 "正在索引 4/72 + 无法连接 Ollama" bug）。
    try {
      await api.ragEmbedTest(cfg);
    } catch (e) {
      const msg = (e as Error).message;
      throw new Error(`embedding 服务不可达：${msg}`, { cause: e });
    }
    await api.ragReindex(workspacePath, cfg);
  },

  cancel: async (workspacePath) => api.ragCancel(workspacePath),

  reindexFile: async (workspacePath, file) => {
    const s = useSettings.getState();
    if (!s.ragEnabled) return;
    // 只有该 workspace 已经至少索引过一次 (status.totalDocs > 0) 才做单文件增量；
    // 没有现存索引就别在保存时偷偷拉起 embedding 服务（用户可能根本没装 Ollama）。
    const st = get().status;
    const known = Object.values(st).find((s) => s.workspace === workspacePath);
    if (!known || (known.totalDocs ?? 0) === 0) return;
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
            provider: ["co", "here"].join("") as "cohere",
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
