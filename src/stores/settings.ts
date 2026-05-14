import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { applyTheme } from "@/themes";
import type { ViewMode } from "@/types";

type PreferenceKey =
  | "startupBehavior"
  | "closeLastTabBehavior"
  | "autosaveDelayMs"
  | "syncConflictStrategy"
  | "syncFrequency"
  | "picgoEndpoint"
  | "picgoPasteUpload"
  | "picgoDragUpload"
  | "picgoKeepLocalCopy"
  | "picgoCompressBeforeUpload"
  | "picgoQuality"
  | "wechatStyle"
  | "wechatAuthor"
  | "lobsterModelSource"
  | "lobsterDailyLimit"
  | "exportPdfTheme"
  | "exportPdfMargin"
  | "ragEnabled"
  | "ragAutoReindexOnSave"
  | "ragProvider"
  | "ragOllamaBaseUrl"
  | "ragOllamaModel"
  | "ragOllamaDim"
  | "ragOpenaiBaseUrl"
  | "ragOpenaiModel"
  | "ragOpenaiDim"
  | "ragTopK"
  | "ragExpandLinks"
  | "rerankEnabled"
  | "rerankModel"
  | "rerankBaseUrl"
  | "rerankApiKey"
  | "webdavBaseUrl"
  | "webdavUsername"
  | "webdavRemoteDir"
  | "s3Endpoint"
  | "s3Region"
  | "s3Bucket"
  | "s3AccessKeyId"
  | "s3PublicBaseUrl"
  | "s3PathStyle"
  | "uploadProvider"
  | "autoSyncEnabled"
  | "customThemeId";

interface SettingsState {
  theme: string;
  fontSize: number;
  defaultMode: ViewMode;
  startupBehavior: "restoreTabs" | "welcome" | "lastWorkspace";
  closeLastTabBehavior: "keepWindow" | "showWelcome" | "quitApp";
  shortcutStyle: "all" | "bubble" | "slash" | "toolbar";
  followSystemTheme: boolean;
  darkVariant: string;
  lightVariant: string;
  autosave: boolean;
  autosaveDelayMs: 500 | 800 | 1500 | 3000;
  syncConflictStrategy: "ask" | "newest" | "local" | "remote";
  syncFrequency: "manual" | "30s" | "1m" | "5m";
  picgoEndpoint: string;
  picgoPasteUpload: boolean;
  picgoDragUpload: boolean;
  picgoKeepLocalCopy: boolean;
  picgoCompressBeforeUpload: boolean;
  picgoQuality: number;
  wechatStyle: "warmMagazine" | "cleanTech" | "inkClassic" | "minimal";
  wechatAuthor: "unset" | "appName" | "systemUser";
  lobsterModelSource: "aiDefault" | "currentClaude" | "currentOpenAI" | "localOllama";
  lobsterDailyLimit: 50 | 100 | 200 | 500 | 1000;
  exportPdfTheme: "current" | "light" | "dark" | "print";
  exportPdfMargin: "standard" | "narrow" | "wide";
  aiProvider: "anthropic" | "openai" | "deepseek" | "ollama" | "google" | "custom";
  /** 是否已配置 API Key（真实值在 OS 钥匙串里，不进 localStorage） */
  aiKeyConfigured: boolean;
  aiEndpoint: string;
  aiModel: string;
  aiTemperature: number;
  aiMaxTokens: number;
  /** AI 回答时是否把当前 .md 文件内容塞进 system prompt */
  aiUseCurrentFile: boolean;
  /** AI 回答时是否在仓库做关键词检索并把片段塞进 system prompt */
  aiUseWorkspace: boolean;
  /** 知识库（RAG）总开关 */
  ragEnabled: boolean;
  /** 保存后是否自动增量更新当前文件的索引 */
  ragAutoReindexOnSave: boolean;
  /** embedding 提供方 */
  ragProvider: "ollama" | "openai";
  ragOllamaBaseUrl: string;
  ragOllamaModel: string;
  ragOllamaDim: number;
  ragOpenaiBaseUrl: string;
  ragOpenaiModel: string;
  ragOpenaiDim: number;
  /** 检索时返回 top-K 条 chunk */
  ragTopK: number;
  /** 是否启用引用图谱扩展（命中文档的 forward link 也带回） */
  ragExpandLinks: boolean;
  /** RAG 检索后是否再走一次 cohere 兼容 reranker */
  rerankEnabled: boolean;
  rerankModel: string;
  rerankBaseUrl: string;
  rerankApiKey: string;
  // WebDAV 同步
  webdavBaseUrl: string;
  webdavUsername: string;
  webdavRemoteDir: string;
  // S3 兼容图片上传
  s3Endpoint: string;
  s3Region: string;
  s3Bucket: string;
  s3AccessKeyId: string;
  s3PublicBaseUrl: string;
  s3PathStyle: boolean;
  /** 粘贴 / 拖拽图片上传走哪条管线 */
  uploadProvider: "picgo" | "s3" | "none";
  /** 启用按 syncFrequency 自动 commit + push */
  autoSyncEnabled: boolean;
  /** 已应用的自定义 CSS 主题 id（null 表示未应用） */
  customThemeId: string | null;
  setTheme: (theme: string) => void;
  setFontSize: (n: number) => void;
  setDefaultMode: (m: ViewMode) => void;
  setShortcutStyle: (s: SettingsState["shortcutStyle"]) => void;
  setFollowSystemTheme: (v: boolean) => void;
  setVariant: (kind: "dark" | "light", id: string) => void;
  setAutosave: (v: boolean) => void;
  setPreference: <K extends PreferenceKey>(key: K, value: SettingsState[K]) => void;
  setAi: (
    p: Partial<{
      aiProvider: SettingsState["aiProvider"];
      aiKeyConfigured: boolean;
      aiEndpoint: string;
      aiModel: string;
      aiTemperature: number;
      aiMaxTokens: number;
      aiUseCurrentFile: boolean;
      aiUseWorkspace: boolean;
    }>,
  ) => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      theme: "light",
      fontSize: 16,
      defaultMode: "split",
      startupBehavior: "restoreTabs",
      closeLastTabBehavior: "keepWindow",
      shortcutStyle: "all",
      followSystemTheme: false,
      darkVariant: "dark",
      lightVariant: "light",
      autosave: true,
      autosaveDelayMs: 800,
      syncConflictStrategy: "ask",
      syncFrequency: "30s",
      picgoEndpoint: "http://127.0.0.1:36677",
      picgoPasteUpload: true,
      picgoDragUpload: true,
      picgoKeepLocalCopy: true,
      picgoCompressBeforeUpload: true,
      picgoQuality: 85,
      wechatStyle: "warmMagazine",
      wechatAuthor: "unset",
      lobsterModelSource: "aiDefault",
      lobsterDailyLimit: 200,
      exportPdfTheme: "current",
      exportPdfMargin: "standard",
      aiProvider: "anthropic",
      aiKeyConfigured: false,
      aiEndpoint: "",
      aiModel: "claude-haiku-4-5",
      aiTemperature: 0.7,
      aiMaxTokens: 4096,
      aiUseCurrentFile: true,
      aiUseWorkspace: false,
      ragEnabled: true,
      ragAutoReindexOnSave: true,
      ragProvider: "ollama",
      ragOllamaBaseUrl: "http://127.0.0.1:11434",
      ragOllamaModel: "nomic-embed-text",
      ragOllamaDim: 768,
      ragOpenaiBaseUrl: "https://api.openai.com",
      ragOpenaiModel: "text-embedding-3-small",
      ragOpenaiDim: 1536,
      ragTopK: 6,
      ragExpandLinks: true,
      rerankEnabled: false,
      rerankModel: "rerank-multilingual-v3.0",
      rerankBaseUrl: "",
      rerankApiKey: "",
      webdavBaseUrl: "",
      webdavUsername: "",
      webdavRemoteDir: "markio",
      s3Endpoint: "",
      s3Region: "us-east-1",
      s3Bucket: "",
      s3AccessKeyId: "",
      s3PublicBaseUrl: "",
      s3PathStyle: false,
      uploadProvider: "picgo",
      autoSyncEnabled: false,
      customThemeId: null,
      setTheme: (theme) => {
        applyTheme(theme);
        set({ theme });
      },
      setFontSize: (fontSize) => set({ fontSize }),
      setDefaultMode: (defaultMode) => set({ defaultMode }),
      setShortcutStyle: (shortcutStyle) => set({ shortcutStyle }),
      setFollowSystemTheme: (followSystemTheme) => set({ followSystemTheme }),
      setVariant: (kind, id) =>
        set(kind === "dark" ? { darkVariant: id } : { lightVariant: id }),
      setAutosave: (autosave) => set({ autosave }),
      setPreference: (key, value) => set({ [key]: value } as Partial<SettingsState>),
      setAi: (p) => set(p),
    }),
    {
      name: "markio.settings.v1",
      storage: createJSONStorage(() => localStorage),
      onRehydrateStorage: () => (state) => {
        if (state) applyTheme(state.theme);
      },
    },
  ),
);
