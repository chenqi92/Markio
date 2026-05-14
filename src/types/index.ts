export interface Workspace {
  id: string;
  name: string;
  path: string;
  color: string;
  initial: string;
  lastOpenedAt: number;
}

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: number;
  children?: FileEntry[];
  truncated?: boolean;
}

export type ViewMode = "source" | "split" | "wysiwyg" | "preview";

export interface TabInfo {
  id: string;
  workspaceId: string;
  path: string;
  title: string;
  /** 最近一次从磁盘读取到的源 */
  baseline: string;
  /** 当前编辑器中的内容（脏 = baseline !== content） */
  content: string;
  dirty: boolean;
  scrollTop: number;
  pinned: boolean;
}

export interface OutlineItem {
  level: number;
  text: string;
  anchor: string;
}

export interface RenderResult {
  html: string;
  outline: OutlineItem[];
  words: number;
  readingMinutes: number;
}

export interface GrepHit {
  path: string;
  name: string;
  line: number;
  preview: string;
}

export interface Snapshot {
  path: string;
  name: string;
  timestamp: number;
  size: number;
}

export interface Backlink {
  path: string;
  name: string;
  line: number;
  preview: string;
}

export interface TrashItem {
  path: string;
  name: string;
  original: string;
  timestamp: number;
  size: number;
}

export interface Attachment {
  path: string;
  name: string;
  size: number;
  modified: number;
  kind:
    | "pdf"
    | "image"
    | "svg"
    | "video"
    | "audio"
    | "word"
    | "sheet"
    | "slides"
    | "archive";
}

export interface ThemeDef {
  id: string;
  name: string;
  swatch: [string, string, string];
  isDark: boolean;
}
