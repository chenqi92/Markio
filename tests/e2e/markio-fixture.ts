import type { Page } from "@playwright/test";

export const E2E_ROOT = "/e2e-vault";
export const E2E_DAILY_PATH = `${E2E_ROOT}/Daily.md`;

declare global {
  interface Window {
    __MARKIO_E2E__?: {
      pickDirectory?: () => string | null | Promise<string | null>;
      pickFile?: () => string | null | Promise<string | null>;
      invoke?: (cmd: string, args?: Record<string, unknown>) => unknown | Promise<unknown>;
    };
    __MARKIO_E2E_STATE__?: {
      root: string;
      conflictNextSave: boolean;
      files: Record<string, { content: string; mtime: number; hash: string }>;
      mutateFile(path: string, content: string): void;
      readFile(path: string): string | undefined;
    };
  }
}

export async function installMarkioE2E(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const root = "/e2e-vault";
    const dailyPath = `${root}/Daily.md`;
    const planPath = `${root}/Projects/Plan.md`;
    let clock = 1_700_000_000_000;
    const hash = (content: string) => `h${content.length}-${content.charCodeAt(0) || 0}`;
    const files: Record<string, { content: string; mtime: number; hash: string }> = {
      [dailyPath]: {
        content: "# Daily\n\nalpha note\nsearch token\n",
        mtime: clock,
        hash: hash("# Daily\n\nalpha note\nsearch token\n"),
      },
      [planPath]: {
        content: "# Plan\n\nproject search token\n",
        mtime: clock + 1,
        hash: hash("# Plan\n\nproject search token\n"),
      },
    };
    const updateFile = (path: string, content: string) => {
      clock += 1;
      files[path] = { content, mtime: clock, hash: hash(content) };
    };
    const fileEntry = (path: string) => {
      const name = path.split("/").pop() ?? path;
      const file = files[path];
      return {
        name,
        path,
        isDir: false,
        size: file.content.length,
        modified: file.mtime,
      };
    };
    const dirEntry = (path: string) => {
      if (path === `${root}/Projects`) {
        return {
          name: "Projects",
          path,
          isDir: true,
          size: 0,
          modified: clock,
          children: [fileEntry(planPath)],
        };
      }
      return {
        name: "e2e-vault",
        path: root,
        isDir: true,
        size: 0,
        modified: clock,
        children: [
          fileEntry(dailyPath),
          {
            name: "Projects",
            path: `${root}/Projects`,
            isDir: true,
            size: 0,
            modified: clock,
            children: [fileEntry(planPath)],
          },
        ],
      };
    };
    const renderMarkdown = (source: string) => {
      const escaped = source
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      const outline = source
        .split("\n")
        .map((line) => line.match(/^(#{1,6})\s+(.+)$/))
        .filter((match): match is RegExpMatchArray => Boolean(match))
        .map((match) => ({
          level: match[1].length,
          text: match[2],
          anchor: match[2].toLowerCase().replace(/\s+/g, "-"),
        }));
      return {
        html: `<pre>${escaped}</pre>`,
        outline,
        words: source.trim().length,
        readingMinutes: 1,
      };
    };
    window.__MARKIO_E2E_STATE__ = {
      root,
      conflictNextSave: false,
      files,
      mutateFile: updateFile,
      readFile: (path: string) => files[path]?.content,
    };
    window.__MARKIO_E2E__ = {
      pickDirectory: () => root,
      pickFile: () => dailyPath,
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        const state = window.__MARKIO_E2E_STATE__;
        if (!state) throw new Error("E2E state missing");
        if (cmd === "workspace_register") return args?.path;
        if (cmd === "workspace_unregister") return args?.path;
        if (cmd === "fs_read_dir" || cmd === "fs_read_tree") {
          return dirEntry(String(args?.path ?? root));
        }
        if (cmd === "fs_open") {
          const path = String(args?.path);
          const file = files[path];
          if (!file) throw new Error(`missing fixture file: ${path}`);
          return { path, content: file.content, sig: { mtime: file.mtime, hash: file.hash } };
        }
        if (cmd === "fs_save") {
          const path = String(args?.path);
          const content = String(args?.content ?? "");
          const force = Boolean(args?.force);
          const expectedHash =
            typeof args?.expectedHash === "string" && args.expectedHash.trim()
              ? args.expectedHash
              : undefined;
          const expectedMtime =
            typeof args?.expectedMtime === "number" ? args.expectedMtime : undefined;
          const file = files[path];
          if (!file) throw new Error(`missing fixture file: ${path}`);
          if (state.conflictNextSave && !force) {
            state.conflictNextSave = false;
            updateFile(path, `${file.content}\nexternal change\n`);
            const current = files[path];
            throw new Error(`CONFLICT:${current.mtime}:${current.hash}`);
          }
          if (!force && expectedHash && file.hash !== expectedHash) {
            throw new Error(`CONFLICT:${file.mtime}:${file.hash}`);
          }
          if (!force && !expectedHash && expectedMtime !== undefined && file.mtime !== expectedMtime) {
            throw new Error(`CONFLICT:${file.mtime}:${file.hash}`);
          }
          updateFile(path, content);
          const saved = files[path];
          return { mtime: saved.mtime, hash: saved.hash };
        }
        if (cmd === "fs_grep") {
          const query = String(args?.query ?? "").toLowerCase();
          const hits = Object.entries(files).flatMap(([path, file]) =>
            file.content
              .split("\n")
              .map((line, index) => ({ line, index }))
              .filter(({ line }) => line.toLowerCase().includes(query))
              .map(({ line, index }) => ({
                path,
                name: path.split("/").pop() ?? path,
                line: index + 1,
                preview: line,
              })),
          );
          return hits.slice(0, Number(args?.max ?? 80));
        }
        if (cmd === "md_render") return renderMarkdown(String(args?.source ?? ""));
        if (cmd === "md_outline") return renderMarkdown(String(args?.source ?? "")).outline;
        if (cmd === "fs_vault_index_load") return null;
        if (cmd === "fs_vault_index_build") {
          return {
            files: Object.entries(files).map(([path, file]) => ({
              path,
              name: path.split("/").pop() ?? path,
              stem: (path.split("/").pop() ?? path).replace(/\.md$/i, ""),
              mtime: file.mtime,
              size: file.content.length,
              tags: [],
              mentions: [],
            })),
            tags: [],
            mentions: [],
            scannedAt: Date.now(),
          };
        }
        if (cmd === "git_status") {
          return { branch: "main", upstream: "origin/main", ahead: 0, behind: 0, files: [] };
        }
        if (cmd === "watcher_health") return [];
        if (cmd === "fs_backlinks" || cmd === "fs_mentions") return [];
        if (cmd === "fs_list_attachments" || cmd === "fs_trash_list") return [];
        if (cmd === "secret_has") return false;
        return null;
      },
    };
    localStorage.setItem(
      "markio.settings.v1",
      JSON.stringify({
        state: {
          locale: "zh-CN",
          autosave: false,
          snapshotOnSave: false,
          autoSyncEnabled: false,
          autoCheckUpdates: false,
          showInTray: false,
        },
        version: 0,
      }),
    );
  });
}
