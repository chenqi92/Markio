import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { applyTheme } from "@/themes";
import type { ViewMode } from "@/types";
import type { CommandId } from "@/lib/shortcuts";
import { tauriStorage } from "@/lib/tauriStorage";
import type { Locale } from "@/i18n";
import { applyFonts } from "@/lib/fonts";

function defaultLocale(): Locale {
  if (typeof localStorage !== "undefined") {
    const stored = localStorage.getItem("markio.locale");
    if (stored === "zh-CN" || stored === "en") return stored;
  }
  if (typeof navigator !== "undefined") {
    const lang = navigator.language || "";
    if (lang.toLowerCase().startsWith("zh")) return "zh-CN";
  }
  return "en";
}

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
  | "wxAssistantLastDigestSentDate"
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
  | "autoCheckUpdates"
  | "crashWebhookUrl"
  | "aiCacheEnabled"
  | "globalShortcutShow"
  | "driveConfigs"
  | "dropboxClientId"
  | "gdriveClientId"
  | "customThemeId";

export type DriveId = "icloud" | "github" | "webdav" | "s3" | "drop" | "drive";

export interface DriveConfig {
  /** 用户选择的本地同步目录绝对路径；空串表示未配置 */
  folder: string;
  /** 是否启用 */
  enabled: boolean;
  /** ISO 时间戳，最近一次成功同步 */
  lastSyncAt?: string;
}

interface SettingsState {
  /** 界面语言 */
  locale: Locale;
  theme: string;
  fontSize: number;
  /** 界面字体（覆盖 --font-sans）；空串=用主题默认 */
  uiFontFamily: string;
  /** 正文字体（覆盖 --font-serif）；空串=用主题默认 */
  bodyFontFamily: string;
  /** 等宽字体（覆盖 --font-mono）；空串=用主题默认 */
  monoFontFamily: string;
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
  /** 预留：公众号显示名（当前复制流程不读取） */
  wechatAccountName: string;
  /** 预留：公众号 AppID */
  wechatAppId: string;
  /** 预留：公众号草稿 API 接入后用于自动摘要 */
  wechatAutoSummary: boolean;
  /** 预留：公众号草稿 API 接入后用于默认封面 */
  wechatDefaultCover: "none" | "firstImage";
  /** 微信助手开关：开启后每日摘要等动作会推到下方 webhook */
  wxAssistantEnabled: boolean;
  /** Server 酱 / 企业微信机器人 / 自建桥的 webhook */
  wxAssistantWebhook: string;
  /** 每日笔记摘要推送 */
  wxAssistantDailyDigest: boolean;
  /** 摘要推送时间，24h 格式 "HH:mm" */
  wxAssistantDigestTime: string;
  /** 上次成功推送的日期（YYYY-MM-DD），用于跨重启去重 */
  wxAssistantLastDigestSentDate: string;
  /** 预留：公众号草稿 API 接入后是否再推一条通知 */
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
  /** 启动后台检查新版本（不强迫，不自动下载，只通知） */
  autoCheckUpdates: boolean;
  /** 用户自托管的崩溃日志接收 webhook URL；为空则不上报。POST application/json。 */
  crashWebhookUrl: string;
  /** 启用 AI 响应缓存（本次会话期间，相同 prompt+model+context 不重发请求）。
   *  仅命中"完全相同"才返回缓存；用户改一个字都会重发。默认关。 */
  aiCacheEnabled: boolean;
  /** 系统级唤起 markio 的全局快捷键（应用未聚焦时也生效）。空 = 未绑定。
   *  binding 格式与 shortcuts.ts 一致："Mod+Shift+Space"。 */
  globalShortcutShow: string;
  /** 各第三方网盘的轻量配置（folder + enabled），GitHub/WebDAV 走自己专用卡片不存这里 */
  driveConfigs: Partial<Record<DriveId, DriveConfig>>;
  /** Dropbox App key（client_id），在开发者后台注册后填入 */
  dropboxClientId: string;
  /** Google Cloud OAuth Client ID（Desktop application 类型） */
  gdriveClientId: string;
  /** 已应用的自定义 CSS 主题 id（null 表示未应用） */
  customThemeId: string | null;
  /** 全局快捷键的用户覆盖：commandId → binding 字符串。空串表示用户显式取消绑定。 */
  shortcutOverrides: Partial<Record<CommandId, string>>;
  setShortcut: (id: CommandId, binding: string) => void;
  resetShortcut: (id: CommandId) => void;
  resetAllShortcuts: () => void;
  setLocale: (loc: Locale) => void;
  setTheme: (theme: string) => void;
  setFontSize: (n: number) => void;
  setFontFamily: (kind: "ui" | "body" | "mono", value: string) => void;
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
      locale: defaultLocale(),
      theme: "light",
      fontSize: 16,
      uiFontFamily: "",
      bodyFontFamily: "",
      monoFontFamily: "",
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
      wxAssistantLastDigestSentDate: "",
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
      autoCheckUpdates: true,
      crashWebhookUrl: "",
      aiCacheEnabled: false,
      globalShortcutShow: "",
      driveConfigs: {},
      dropboxClientId: "",
      gdriveClientId: "",
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
      setLocale: (locale) => {
        set({ locale });
      },
      setTheme: (theme) => {
        applyTheme(theme);
        set({ theme });
      },
      setFontSize: (fontSize) => set({ fontSize }),
      setFontFamily: (kind, value) =>
        set((s) => {
          const next =
            kind === "ui"
              ? { ...s, uiFontFamily: value }
              : kind === "body"
                ? { ...s, bodyFontFamily: value }
                : { ...s, monoFontFamily: value };
          applyFonts({
            uiFontFamily: next.uiFontFamily,
            bodyFontFamily: next.bodyFontFamily,
            monoFontFamily: next.monoFontFamily,
          });
          return {
            uiFontFamily: next.uiFontFamily,
            bodyFontFamily: next.bodyFontFamily,
            monoFontFamily: next.monoFontFamily,
          };
        }),
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
      version: 1,
      migrate: (persistedState) =>
        stripLegacySecretFields(persistedState) as SettingsState,
      partialize: (state) =>
        stripLegacySecretFields(state) as Partial<SettingsState>,
      onRehydrateStorage: () => (state) => {
        if (state) applyTheme(state.theme);
      },
    },
  ),
);

function stripLegacySecretFields(state: unknown): unknown {
  if (!state || typeof state !== "object") return state;
  const next = { ...(state as Record<string, unknown>) };
  delete next.rerankApiKey;
  return next;
}
