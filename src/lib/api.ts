/**
 * Typed wrappers around the Rust commands defined in src-tauri/src/lib.rs.
 *
 * 大文件读写、扫描、grep、markdown 渲染、AI 代理、密钥钥匙串 都在 Rust 中完成；
 * 前端只负责拼接 UI 与状态。
 */
import type {
  Attachment,
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

export async function pickFile(
  filters?: { name: string; extensions: string[] }[],
): Promise<string | null> {
  if (!isTauri()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ multiple: false, filters });
  if (typeof selected === "string") return selected;
  return null;
}

export const isDesktop = isTauri;

export interface FileSig {
  mtime: number;
  hash: string;
}

export interface OpenedFile {
  path: string;
  content: string;
  sig: FileSig;
}

export interface PasteImageResult {
  markdown: string;
  url: string;
  localPath?: string | null;
  uploaded: boolean;
  warning?: string | null;
}

/** 把 Rust 返回的错误 string 拆开 */
export function parseError(e: unknown): {
  code: "CONFLICT" | "ALREADY_EXISTS" | "DENIED" | "OTHER";
  message: string;
  extra?: string;
} {
  const msg = (e as Error)?.message ?? String(e);
  if (msg.startsWith("CONFLICT:")) {
    const rest = msg.slice("CONFLICT:".length);
    return { code: "CONFLICT", message: msg, extra: rest };
  }
  if (msg.startsWith("ALREADY_EXISTS:")) {
    return { code: "ALREADY_EXISTS", message: msg };
  }
  if (msg.startsWith("拒绝访问")) {
    return { code: "DENIED", message: msg };
  }
  return { code: "OTHER", message: msg };
}

export const api = {
  renderMarkdown: (source: string, basePath?: string) =>
    invoke<RenderResult>(
      "md_render",
      basePath ? { source, basePath } : { source },
    ),
  outline: (source: string) => invoke<OutlineItem[]>("md_outline", { source }),

  // workspace 注册
  workspaceRegister: (path: string) =>
    invoke<string>("workspace_register", { path }),
  workspaceUnregister: (path: string) =>
    invoke<void>("workspace_unregister", { path }),

  readTree: (path: string) => invoke<FileEntry>("fs_read_tree", { path }),

  /** 打开文件：返回内容 + 指纹（用于保存时冲突检测） */
  open: (path: string) => invoke<OpenedFile>("fs_open", { path }),
  /** 关闭：释放 Rust 端记录的指纹 */
  close: (path: string) => invoke<void>("fs_close", { path }),
  /** 原子保存 + 冲突检测；失败时 Err message 形如 "CONFLICT:<mtime>:<hash>" */
  save: (
    path: string,
    content: string,
    expectedMtime?: number,
    force?: boolean,
  ) =>
    invoke<FileSig>("fs_save", { path, content, expectedMtime, force }),
  /** 新建：若已存在直接 Err "ALREADY_EXISTS:<path>" */
  createNew: (path: string, content: string) =>
    invoke<FileSig>("fs_create_new", { path, content }),

  rename: (from: string, to: string) =>
    invoke<void>("fs_rename", { from, to }),
  remove: (path: string) => invoke<void>("fs_delete", { path }),
  mkdir: (path: string) => invoke<void>("fs_mkdir", { path }),
  grep: (root: string, query: string, max = 80) =>
    invoke<GrepHit[]>("fs_grep", { root, query, max }),
  reveal: (path: string) => invoke<void>("fs_reveal", { path }),

  listAttachments: (workspace: string, max = 200) =>
    invoke<Attachment[]>("fs_list_attachments", { workspace, max }),

  pasteImage: (req: {
    workspace: string;
    note: string;
    fileName?: string;
    mime: string;
    dataBase64: string;
    upload: boolean;
    keepLocal: boolean;
    endpoint?: string;
  }) => invoke<PasteImageResult>("image_paste", { req }),

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

  // 系统钥匙串
  secretSet: (account: string, value: string) =>
    invoke<void>("secret_set", { account, value }),
  secretGet: (account: string) =>
    invoke<string | null>("secret_get", { account }),
  secretHas: (account: string) => invoke<boolean>("secret_has", { account }),
  secretDelete: (account: string) =>
    invoke<void>("secret_delete", { account }),

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

  /** 关键词检索：从仓库里抽 query 相关片段（含周边 ±3 行）作 AI 上下文 */
  aiRetrieve: (workspace: string, query: string, k = 5) =>
    invoke<
      Array<{ path: string; name: string; line: number; snippet: string }>
    >("ai_retrieve", { workspace, query, k }),

  // 兼容别名：旧代码里直接 readText/writeText 的地方挂上来
  readText: (path: string) =>
    invoke<OpenedFile>("fs_open", { path }).then((o) => o.content),
  writeText: (path: string, content: string) =>
    invoke<FileSig>("fs_save", { path, content }).then(() => undefined),
};
