import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { tauriStorage } from "@/lib/tauriStorage";

interface RecentItem {
  workspaceId: string;
  path: string;
  name: string;
  at: number;
}

interface RecentsState {
  items: RecentItem[];
  push: (workspaceId: string, path: string, name: string) => void;
  forget: (path: string) => void;
  /** 删除文件 / 文件夹后，按路径前缀清掉自身及其子项的最近记录。 */
  forgetUnder: (path: string) => void;
  /** 重命名 / 移动后，把旧路径（含子项）改写到新路径，保留最近记录。 */
  relocate: (from: string, to: string) => void;
}

const MAX = 30;

/** 归一化路径分隔符，便于跨平台前缀比较。 */
function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** path 是否等于 base 或在 base 目录之下。 */
function isUnder(path: string, base: string): boolean {
  const p = norm(path);
  const b = norm(base);
  return p === b || p.startsWith(b + "/");
}

function basename(p: string): string {
  const parts = norm(p).split("/");
  return parts[parts.length - 1] ?? p;
}

export const useRecents = create<RecentsState>()(
  persist(
    (set) => ({
      items: [],
      push: (workspaceId, path, name) =>
        set((s) => {
          const next = [
            { workspaceId, path, name, at: Date.now() },
            ...s.items.filter((it) => it.path !== path),
          ].slice(0, MAX);
          return { items: next };
        }),
      forget: (path) =>
        set((s) => ({ items: s.items.filter((it) => it.path !== path) })),
      forgetUnder: (path) =>
        set((s) => ({ items: s.items.filter((it) => !isUnder(it.path, path)) })),
      relocate: (from, to) =>
        set((s) => ({
          items: s.items.map((it) => {
            if (!isUnder(it.path, from)) return it;
            const suffix = norm(it.path).slice(norm(from).length);
            const nextPath = norm(to) + suffix;
            return { ...it, path: nextPath, name: basename(nextPath) };
          }),
        })),
    }),
    {
      name: "markio.recents.v1",
      storage: createJSONStorage(() => tauriStorage),
      skipHydration: true,
    },
  ),
);
