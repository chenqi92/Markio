import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { ViewMode } from "@/types";

interface UIState {
  sidebarOpen: boolean;
  sidebarWidth: number;
  outlineOpen: boolean;
  focusMode: boolean;
  mode: ViewMode;
  commandOpen: boolean;
  findOpen: boolean;
  settingsOpen: boolean;
  historyOpen: boolean;
  toast: { stage: "uploading" | "done" | "error"; message: string } | null;
  aiOpen: boolean;
  wechatOpen: boolean;
  findQuery: string;
  findIndex: number;
  globalSearchOpen: boolean;
  quickCaptureOpen: boolean;
  exportSheetOpen: boolean;

  setMode: (m: ViewMode) => void;
  toggleSidebar: () => void;
  setSidebarWidth: (w: number) => void;
  toggleOutline: () => void;
  toggleFocus: () => void;
  openCommand: (v: boolean) => void;
  openFind: (v: boolean) => void;
  openSettings: (v: boolean) => void;
  openHistory: (v: boolean) => void;
  openAi: (v: boolean) => void;
  openWechat: (v: boolean) => void;
  setFindQuery: (q: string) => void;
  setFindIndex: (n: number) => void;
  openGlobalSearch: (v: boolean) => void;
  openQuickCapture: (v: boolean) => void;
  openExportSheet: (v: boolean) => void;
  setToast: (t: UIState["toast"]) => void;
}

export const useUI = create<UIState>()(
  persist(
    (set) => ({
      sidebarOpen: true,
      sidebarWidth: 244,
      outlineOpen: true,
      focusMode: false,
      mode: "split",
      commandOpen: false,
      findOpen: false,
      settingsOpen: false,
      historyOpen: false,
      aiOpen: false,
      wechatOpen: false,
      findQuery: "",
      findIndex: 0,
      globalSearchOpen: false,
      quickCaptureOpen: false,
      exportSheetOpen: false,
      toast: null,
      setMode: (mode) => set({ mode }),
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      setSidebarWidth: (w) =>
        set({ sidebarWidth: Math.max(180, Math.min(420, Math.round(w))) }),
      toggleOutline: () => set((s) => ({ outlineOpen: !s.outlineOpen })),
      toggleFocus: () => set((s) => ({ focusMode: !s.focusMode })),
      openCommand: (v) => set({ commandOpen: v }),
      openFind: (v) => set({ findOpen: v }),
      openSettings: (v) => set({ settingsOpen: v }),
      openHistory: (v) => set({ historyOpen: v }),
      openAi: (v) => set({ aiOpen: v }),
      openWechat: (v) => set({ wechatOpen: v }),
      setFindQuery: (findQuery) => set({ findQuery, findIndex: 0 }),
      setFindIndex: (findIndex) => set({ findIndex }),
      openGlobalSearch: (globalSearchOpen) => set({ globalSearchOpen }),
      openQuickCapture: (quickCaptureOpen) => set({ quickCaptureOpen }),
      openExportSheet: (exportSheetOpen) => set({ exportSheetOpen }),
      setToast: (toast) => set({ toast }),
    }),
    {
      name: "markio.ui.v1",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        sidebarOpen: s.sidebarOpen,
        sidebarWidth: s.sidebarWidth,
        outlineOpen: s.outlineOpen,
        focusMode: s.focusMode,
        mode: s.mode,
      }),
    },
  ),
);
