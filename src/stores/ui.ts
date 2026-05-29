import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { ViewMode } from "@/types";
import { tauriStorage } from "@/lib/tauriStorage";

/** 侧栏顶部的 tab：files = 文件树；tasks = 任务收件箱；tags = 标签全景；props = frontmatter 浏览。 */
export type SidebarTab = "files" | "tasks" | "tags" | "props";

interface UIState {
  sidebarOpen: boolean;
  sidebarWidth: number;
  sidebarTab: SidebarTab;
  outlineOpen: boolean;
  focusMode: boolean;
  mode: ViewMode;
  commandOpen: boolean;
  findOpen: boolean;
  settingsOpen: boolean;
  historyOpen: boolean;
  pulseOpen: boolean;
  agentOpen: boolean;
  toast: { stage: "uploading" | "done" | "error"; message: string } | null;
  aiOpen: boolean;
  wechatOpen: boolean;
  findQuery: string;
  findIndex: number;
  findCaseSensitive: boolean;
  findWholeWord: boolean;
  findRegex: boolean;
  lineJump: { path: string; line: number; nonce: number } | null;
  globalSearchOpen: boolean;
  quickCaptureOpen: boolean;
  exportSheetOpen: boolean;
  multiCopyOpen: boolean;
  /** 块操作菜单（⌘⇧.）当前的弹出坐标；null = 关闭 */
  blockMenuAt: { x: number; y: number } | null;

  setMode: (m: ViewMode) => void;
  toggleSidebar: () => void;
  setSidebarWidth: (w: number) => void;
  setSidebarTab: (tab: SidebarTab) => void;
  toggleOutline: () => void;
  toggleFocus: () => void;
  openCommand: (v: boolean) => void;
  openFind: (v: boolean) => void;
  openSettings: (v: boolean) => void;
  openHistory: (v: boolean) => void;
  openPulse: (v: boolean) => void;
  openAgent: (v: boolean) => void;
  openAi: (v: boolean) => void;
  openWechat: (v: boolean) => void;
  setFindQuery: (q: string) => void;
  setFindIndex: (n: number) => void;
  setFindOptions: (
    patch: Partial<
      Pick<UIState, "findCaseSensitive" | "findWholeWord" | "findRegex">
    >,
  ) => void;
  jumpToLine: (path: string, line: number) => void;
  clearLineJump: (nonce?: number) => void;
  openGlobalSearch: (v: boolean) => void;
  openQuickCapture: (v: boolean) => void;
  openExportSheet: (v: boolean) => void;
  openMultiCopy: (v: boolean) => void;
  setBlockMenuAt: (pos: { x: number; y: number } | null) => void;
  setToast: (t: UIState["toast"]) => void;
}

export const useUI = create<UIState>()(
  persist(
    (set) => ({
      sidebarOpen: true,
      sidebarWidth: 244,
      sidebarTab: "files",
      outlineOpen: true,
      focusMode: false,
      mode: "split",
      commandOpen: false,
      findOpen: false,
      settingsOpen: false,
      historyOpen: false,
      pulseOpen: false,
      agentOpen: false,
      aiOpen: false,
      wechatOpen: false,
      findQuery: "",
      findIndex: 0,
      findCaseSensitive: false,
      findWholeWord: false,
      findRegex: false,
      lineJump: null,
      globalSearchOpen: false,
      quickCaptureOpen: false,
      exportSheetOpen: false,
      multiCopyOpen: false,
      blockMenuAt: null,
      toast: null,
      setMode: (mode) => set({ mode }),
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      setSidebarWidth: (w) =>
        set({ sidebarWidth: Math.max(208, Math.min(420, Math.round(w))) }),
      setSidebarTab: (sidebarTab) => set({ sidebarTab }),
      toggleOutline: () => set((s) => ({ outlineOpen: !s.outlineOpen })),
      toggleFocus: () => set((s) => ({ focusMode: !s.focusMode })),
      openCommand: (v) => set({ commandOpen: v }),
      openFind: (v) => set({ findOpen: v }),
      openSettings: (v) => set({ settingsOpen: v }),
      openHistory: (v) => set({ historyOpen: v }),
      openPulse: (v) => set({ pulseOpen: v }),
      openAgent: (v) => set({ agentOpen: v }),
      openAi: (v) => set({ aiOpen: v }),
      openWechat: (v) => set({ wechatOpen: v }),
      setFindQuery: (findQuery) => set({ findQuery, findIndex: 0 }),
      setFindIndex: (findIndex) => set({ findIndex }),
      setFindOptions: (patch) => set({ ...patch, findIndex: 0 }),
      jumpToLine: (path, line) =>
        set({ lineJump: { path, line, nonce: Date.now() } }),
      clearLineJump: (nonce) =>
        set((s) =>
          !s.lineJump || (nonce != null && s.lineJump.nonce !== nonce)
            ? s
            : { lineJump: null },
        ),
      openGlobalSearch: (globalSearchOpen) => set({ globalSearchOpen }),
      openQuickCapture: (quickCaptureOpen) => set({ quickCaptureOpen }),
      openExportSheet: (exportSheetOpen) => set({ exportSheetOpen }),
      openMultiCopy: (multiCopyOpen) => set({ multiCopyOpen }),
      setBlockMenuAt: (blockMenuAt) => set({ blockMenuAt }),
      setToast: (toast) => set({ toast }),
    }),
    {
      name: "markio.ui.v1",
      storage: createJSONStorage(() => tauriStorage),
      skipHydration: true,
      partialize: (s) => ({
        sidebarOpen: s.sidebarOpen,
        sidebarWidth: s.sidebarWidth,
        sidebarTab: s.sidebarTab,
        outlineOpen: s.outlineOpen,
        focusMode: s.focusMode,
        mode: s.mode,
      }),
      // hydrate 时校验 mode / sidebarTab：老版本可能持久化已下线的值
      // （比如 "block" 是早期实验后来合并回 "wysiwyg"），未校正会让
      // MODE_CLASS[mode] 返回 undefined 让编辑器渲染空壳。
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<UIState>;
        const validModes: ViewMode[] = ["source", "split", "wysiwyg"];
        const validTabs: SidebarTab[] = ["files", "tasks", "tags", "props"];
        return {
          ...current,
          ...p,
          mode: validModes.includes(p.mode as ViewMode)
            ? (p.mode as ViewMode)
            : "split",
          sidebarTab: validTabs.includes(p.sidebarTab as SidebarTab)
            ? (p.sidebarTab as SidebarTab)
            : "files",
        };
      },
    },
  ),
);
