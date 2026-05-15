import { useEffect } from "react";
import { AppShell } from "./components/layout/AppShell";
import { useUI } from "./stores/ui";
import { useTabs } from "./stores/tabs";
import { useWorkspace } from "./stores/workspace";
import { useSettings } from "./stores/settings";
import { useRag } from "./stores/rag";
import { useVaultIndex } from "./stores/vaultIndex";
import { isDarkTheme } from "./themes";
import { api, parseError, pickDirectory, pickFile } from "./lib/api";
import { startSyncScheduler, stopSyncScheduler } from "./lib/syncScheduler";
import { useCustomThemes } from "./stores/customThemes";
import { COMMANDS, type CommandId, matchesBinding } from "./lib/shortcuts";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";

function isTreeRefreshRelevant(path: string): boolean {
  if (/\.(md|markdown|mdown|mkd|txt)$/i.test(path)) return true;
  const name = path.split(/[\\/]/).pop() ?? "";
  return !name.includes(".");
}

function parentPath(workspace: string, path: string): string {
  const normalizedWorkspace = workspace.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedPath = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const parent = normalizedPath.replace(/\/[^/]+$/, "");
  return parent.startsWith(normalizedWorkspace) ? parent : normalizedWorkspace;
}

function treeRefreshDir(
  workspace: string,
  path: string,
  kind: "modified" | "created" | "removed",
): string {
  if (/\.(md|markdown|mdown|mkd|txt)$/i.test(path)) {
    return parentPath(workspace, path);
  }
  return kind === "modified" ? path : parentPath(workspace, path);
}

const FS_RAG_DELAY_MS = 2_000;
const FS_EVENT_STARTUP_GRACE_MS = 8_000;
const appStartedAt = Date.now();
const fsRagTimers = new Map<string, ReturnType<typeof setTimeout>>();

function isRagFile(path: string): boolean {
  return /\.(md|markdown|mdown|mkd)$/i.test(path);
}

function scheduleRagForFsEvent(
  workspace: string,
  path: string,
  kind: "modified" | "created" | "removed",
) {
  if (!isRagFile(path)) return;
  const key = `${workspace}\0${path}`;
  const current = fsRagTimers.get(key);
  if (current) clearTimeout(current);
  const timer = setTimeout(() => {
    fsRagTimers.delete(key);
    const settings = useSettings.getState();
    if (!settings.ragEnabled || !settings.ragAutoReindexOnSave) return;
    const rag = useRag.getState();
    if (kind === "removed") {
      void rag.removeFile(workspace, path);
    } else {
      void rag.reindexFile(workspace, path);
    }
  }, FS_RAG_DELAY_MS);
  fsRagTimers.set(key, timer);
}

export default function App() {
  const openCommand = useUI((s) => s.openCommand);
  const openFind = useUI((s) => s.openFind);
  const openSettings = useUI((s) => s.openSettings);
  const setMode = useUI((s) => s.setMode);
  const toggleSidebar = useUI((s) => s.toggleSidebar);
  const toggleOutline = useUI((s) => s.toggleOutline);
  const toggleFocus = useUI((s) => s.toggleFocus);
  const saveActive = useTabs((s) => s.saveActive);
  const closeTab = useTabs((s) => s.closeTab);
  const openPath = useTabs((s) => s.openPath);
  const addWorkspace = useWorkspace((s) => s.addWorkspace);
  const setToast = useUI((s) => s.setToast);
  const activeId = useTabs((s) => s.activeId);
  const activeDirty = useTabs((s) => s.activeTab()?.dirty ?? false);
  const followSystem = useSettings((s) => s.followSystemTheme);
  const theme = useSettings((s) => s.theme);
  const setTheme = useSettings((s) => s.setTheme);
  const darkVariant = useSettings((s) => s.darkVariant);
  const lightVariant = useSettings((s) => s.lightVariant);
  const hydrate = useWorkspace((s) => s.hydrate);
  const setAi = useSettings((s) => s.setAi);
  const activeWorkspacePath = useWorkspace((s) => s.activeWorkspace()?.path ?? null);

  useEffect(() => {
    startSyncScheduler(activeWorkspacePath);
    return () => stopSyncScheduler();
  }, [activeWorkspacePath]);

  // 自定义 CSS 主题：加载列表并应用记住的那一套
  useEffect(() => {
    void (async () => {
      await useCustomThemes.getState().refresh();
      const id = useSettings.getState().customThemeId;
      if (id) await useCustomThemes.getState().apply(id);
    })();
  }, []);

  // App 启动时把 localStorage 里的仓库列表 / AI 配置状态同步到 Rust
  useEffect(() => {
    hydrate();
    (async () => {
      try {
        const provider = useSettings.getState().aiProvider;
        const has = await api.secretHas(`ai:${provider}`);
        setAi({ aiKeyConfigured: has });
      } catch {
        /* ignore */
      }
    })();
  }, [hydrate, setAi]);

  // 当前仓库切换后，后台拉起 vault index（先用 disk cache 立刻有数据，再 mtime diff）
  useEffect(() => {
    if (!activeWorkspacePath) return;
    const t = setTimeout(() => {
      void useVaultIndex.getState().ensure(activeWorkspacePath);
    }, 200);
    return () => clearTimeout(t);
  }, [activeWorkspacePath]);

  // 全局订阅 rag-status：把后端推送的进度 / 索引快照写入 useRag.status
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        unlisten = await listen<import("./lib/api").RagStatus>(
          "rag-status",
          (e) => {
            const payload = e.payload;
            const ws = useWorkspace
              .getState()
              .workspaces.find((w) => {
                const a = w.path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
                const b = payload.workspace
                  .replace(/\\/g, "/")
                  .replace(/\/+$/, "")
                  .toLowerCase();
                return a === b;
              });
            if (!ws) return;
            useRag.setState((s) => ({
              status: { ...s.status, [ws.id]: payload },
            }));
          },
        );
      } catch (err) {
        console.warn("[rag-status] subscribe failed", err);
      }
    })();
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // 当前仓库切换 + ragEnabled 时刷新一次 RAG 状态（让 AI 面板 CTA 立即可见）
  useEffect(() => {
    if (!activeWorkspacePath) return;
    const ws = useWorkspace
      .getState()
      .workspaces.find((w) => w.path === activeWorkspacePath);
    if (!ws) return;
    if (!useSettings.getState().ragEnabled) return;
    void useRag.getState().refresh(ws.id, ws.path);
  }, [activeWorkspacePath]);

  // Rust watcher 触发的文件系统变动 → 节流刷新文件树
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    const pendingRefresh: Map<string, ReturnType<typeof setTimeout>> = new Map();
    (async () => {
      try {
        unlisten = await listen<{
          workspace: string;
          path: string;
          kind: "modified" | "created" | "removed";
        }>("fs-changed", (e) => {
          const { workspace, path, kind } = e.payload;
          if (!isTreeRefreshRelevant(path)) return;
          if (Date.now() - appStartedAt < FS_EVENT_STARTUP_GRACE_MS) return;
          scheduleRagForFsEvent(workspace, path, kind);
          if (isRagFile(path)) {
            useVaultIndex.getState().scheduleRebuild(workspace);
          }
          const targetDir = treeRefreshDir(workspace, path, kind);
          const refreshKey = `${workspace}\0${targetDir}`;
          // 同一个目录 1s 内只刷一次
          if (pendingRefresh.has(refreshKey)) return;
          const handle = setTimeout(() => {
            pendingRefresh.delete(refreshKey);
            const ws = useWorkspace
              .getState()
              .workspaces.find((w) => w.path === workspace);
            if (ws) {
              useWorkspace
                .getState()
                .loadDir(ws.id, targetDir)
                .catch(() => undefined);
            }
          }, 600);
          pendingRefresh.set(refreshKey, handle);
        });
      } catch (err) {
        console.warn("[fs-changed] subscribe failed", err);
      }
    })();
    return () => {
      pendingRefresh.forEach(clearTimeout);
      pendingRefresh.clear();
      fsRagTimers.forEach(clearTimeout);
      fsRagTimers.clear();
      if (unlisten) unlisten();
    };
  }, []);

  // 跟随系统亮 / 暗
  useEffect(() => {
    if (!followSystem || typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const want = mq.matches ? darkVariant : lightVariant;
      if (want && want !== theme) setTheme(want);
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [followSystem, darkVariant, lightVariant, theme, setTheme]);

  useEffect(() => {
    // dark / light 切换时同步给 native macOS appearance（用于状态栏图标等）
    const isDark = isDarkTheme(theme);
    document.documentElement.style.colorScheme = isDark ? "dark" : "light";
  }, [theme]);

  // 把 .md 文件 / 文件夹拖到窗口上时自动打开
  useEffect(() => {
    let dispose: (() => void) | undefined;
    (async () => {
      try {
        const unlisten = await getCurrentWindow().onDragDropEvent(async (e) => {
          if (e.payload.type !== "drop") return;
          const paths = e.payload.paths;
          if (!paths || paths.length === 0) return;
          for (const p of paths) {
            // 用文件扩展简单判定，目录拿到的路径无扩展，进入 addWorkspace 兜底
            if (/\.(md|markdown|mdown|mkd)$/i.test(p)) {
              await useTabs.getState().openPath(p);
            } else {
              try {
                await useWorkspace.getState().addWorkspace(p);
              } catch {
                /* 忽略非目录或不可读 */
              }
            }
          }
        });
        dispose = unlisten;
      } catch {
        /* not in tauri */
      }
    })();
    return () => dispose?.();
  }, []);

  useEffect(() => {
    const handlers: Record<CommandId, () => void> = {
      "app.commandPalette": () => openCommand(true),
      "app.commandPaletteP": () => openCommand(true),
      "app.globalSearch": () => useUI.getState().openGlobalSearch(true),
      "app.findInFile": () => openFind(true),
      "app.save": () => {
        if (!activeDirty) return;
        saveActive().then((outcome) => {
          if (outcome === "ok") {
            setToast({ stage: "done", message: "已保存" });
            setTimeout(() => setToast(null), 1500);
          } else if (outcome === "conflict") {
            const force = window.confirm(
              "文件已被外部修改。继续保存会覆盖磁盘版本。点确认覆盖，取消则放弃保存。",
            );
            if (force) {
              const id = useTabs.getState().activeId;
              if (id) useTabs.getState().saveTab(id, true);
            }
          }
        });
      },
      "app.newNote": () => {
        (async () => {
          const ws = useWorkspace.getState().activeWorkspace();
          if (!ws) {
            setToast({ stage: "error", message: "请先打开一个仓库" });
            setTimeout(() => setToast(null), 2000);
            return;
          }
          const name = window.prompt("新笔记文件名（自动追加 .md）", "未命名");
          if (!name) return;
          const fname = name.endsWith(".md") ? name : `${name}.md`;
          const path = `${ws.path}/${fname}`;
          try {
            await api.createNew(path, `# ${fname.replace(/\.md$/i, "")}\n\n`);
            await useWorkspace.getState().refreshTree(ws.id);
            await useTabs.getState().openFile(ws.id, path);
          } catch (err) {
            const e2 = parseError(err);
            if (e2.code === "ALREADY_EXISTS") {
              const reuse = window.confirm(`${fname} 已存在。打开它？`);
              if (reuse) {
                await useTabs.getState().openFile(ws.id, path);
              }
            } else {
              setToast({
                stage: "error",
                message: `创建失败：${e2.message}`,
              });
              setTimeout(() => setToast(null), 2500);
            }
          }
        })();
      },
      "app.openFile": () => {
        pickFile([
          { name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd"] },
        ]).then((f) => {
          if (f) openPath(f);
        });
      },
      "app.openFolder": () => {
        pickDirectory().then((dir) => {
          if (dir) addWorkspace(dir);
        });
      },
      "app.toggleAi": () => useUI.getState().openAi(!useUI.getState().aiOpen),
      "app.openExport": () => {
        const tab = useTabs.getState().activeTab();
        if (tab) useUI.getState().openExportSheet(true);
      },
      "app.openSettings": () => openSettings(true),
      "app.toggleHistory": () =>
        useUI.getState().openHistory(!useUI.getState().historyOpen),
      "app.closeTab": () => {
        if (!activeId) return;
        const t = useTabs.getState().tabs.find((x) => x.id === activeId);
        if (t && t.dirty) {
          const ok = window.confirm(
            `${t.title} 还有未保存的修改。继续关闭会丢失。`,
          );
          if (!ok) return;
        }
        closeTab(activeId);
      },
      "app.toggleFocus": toggleFocus,
      "app.toggleSidebar": toggleSidebar,
      "app.toggleOutline": toggleOutline,
      "app.viewSource": () => setMode("source"),
      "app.viewSplit": () => setMode("split"),
      "app.viewWysiwyg": () => setMode("wysiwyg"),
      "app.viewPreview": () => setMode("preview"),
      "app.quickCapture": () =>
        useUI.getState().openQuickCapture(!useUI.getState().quickCaptureOpen),
      "app.escape": () => {
        openCommand(false);
        openFind(false);
        openSettings(false);
        useUI.getState().openAi(false);
        useUI.getState().openWechat(false);
        useUI.getState().openHistory(false);
        useUI.getState().openGlobalSearch(false);
        useUI.getState().openQuickCapture(false);
        useUI.getState().openExportSheet(false);
      },
    };

    const onKey = (e: KeyboardEvent) => {
      const overrides = useSettings.getState().shortcutOverrides;
      for (const cmd of COMMANDS) {
        const override = overrides[cmd.id];
        const binding = override !== undefined ? override : cmd.defaultBinding;
        if (!binding) continue;
        if (!matchesBinding(e, binding)) continue;
        // Escape 不 preventDefault（让其它输入框能正常处理），其它命令都拦截
        if (cmd.id !== "app.escape") e.preventDefault();
        handlers[cmd.id]();
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    openCommand,
    openFind,
    openSettings,
    saveActive,
    setMode,
    toggleSidebar,
    toggleOutline,
    toggleFocus,
    closeTab,
    activeId,
    activeDirty,
    openPath,
    addWorkspace,
    setToast,
  ]);

  return <AppShell />;
}
