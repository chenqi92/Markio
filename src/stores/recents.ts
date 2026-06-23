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

/** 从持久化里清洗出合法的最近条目：丢弃非数组 / 缺字段 / 类型不符的脏数据，
 *  避免损坏或被篡改的 store.bin 在启动期把消费方的 .filter/.map 打崩。 */
export function sanitizeRecentItems(raw: unknown): RecentItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (it): it is RecentItem =>
        !!it &&
        typeof it === "object" &&
        typeof (it as RecentItem).workspaceId === "string" &&
        typeof (it as RecentItem).path === "string" &&
        typeof (it as RecentItem).name === "string" &&
        typeof (it as RecentItem).at === "number",
    )
    .slice(0, MAX);
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
      // 损坏 / 被篡改的 store.bin（items 非数组或条目缺字段）不应在启动期把消费方
      // 的 .filter/.map 打崩——这里做结构校验，丢弃不合法条目。
      merge: (persisted, current) => {
        const p = persisted as Partial<RecentsState> | undefined;
        return { ...current, items: sanitizeRecentItems(p?.items) };
      },
    },
  ),
);
