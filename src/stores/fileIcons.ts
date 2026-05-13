import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { IconName } from "@/components/ui/Icon";

/**
 * 给具体文件 / 文件夹设一个内置 SVG 符号，用绝对路径做 key，工作区无关，跨重启持久化。
 */
interface FileIconsState {
  icons: Record<string, IconName>;
  set: (path: string, icon: IconName | null) => void;
  get: (path: string) => IconName | undefined;
}

export const useFileIcons = create<FileIconsState>()(
  persist(
    (set, getState) => ({
      icons: {},
      set: (path, icon) =>
        set((s) => {
          const next = { ...s.icons };
          if (icon == null) {
            delete next[path];
          } else {
            next[path] = icon;
          }
          return { icons: next };
        }),
      get: (path) => getState().icons[path],
    }),
    {
      name: "markio.fileIcons.v1",
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
