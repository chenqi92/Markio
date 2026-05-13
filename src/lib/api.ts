/**
 * Typed wrappers around the Rust commands defined in src-tauri/src/lib.rs.
 *
 * 大文件读写、扫描、grep、markdown 渲染都在 Rust 中完成；前端只负责拼接 UI。
 */
import type {
  Backlink,
  FileEntry,
  GrepHit,
  OutlineItem,
  RenderResult,
  Snapshot,
  TrashItem,
} from "@/types";

const isTauri = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new Error(
      `Tauri 命令 \`${cmd}\` 仅在桌面端可用。请通过 \`pnpm tauri:dev\` 启动。`,
    );
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export async function pickDirectory(): Promise<string | null> {
  if (!isTauri()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ directory: true, multiple: false });
  if (typeof selected === "string") return selected;
  return null;
}

export async function pickFile(filters?: { name: string; extensions: string[] }[]): Promise<string | null> {
  if (!isTauri()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ multiple: false, filters });
  if (typeof selected === "string") return selected;
  return null;
}

export const isDesktop = isTauri;

export const api = {
  renderMarkdown: (source: string) =>
    invoke<RenderResult>("md_render", { source }),
  outline: (source: string) => invoke<OutlineItem[]>("md_outline", { source }),

  readTree: (path: string) => invoke<FileEntry>("fs_read_tree", { path }),
  readText: (path: string) => invoke<string>("fs_read_text", { path }),
  writeText: (path: string, content: string) =>
    invoke<void>("fs_write_text", { path, content }),
  rename: (from: string, to: string) =>
    invoke<void>("fs_rename", { from, to }),
  remove: (path: string) => invoke<void>("fs_delete", { path }),
  mkdir: (path: string) => invoke<void>("fs_mkdir", { path }),
  grep: (root: string, query: string, max = 80) =>
    invoke<GrepHit[]>("fs_grep", { root, query, max }),
  reveal: (path: string) => invoke<void>("fs_reveal", { path }),

  historySave: (workspace: string, file: string, content: string) =>
    invoke<void>("history_save", { workspace, file, content }),
  historyList: (workspace: string, file: string) =>
    invoke<Snapshot[]>("history_list", { workspace, file }),
  historyRead: (path: string) => invoke<string>("history_read", { path }),

  backlinks: (workspace: string, file: string, max = 50) =>
    invoke<Backlink[]>("fs_backlinks", { workspace, file, max }),

  trashMove: (workspace: string, path: string) =>
    invoke<void>("fs_trash_move", { workspace, path }),
  trashList: (workspace: string) =>
    invoke<TrashItem[]>("fs_trash_list", { workspace }),
  trashRestore: (workspace: string, stored: string) =>
    invoke<string>("fs_trash_restore", { workspace, stored }),
  trashPurge: (workspace: string, stored?: string) =>
    invoke<void>("fs_trash_purge", { workspace, stored }),

  aiChat: (req: {
    provider: string;
    apiKey?: string;
    endpoint?: string;
    model: string;
    maxTokens?: number;
    temperature?: number;
    system?: string;
    messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  }) =>
    invoke<{
      text: string;
      model?: string;
      inputTokens?: number;
      outputTokens?: number;
    }>("ai_chat", { req }),
};
