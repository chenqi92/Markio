import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { IconName } from "@/components/ui/Icon";
import { tauriStorage } from "@/lib/tauriStorage";
import { pathKey } from "@/lib/utils";

/**
 * 给具体文件 / 文件夹设一个内置 SVG 符号，用 pathKey 归一化的绝对路径做 key
 * （大小写/分隔符无关），工作区无关，跨重启持久化。
 */
interface FileIconsState {
  icons: Record<string, IconName>;
  set: (path: string, icon: IconName | null) => void;
  get: (path: string) => IconName | undefined;
  /** 重命名 / 移动时迁移 key（含文件夹下的子条目）。 */
  relocate: (from: string, to: string) => void;
  /** 删除 / 移入回收站时清除 key（含子条目），避免孤儿条目永久残留。 */
  forget: (path: string) => void;
}

export const useFileIcons = create<FileIconsState>()(
  persist(
    (set, getState) => ({
      icons: {},
      set: (path, icon) =>
        set((s) => {
          const k = pathKey(path);
          const next = { ...s.icons };
          if (icon == null) {
            delete next[k];
          } else {
            next[k] = icon;
          }
          return { icons: next };
        }),
      get: (path) => getState().icons[pathKey(path)],
      relocate: (from, to) =>
        set((s) => {
          if (!from || !to) return s;
          const fromKey = pathKey(from);
          const toKey = pathKey(to);
          if (fromKey === toKey) return s;
          let changed = false;
          const next: Record<string, IconName> = {};
          for (const [p, icon] of Object.entries(s.icons)) {
            if (p === fromKey) {
              next[toKey] = icon;
              changed = true;
            } else if (p.startsWith(`${fromKey}/`)) {
              next[toKey + p.slice(fromKey.length)] = icon;
              changed = true;
            } else {
              next[p] = icon;
            }
          }
          return changed ? { icons: next } : s;
        }),
      forget: (path) =>
        set((s) => {
          const fromKey = pathKey(path);
          let changed = false;
          const next: Record<string, IconName> = {};
          for (const [p, icon] of Object.entries(s.icons)) {
            if (p === fromKey || p.startsWith(`${fromKey}/`)) {
              changed = true;
              continue;
            }
            next[p] = icon;
          }
          return changed ? { icons: next } : s;
        }),
    }),
    {
      name: "markio.fileIcons.v1",
      storage: createJSONStorage(() => tauriStorage),
      skipHydration: true,
      version: 1,
      // v0 按原始路径键，v1 改用 pathKey；迁移时重新归键。
      migrate: (persisted) => {
        const p = persisted as { icons?: Record<string, IconName> } | undefined;
        if (p?.icons) {
          const next: Record<string, IconName> = {};
          for (const [path, icon] of Object.entries(p.icons)) {
            next[pathKey(path)] = icon;
          }
          p.icons = next;
        }
        return p as FileIconsState;
      },
    },
  ),
);
