import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { applyTheme } from "@/themes";
import type { ViewMode } from "@/types";

interface SettingsState {
  theme: string;
  fontSize: number;
  defaultMode: ViewMode;
  showLiveCursors: boolean;
  shortcutStyle: "all" | "bubble" | "slash" | "toolbar";
  followSystemTheme: boolean;
  darkVariant: string;
  lightVariant: string;
  autosave: boolean;
  aiProvider: "anthropic" | "openai" | "deepseek" | "ollama" | "google" | "custom";
  aiApiKey: string;
  aiEndpoint: string;
  aiModel: string;
  aiTemperature: number;
  aiMaxTokens: number;
  setTheme: (theme: string) => void;
  setFontSize: (n: number) => void;
  setDefaultMode: (m: ViewMode) => void;
  setShortcutStyle: (s: SettingsState["shortcutStyle"]) => void;
  setShowLiveCursors: (v: boolean) => void;
  setFollowSystemTheme: (v: boolean) => void;
  setVariant: (kind: "dark" | "light", id: string) => void;
  setAutosave: (v: boolean) => void;
  setAi: (
    p: Partial<{
      aiProvider: SettingsState["aiProvider"];
      aiApiKey: string;
      aiEndpoint: string;
      aiModel: string;
      aiTemperature: number;
      aiMaxTokens: number;
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
      shortcutStyle: "all",
      followSystemTheme: false,
      darkVariant: "dark",
      lightVariant: "light",
      autosave: true,
      aiProvider: "anthropic",
      aiApiKey: "",
      aiEndpoint: "",
      aiModel: "claude-haiku-4-5",
      aiTemperature: 0.7,
      aiMaxTokens: 4096,
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
