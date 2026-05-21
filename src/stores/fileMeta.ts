import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

/** 文件级用户元数据：收藏 / 颜色 / 标记 (区别于 #tag 来自文档内容)。
 *  存在 localStorage 里，按绝对路径索引；文件被重命名 / 移动后这里不会自动跟随，
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
      toggleBookmark: (path) =>
        set((s) => {
          const cur = s.byPath[path] ?? {};
          const next: FileMetaEntry = { ...cur, bookmark: !cur.bookmark };
          return { byPath: { ...s.byPath, [path]: pruneEntry(next) } };
        }),
      setColor: (path, color) =>
        set((s) => {
          const cur = s.byPath[path] ?? {};
          const next: FileMetaEntry = { ...cur, color: color || undefined };
          return { byPath: { ...s.byPath, [path]: pruneEntry(next) } };
        }),
      addMark: (path, mark) =>
        set((s) => {
          const cur = s.byPath[path] ?? {};
          const marks = Array.from(new Set([...(cur.marks ?? []), mark.trim()].filter(Boolean)));
          return { byPath: { ...s.byPath, [path]: pruneEntry({ ...cur, marks }) } };
        }),
      removeMark: (path, mark) =>
        set((s) => {
          const cur = s.byPath[path] ?? {};
          const marks = (cur.marks ?? []).filter((m) => m !== mark);
          return { byPath: { ...s.byPath, [path]: pruneEntry({ ...cur, marks }) } };
        }),
      movePath: (from, to) =>
        set((s) => {
          if (!s.byPath[from]) return s;
          const next = { ...s.byPath };
          next[to] = next[from];
          delete next[from];
          return { byPath: next };
        }),
      prune: (livePaths) =>
        set((s) => {
          const next: Record<string, FileMetaEntry> = {};
          for (const [path, meta] of Object.entries(s.byPath)) {
            if (livePaths.has(path)) next[path] = meta;
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
      storage: createJSONStorage(() => localStorage),
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
