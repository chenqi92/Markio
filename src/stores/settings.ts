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
  | "wechatStyle"
  | "wechatAuthor"
  | "lobsterModelSource"
  | "lobsterDailyLimit"
  | "exportPdfTheme"
  | "exportPdfMargin";

interface SettingsState {
  theme: string;
  fontSize: number;
  defaultMode: ViewMode;
  showLiveCursors: boolean;
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
  picgoEndpoint: "http://127.0.0.1:36677" | "http://localhost:36677" | "http://127.0.0.1:36678";
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
  setTheme: (theme: string) => void;
  setFontSize: (n: number) => void;
  setDefaultMode: (m: ViewMode) => void;
  setShortcutStyle: (s: SettingsState["shortcutStyle"]) => void;
  setShowLiveCursors: (v: boolean) => void;
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
      showLiveCursors: false,
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
      setTheme: (theme) => {
        applyTheme(theme);
        set({ theme });
      },
      setFontSize: (fontSize) => set({ fontSize }),
      setDefaultMode: (defaultMode) => set({ defaultMode }),
      setShortcutStyle: (shortcutStyle) => set({ shortcutStyle }),
      setShowLiveCursors: (showLiveCursors) => set({ showLiveCursors }),
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
