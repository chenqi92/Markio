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
  children?: FileEntry[] | null;
  truncated?: boolean;
}

export type ViewMode = "source" | "split" | "wysiwyg";

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

export interface TimelineEntry {
  snapshotPath: string;
  sourcePath: string;
  sourceName: string;
  timestamp: number;
  size: number;
}

export interface NoteFrontmatter {
  path: string;
  name: string;
  fields: Record<string, string[]>;
}

export type AgentProvider =
  | "claude"
  | "codex"
  | "gemini"
  | "cursor"
  | "opencode"
  | "qwen"
  | "copilot"
  | "aider"
  | "goose";
export type AgentPermission = "safe" | "poweruser";

export interface AgentProviderInfo {
  id: AgentProvider;
  label: string;
  available: boolean;
  binaryPath: string | null;
}

export interface AgentRunRequest {
  sessionId: string;
  provider: AgentProvider;
  prompt: string;
  workspace?: string;
  permission?: AgentPermission;
}

export type AgentEvent =
  | { type: "init"; session_id: string | null; provider: AgentProvider; binary: string }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_start"; id: string; tool: string; input: unknown }
  | { type: "tool_done"; id: string; tool: string; output: unknown; is_error: boolean }
  | {
      type: "result";
      text: string;
      input_tokens: number | null;
      output_tokens: number | null;
    }
  | { type: "error"; message: string }
  | { type: "done" };

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
  isDir: boolean;
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
