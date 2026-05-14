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
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

const isTauri = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new Error(
      `Tauri 命令 \`${cmd}\` 仅在桌面端可用。请通过 \`pnpm tauri:dev\` 启动。`,
    );
  }
  return tauriInvoke<T>(cmd, args);
}

export async function pickDirectory(): Promise<string | null> {
  if (!isTauri()) return null;
  const selected = await openDialog({ directory: true, multiple: false });
  if (typeof selected === "string") return selected;
  return null;
}

export async function pickFile(
  filters?: { name: string; extensions: string[] }[],
): Promise<string | null> {
  if (!isTauri()) return null;
  const selected = await openDialog({ multiple: false, filters });
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

export type RagProvider = "ollama" | "openai";
export interface RagEmbedConfig {
  provider: RagProvider;
  model: string;
  dim: number;
  baseUrl?: string;
  apiKey?: string;
}

export interface RagIndexProgress {
  running: boolean;
  processed: number;
  total: number;
  currentFile?: string | null;
  lastError?: string | null;
}

export interface RagStatus {
  workspace: string;
  totalDocs: number;
  totalChunks: number;
  indexedAt?: number | null;
  embeddingModel?: string | null;
  embeddingProvider?: string | null;
  embeddingDim?: number | null;
  dbSize: number;
  progress?: RagIndexProgress | null;
}

export interface RagHit {
  path: string;
  heading: string;
  body: string;
  score: number;
  source: string;
  charStart: number;
  charEnd: number;
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

  /**
   * 流式渲染（按 H1 切片）。> 30KB 文档可显著降低首屏延迟。
   * 返回 cleanup 函数；调用方负责在组件卸载时调用。
   */
  renderMarkdownStream: async (
    source: string,
    basePath: string | undefined,
    handlers: {
      onChunk: (index: number, html: string) => void;
      onDone: (info: {
        outline: OutlineItem[];
        words: number;
        readingMinutes: number;
      }) => void;
      onError?: (message: string) => void;
    },
  ): Promise<() => void> => {
    const streamId = `md${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
    const channel = `md-stream-${streamId}`;
    let unlisten: UnlistenFn | null = null;
    let finished = false;
    const cleanup = () => {
      const shouldCancel = !finished;
      if (unlisten) {
        unlisten();
        unlisten = null;
      }
      if (shouldCancel) {
        void invoke<void>("md_cancel_stream", { streamId }).catch(() => undefined);
      }
    };
    unlisten = await listen<
      | { event: "chunk"; index: number; html: string }
      | { event: "done"; outline: OutlineItem[]; words: number; readingMinutes: number }
      | { event: "error"; message: string }
    >(channel, (e) => {
      if (finished) return;
      const p = e.payload;
      if (p.event === "chunk") {
        handlers.onChunk(p.index, p.html);
      } else if (p.event === "done") {
        finished = true;
        handlers.onDone({
          outline: p.outline,
          words: p.words,
          readingMinutes: p.readingMinutes,
        });
        cleanup();
      } else if (p.event === "error") {
        finished = true;
        handlers.onError?.(p.message);
        cleanup();
      }
    });
    try {
      await invoke<void>("md_render_stream", {
        streamId,
        source,
        basePath,
      });
    } catch (err) {
      finished = true;
      cleanup();
      handlers.onError?.(String(err));
    }
    return cleanup;
  },

  outline: (source: string) => invoke<OutlineItem[]>("md_outline", { source }),

  // workspace 注册
  workspaceRegister: (path: string) =>
    invoke<string>("workspace_register", { path }),
  workspaceUnregister: (path: string) =>
    invoke<string>("workspace_unregister", { path }),

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

  exportPandoc: (source: string, format: "epub" | "docx" | "rtf" | "odt", destPath: string) =>
    invoke<void>("export_pandoc", { source, format, destPath }),

  // 崩溃 / 错误日志（本地写入，不上传）
  crashAppend: (payload: string) => invoke<void>("crash_append", { payload }),
  crashOpenDir: () => invoke<void>("crash_open_dir"),
  crashReadLatest: () => invoke<string>("crash_read_latest"),

  textFindRanges: (
    text: string,
    pattern: string,
    options?: {
      caseInsensitive?: boolean;
      wholeWord?: boolean;
      regex?: boolean;
      maxMatches?: number;
    },
  ) => invoke<Array<[number, number]>>("text_find_ranges", { text, pattern, options }),

  pasteImage: (req: {
    workspace: string;
    note: string;
    fileName?: string;
    mime: string;
    dataBase64: string;
    upload: boolean;
    keepLocal: boolean;
    endpoint?: string;
    compress?: boolean;
    quality?: number;
  }) => invoke<PasteImageResult>("image_paste", { req }),

  historySave: (workspace: string, file: string, content: string) =>
    invoke<void>("history_save", { workspace, file, content }),
  historyList: (workspace: string, file: string) =>
    invoke<Snapshot[]>("history_list", { workspace, file }),
  historyRead: (path: string) => invoke<string>("history_read", { path }),

  backlinks: (workspace: string, file: string, max = 50) =>
    invoke<Backlink[]>("fs_backlinks", { workspace, file, max }),
  mentions: (workspace: string, file: string, max = 50) =>
    invoke<Backlink[]>("fs_mentions", { workspace, file, max }),
  indexTokens: (workspace: string) =>
    invoke<{ tags: string[]; mentions: string[]; files: string[] }>(
      "fs_index_tokens",
      { workspace },
    ),

  themeList: () =>
    invoke<Array<{ id: string; name: string; path: string; size: number }>>(
      "theme_list",
    ),
  themeImport: (sourcePath: string) =>
    invoke<{ id: string; name: string; path: string; size: number }>(
      "theme_import",
      { sourcePath },
    ),
  themeRead: (id: string) => invoke<string>("theme_read", { id }),
  themeDelete: (id: string) => invoke<void>("theme_delete", { id }),
  themeDirPath: () => invoke<string>("theme_dir_path"),

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
  secretHas: (account: string) => invoke<boolean>("secret_has", { account }),
  secretDelete: (account: string) =>
    invoke<void>("secret_delete", { account }),

  aiChatStream: async (
    req: {
      provider: string;
      apiKey?: string;
      endpoint?: string;
      model: string;
      maxTokens?: number;
      temperature?: number;
      system?: string;
      messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
    },
    handlers: {
      onChunk: (delta: string) => void;
      onDone: (info: {
        inputTokens?: number;
        outputTokens?: number;
        model?: string;
      }) => void;
      onError: (message: string) => void;
    },
  ): Promise<{ streamId: string; cancel: () => Promise<void> }> => {
    const streamId = `s${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
    const channel = `ai-stream-${streamId}`;
    let unlisten: UnlistenFn | null = null;
    let finished = false;
    const cleanup = () => {
      if (unlisten) {
        unlisten();
        unlisten = null;
      }
    };
    unlisten = await listen<
      | { event: "chunk"; delta: string }
      | {
          event: "done";
          inputTokens?: number;
          outputTokens?: number;
          model?: string;
        }
      | { event: "error"; message: string }
    >(channel, (e) => {
      if (finished) return;
      const p = e.payload;
      if (p.event === "chunk") {
        handlers.onChunk(p.delta);
      } else if (p.event === "done") {
        finished = true;
        handlers.onDone({
          inputTokens: p.inputTokens,
          outputTokens: p.outputTokens,
          model: p.model,
        });
        cleanup();
      } else if (p.event === "error") {
        finished = true;
        handlers.onError(p.message);
        cleanup();
      }
    });
    try {
      await invoke<void>("ai_chat_stream", { streamId, req });
    } catch (err) {
      finished = true;
      cleanup();
      handlers.onError(String(err));
    }
    return {
      streamId,
      cancel: async () => {
        if (finished) return;
        finished = true;
        try {
          await invoke<void>("ai_chat_cancel", { streamId });
        } catch {
          /* ignore */
        }
        cleanup();
      },
    };
  },

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

  // Git 同步
  gitInit: (path: string) => invoke<void>("git_init", { path }),
  gitClone: (url: string, dest: string, pat?: string) =>
    invoke<void>("git_clone", { url, dest, pat }),
  gitStatus: (workspace: string) =>
    invoke<{
      head?: string;
      branch?: string;
      upstream?: string;
      ahead: number;
      behind: number;
      files: Array<{ path: string; kind: string }>;
    }>("git_status", { workspace }),
  gitFetch: (workspace: string, opts?: { remote?: string; pat?: string }) =>
    invoke<void>("git_fetch", {
      workspace,
      remote: opts?.remote,
      pat: opts?.pat,
    }),
  gitCommit: (
    workspace: string,
    message: string,
    authorName: string,
    authorEmail: string,
    files?: string[],
  ) =>
    invoke<string>("git_commit", {
      workspace,
      message,
      authorName,
      authorEmail,
      files,
    }),
  gitPull: (
    workspace: string,
    opts?: { remote?: string; branch?: string; rebase?: boolean; pat?: string },
  ) =>
    invoke<[number, number]>("git_pull", {
      workspace,
      remote: opts?.remote,
      branch: opts?.branch,
      rebase: opts?.rebase,
      pat: opts?.pat,
    }),
  gitPush: (
    workspace: string,
    opts?: {
      remote?: string;
      branch?: string;
      setUpstream?: boolean;
      pat?: string;
    },
  ) =>
    invoke<void>("git_push", {
      workspace,
      remote: opts?.remote,
      branch: opts?.branch,
      setUpstream: opts?.setUpstream,
      pat: opts?.pat,
    }),
  gitListBranches: (workspace: string) =>
    invoke<{ current?: string; local: string[]; remote: string[] }>(
      "git_list_branches",
      { workspace },
    ),
  gitCheckout: (workspace: string, branch: string, create = false) =>
    invoke<void>("git_checkout", { workspace, branch, create }),
  gitResolveConflict: (
    workspace: string,
    strategy: "ours" | "theirs" | "abort",
    files: string[],
  ) =>
    invoke<void>("git_resolve_conflict", { workspace, strategy, files }),
  gitSetPat: (url: string, pat: string) =>
    invoke<void>("git_set_pat", { url, pat }),
  gitHasPat: (url: string) => invoke<boolean>("git_has_pat", { url }),

  // WebDAV
  webdavTest: (baseUrl: string, auth: { username: string; password: string }) =>
    invoke<void>("webdav_test", { baseUrl, auth }),
  webdavList: (
    baseUrl: string,
    auth: { username: string; password: string },
    path: string,
  ) =>
    invoke<
      Array<{
        href: string;
        isDir: boolean;
        relPath: string;
        size: number;
        lastModified: string;
      }>
    >("webdav_list", { baseUrl, auth, path }),
  webdavPut: (
    baseUrl: string,
    auth: { username: string; password: string },
    relPath: string,
    bodyBase64: string,
  ) => invoke<void>("webdav_put", { baseUrl, auth, relPath, bodyBase64 }),
  webdavGet: (
    baseUrl: string,
    auth: { username: string; password: string },
    relPath: string,
  ) => invoke<string>("webdav_get", { baseUrl, auth, relPath }),
  webdavDelete: (
    baseUrl: string,
    auth: { username: string; password: string },
    relPath: string,
  ) => invoke<void>("webdav_delete", { baseUrl, auth, relPath }),
  webdavMkcol: (
    baseUrl: string,
    auth: { username: string; password: string },
    relPath: string,
  ) => invoke<void>("webdav_mkcol", { baseUrl, auth, relPath }),
  webdavSetPassword: (baseUrl: string, password: string) =>
    invoke<void>("webdav_set_password", { baseUrl, password }),
  webdavHasPassword: (baseUrl: string) =>
    invoke<boolean>("webdav_has_password", { baseUrl }),

  // S3 兼容上传
  s3PutObject: (
    cfg: {
      endpoint: string;
      region: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
      publicBaseUrl?: string;
      pathStyle?: boolean;
    },
    key: string,
    bodyBase64: string,
    contentType: string,
  ) => invoke<string>("s3_put_object", { cfg, key, bodyBase64, contentType }),
  s3SetSecret: (endpoint: string, secretAccessKey: string) =>
    invoke<void>("s3_set_secret", { endpoint, secretAccessKey }),
  s3HasSecret: (endpoint: string) =>
    invoke<boolean>("s3_has_secret", { endpoint }),

  // 第三方笔记导入
  importRun: (
    provider: "notion" | "obsidian" | "bear" | "evernote",
    source: string,
    workspace: string,
  ) =>
    invoke<{
      provider: string;
      dest: string;
      files: number;
      warnings: string[];
    }>("import_run", { provider, source, workspace }),

  // RAG 向量索引 / 混合检索
  ragStatus: (workspace: string) =>
    invoke<RagStatus>("rag_status", { workspace }),
  ragReindex: (workspace: string, config: RagEmbedConfig) =>
    invoke<void>("rag_reindex", { req: { workspace, config } }),
  ragReindexFile: (workspace: string, path: string, config: RagEmbedConfig) =>
    invoke<void>("rag_reindex_file", { req: { workspace, path, config } }),
  ragRemoveFile: (workspace: string, path: string) =>
    invoke<void>("rag_remove_file", { workspace, path }),
  ragSearch: (req: {
    workspace: string;
    query: string;
    limit?: number;
    expandLinks?: boolean;
    config: RagEmbedConfig;
    rerank?: {
      provider: "cohere";
      model: string;
      baseUrl?: string;
      apiKey?: string;
    };
  }) => invoke<RagHit[]>("rag_search", { req }),
  ragClear: (workspace: string) =>
    invoke<void>("rag_clear", { workspace }),
  ragRepoGraph: (workspace: string) =>
    invoke<{
      nodes: Array<{
        id: number;
        path: string;
        inDegree: number;
        outDegree: number;
      }>;
      edges: Array<{ from: number; to: number }>;
    }>("rag_repo_graph", { workspace }),

  // 兼容别名：旧代码里直接 readText/writeText 的地方挂上来
  readText: (path: string) =>
    invoke<OpenedFile>("fs_open", { path }).then((o) => o.content),
  writeText: (path: string, content: string) =>
    invoke<FileSig>("fs_save", { path, content }).then(() => undefined),
};
