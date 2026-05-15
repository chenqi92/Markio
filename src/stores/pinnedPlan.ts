import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

interface PinnedPlanState {
  /** 被钉选的 markdown 文件绝对路径；null 表示未钉选 */
  path: string | null;
  /** 折叠/展开状态 */
  collapsed: boolean;
  pin: (path: string) => void;
  unpin: () => void;
  toggle: (path: string) => void;
  setCollapsed: (v: boolean) => void;
}

export const usePinnedPlan = create<PinnedPlanState>()(
  persist(
    (set, get) => ({
      path: null,
      collapsed: false,
      pin: (path) => set({ path }),
      unpin: () => set({ path: null }),
      toggle: (path) => {
        const cur = get().path;
        set({ path: cur === path ? null : path });
      },
      setCollapsed: (collapsed) => set({ collapsed }),
    }),
    {
      name: "markio.pinned-plan.v1",
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
