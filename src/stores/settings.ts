import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { applyTheme } from "@/themes";
import type { ViewMode } from "@/types";
import type { CommandId } from "@/lib/shortcuts";
import { tauriStorage } from "@/lib/tauriStorage";

export function generateChannelId(): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 10);
  return `mk-${t}-${r}`;
}

type PreferenceKey =
  | "startupBehavior"
  | "closeLastTabBehavior"
  | "autosaveDelayMs"
  | "syncConflictStrategy"
  | "syncFrequency"
  | "picgoEndpoint"
  | "smartQuotes"
  | "autoListContinuation"
  | "autoSpaceCJK"
  | "snapshotOnSave"
  | "showInTray"
  | "picgoPasteUpload"
  | "picgoDragUpload"
  | "picgoKeepLocalCopy"
  | "picgoCompressBeforeUpload"
  | "picgoQuality"
  | "wechatStyle"
  | "wechatAuthor"
  | "wechatAccountName"
  | "wechatAppId"
  | "wechatAutoSummary"
  | "wechatDefaultCover"
  | "wxAssistantEnabled"
  | "wxAssistantWebhook"
  | "wxAssistantDailyDigest"
  | "wxAssistantDigestTime"
  | "wxAssistantPublishHook"
  | "smartChannelEnabled"
  | "smartChannelId"
  | "smartChannelModelSource"
  | "smartChannelScope"
  | "smartChannelDailyLimit"
  | "smartChannelMaxChunks"
  | "smartChannelIncludeAttachments"
  | "smartChannelResponseStyle"
  | "exportPdfTheme"
  | "exportPdfMargin"
  | "htmlExportInlineImages"
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
  /** 输入 " ' 时自动转曲引号 “ ” ‘ ’ */
  smartQuotes: boolean;
  /** 在 - / 1. 行按 Enter 时自动续标记 */
  autoListContinuation: boolean;
  /** 保存前在 CJK 与 ASCII 之间补一个空格 */
  autoSpaceCJK: boolean;
  /** 每次保存写一份历史快照（可在大纲右侧时间轴查看） */
  snapshotOnSave: boolean;
  /** 在系统菜单栏 / 任务栏托盘显示 markio 图标 */
  showInTray: boolean;
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
  /** 已绑定的公众号显示名（appSecret 在系统钥匙串） */
  wechatAccountName: string;
  /** 已绑定的公众号 AppID */
  wechatAppId: string;
  /** 推送时让 AI 自动生成摘要 */
  wechatAutoSummary: boolean;
  /** 默认封面图：none = 不附带 / firstImage = 取正文首图 */
  wechatDefaultCover: "none" | "firstImage";
  /** 微信助手开关：开启后保存 / 发布动作会推到下方 webhook */
  wxAssistantEnabled: boolean;
  /** Server 酱 / 企业微信机器人 / 自建桥的 webhook */
  wxAssistantWebhook: string;
  /** 每日笔记摘要推送 */
  wxAssistantDailyDigest: boolean;
  /** 摘要推送时间，24h 格式 "HH:mm" */
  wxAssistantDigestTime: string;
  /** 发布公众号草稿后是否再推一条通知 */
  wxAssistantPublishHook: boolean;
  /** 智能通道（替代龙虾）：把当前文档工具的内容暴露给其他客户端查询 */
  smartChannelEnabled: boolean;
  /** 通道唯一 id，给外部 app（命令面板 / Raycast / 微信助手）调用时用 */
  smartChannelId: string;
  /** 智能通道走哪个模型，沿用 AI 设置里的 provider/model 还是单独指定 */
  smartChannelModelSource: "aiDefault" | "currentClaude" | "currentOpenAI" | "localOllama";
  /** 检索范围：仅当前文件 / 当前仓库 / 全部仓库 */
  smartChannelScope: "currentFile" | "currentWorkspace" | "allWorkspaces";
  /** 每日最多被外部触发的次数（防滥用） */
  smartChannelDailyLimit: 50 | 100 | 200 | 500 | 1000;
  /** 一次回答带回的相关片段上限 */
  smartChannelMaxChunks: 3 | 5 | 8 | 12;
  /** 是否把附件（图片 / 表格 OCR）一起带回 */
  smartChannelIncludeAttachments: boolean;
  /** 回答风格 */
  smartChannelResponseStyle: "concise" | "balanced" | "detailed";
  exportPdfTheme: "current" | "light" | "dark" | "print";
  exportPdfMargin: "standard" | "narrow" | "wide";
  /** 导出 HTML 时是否把远端图片内嵌为 data URL（离线可看） */
  htmlExportInlineImages: boolean;
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
  /** 全局快捷键的用户覆盖：commandId → binding 字符串。空串表示用户显式取消绑定。 */
  shortcutOverrides: Partial<Record<CommandId, string>>;
  setShortcut: (id: CommandId, binding: string) => void;
  resetShortcut: (id: CommandId) => void;
  resetAllShortcuts: () => void;
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
      smartQuotes: true,
      autoListContinuation: true,
      autoSpaceCJK: false,
      snapshotOnSave: true,
      showInTray: true,
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
      wechatAccountName: "",
      wechatAppId: "",
      wechatAutoSummary: true,
      wechatDefaultCover: "firstImage",
      wxAssistantEnabled: false,
      wxAssistantWebhook: "",
      wxAssistantDailyDigest: false,
      wxAssistantDigestTime: "09:00",
      wxAssistantPublishHook: true,
      smartChannelEnabled: false,
      smartChannelId: generateChannelId(),
      smartChannelModelSource: "aiDefault",
      smartChannelScope: "currentWorkspace",
      smartChannelDailyLimit: 200,
      smartChannelMaxChunks: 5,
      smartChannelIncludeAttachments: false,
      smartChannelResponseStyle: "balanced",
      exportPdfTheme: "current",
      exportPdfMargin: "standard",
      htmlExportInlineImages: true,
      aiProvider: "anthropic",
      aiKeyConfigured: false,
      aiEndpoint: "",
      aiModel: "claude-haiku-4-5",
      aiTemperature: 0.7,
      aiMaxTokens: 4096,
      aiUseCurrentFile: true,
      aiUseWorkspace: false,
      ragEnabled: false,
      ragAutoReindexOnSave: false,
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
      shortcutOverrides: {},
      setShortcut: (id, binding) =>
        set((s) => ({
          shortcutOverrides: { ...s.shortcutOverrides, [id]: binding },
        })),
      resetShortcut: (id) =>
        set((s) => {
          const next = { ...s.shortcutOverrides };
          delete next[id];
          return { shortcutOverrides: next };
        }),
      resetAllShortcuts: () => set({ shortcutOverrides: {} }),
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
      storage: createJSONStorage(() => tauriStorage),
      skipHydration: true,
      onRehydrateStorage: () => (state) => {
        if (state) applyTheme(state.theme);
      },
    },
  ),
);
