import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { pathKey } from "@/lib/utils";
import { tauriStorage } from "@/lib/tauriStorage";

/** 文件级用户元数据：收藏 / 颜色 / 标记 (区别于 #tag 来自文档内容)。
 *  桌面端走 tauriStorage(plugin-store)，与其它 store 共享 store.bin；浏览器 dev 回退 localStorage。
 *  按绝对路径索引；文件被重命名 / 移动后这里不会自动跟随，
 *  右键菜单 / FileTree 在调用 rename 时主动迁移条目。 */
export interface FileMetaEntry {
  bookmark?: boolean;
  /** CSS color，建议从 FILE_COLOR_PALETTE 里选；任意字符串也可。 */
  color?: string;
  /** 用户自定义标记，跟 markdown 内 #tag 是两套体系（避免互相污染）。 */
  marks?: string[];
}

export const FILE_COLOR_PALETTE: ReadonlyArray<{ id: string; label: string }> = [
  { id: "", label: "无" },
  { id: "#dc2626", label: "红" },
  { id: "#ea580c", label: "橙" },
  { id: "#eab308", label: "黄" },
  { id: "#16a34a", label: "绿" },
  { id: "#2563eb", label: "蓝" },
  { id: "#8b5cf6", label: "紫" },
  { id: "#64748b", label: "灰" },
];

interface FileMetaState {
  byPath: Record<string, FileMetaEntry>;
  toggleBookmark: (path: string) => void;
  setColor: (path: string, color: string | undefined) => void;
  addMark: (path: string, mark: string) => void;
  removeMark: (path: string, mark: string) => void;
  /** 重命名 / 移动时迁移条目 */
  movePath: (from: string, to: string) => void;
  /** 路径不存在时清理（FileTree 刷新后偶尔走一次） */
  prune: (livePaths: Set<string>) => void;
  /** 收藏的文件路径列表，用于侧栏 / 命令面板 */
  bookmarked: () => string[];
}

export const useFileMeta = create<FileMetaState>()(
  persist(
    (set, get) => ({
      byPath: {},
      // byPath 一律按 pathKey 归一化键（大小写/分隔符无关），否则重命名后
      // tab 用 '/'-路径、树节点用 '\'-路径会查不到对方，导致书签/颜色/标记/图标丢失。
      toggleBookmark: (path) =>
        set((s) => {
          const k = pathKey(path);
          const cur = s.byPath[k] ?? {};
          const next: FileMetaEntry = { ...cur, bookmark: !cur.bookmark };
          return { byPath: { ...s.byPath, [k]: pruneEntry(next) } };
        }),
      setColor: (path, color) =>
        set((s) => {
          const k = pathKey(path);
          const cur = s.byPath[k] ?? {};
          const next: FileMetaEntry = { ...cur, color: color || undefined };
          return { byPath: { ...s.byPath, [k]: pruneEntry(next) } };
        }),
      addMark: (path, mark) =>
        set((s) => {
          const k = pathKey(path);
          const cur = s.byPath[k] ?? {};
          const marks = Array.from(new Set([...(cur.marks ?? []), mark.trim()].filter(Boolean)));
          return { byPath: { ...s.byPath, [k]: pruneEntry({ ...cur, marks }) } };
        }),
      removeMark: (path, mark) =>
        set((s) => {
          const k = pathKey(path);
          const cur = s.byPath[k] ?? {};
          const marks = (cur.marks ?? []).filter((m) => m !== mark);
          return { byPath: { ...s.byPath, [k]: pruneEntry({ ...cur, marks }) } };
        }),
      movePath: (from, to) =>
        set((s) => {
          if (!from || !to || from === to) return s;
          const fromKey = pathKey(from);
          let changed = false;
          const toKey = pathKey(to);
          const next: Record<string, FileMetaEntry> = {};
          for (const [p, meta] of Object.entries(s.byPath)) {
            const k = pathKey(p);
            if (k === fromKey) {
              next[toKey] = meta;
              changed = true;
            } else if (k.startsWith(`${fromKey}/`)) {
              // 文件夹移动：子条目按相对 suffix 拼到新前缀
              const suffix = k.slice(fromKey.length);
              next[toKey + suffix] = meta;
              changed = true;
            } else {
              next[k] = meta;
            }
          }
          return changed ? { byPath: next } : s;
        }),
      prune: (livePaths) =>
        set((s) => {
          // livePaths 可能是原始分隔符路径，按 pathKey 归一化后比较
          const liveKeys = new Set(Array.from(livePaths, (p) => pathKey(p)));
          const next: Record<string, FileMetaEntry> = {};
          for (const [path, meta] of Object.entries(s.byPath)) {
            if (liveKeys.has(pathKey(path))) next[path] = meta;
          }
          return { byPath: next };
        }),
      bookmarked: () =>
        Object.entries(get().byPath)
          .filter(([, m]) => m.bookmark)
          .map(([p]) => p),
    }),
    {
      name: "markio.fileMeta.v1",
      storage: createJSONStorage(() => tauriStorage),
      // 与其它 store 一致：跳过模块求值时的自动水合，等 main.tsx bootstrap()
      // 在 preloadTauriStorage() 之后统一 rehydrate，否则首次 mutation 会用空 byPath
      // 覆盖掉持久化数据。
      skipHydration: true,
      version: 1,
      // v0 的 byPath 按原始路径键，v1 改用 pathKey 归一化键，迁移时重新归键。
      migrate: (persisted) => {
        const p = persisted as { byPath?: Record<string, FileMetaEntry> } | undefined;
        if (p?.byPath) {
          const next: Record<string, FileMetaEntry> = {};
          for (const [path, meta] of Object.entries(p.byPath)) {
            next[pathKey(path)] = meta;
          }
          p.byPath = next;
        }
        return p as FileMetaState;
      },
    },
  ),
);

/** 全空对象时返回 {}，便于 GC；JSON 持久化时少占字节。 */
function pruneEntry(e: FileMetaEntry): FileMetaEntry {
  const out: FileMetaEntry = {};
  if (e.bookmark) out.bookmark = true;
  if (e.color) out.color = e.color;
  if (e.marks && e.marks.length > 0) out.marks = e.marks;
  return out;
}
