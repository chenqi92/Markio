/**
 * 会话恢复：把"上次哪些 tab 打开着"持久化，崩溃 / 强退后启动时恢复。
 *
 * 不存 tab 的 content（太大且变化快）：
 *   - 重启后从磁盘重读，正常 saved 内容自然回来
 *   - 未保存的脏数据 → 这条只负责恢复"打开列表"，草稿恢复见 saveTab / autosave 流
 *
 * 由 App.tsx 在 workspace.hydrate() 之后订阅 useTabs，每次 tabs/activeId 变化
 * 把元信息（workspaceId / path / pinned）+ activePath 写入这个 store。
 * 重启后 App.tsx 用 openTabs 逐个 openPath 恢复。
 */
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { tauriStorage } from "@/lib/tauriStorage";

export interface SessionTab {
  workspaceId: string;
  path: string;
  pinned: boolean;
}

interface SessionState {
  openTabs: SessionTab[];
  activePath: string | null;
  remember: (tabs: SessionTab[], activePath: string | null) => void;
}

export const useSession = create<SessionState>()(
  persist(
    (set) => ({
      openTabs: [],
      activePath: null,
      remember: (openTabs, activePath) => set({ openTabs, activePath }),
    }),
    {
      name: "markio.session.v1",
      storage: createJSONStorage(() => tauriStorage),
      skipHydration: true,
    },
  ),
);
