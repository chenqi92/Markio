import { useEffect } from "react";
import { AppShell } from "./components/layout/AppShell";
import { useUI } from "./stores/ui";
import { useTabs } from "./stores/tabs";
import { useWorkspace } from "./stores/workspace";
import { useSettings } from "./stores/settings";
import { useRag } from "./stores/rag";
import { useVaultIndex } from "./stores/vaultIndex";
import { useDialog } from "./stores/dialog";
import { isDarkTheme } from "./themes";
import { api, isDesktop, parseError, pickDirectory, pickFile } from "./lib/api";
import { startSyncScheduler, stopSyncScheduler } from "./lib/syncScheduler";
import { useCustomThemes } from "./stores/customThemes";
import { COMMANDS, type CommandId, matchesBinding } from "./lib/shortcuts";
import { useSession } from "./stores/session";
import { reportDiagnostic } from "./stores/diagnostics";
import { installNetworkListeners } from "./stores/network";
import { installLongTaskObserver } from "./lib/longTaskObserver";
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
  const confirmDialog = useDialog((s) => s.confirm);
  const promptDialog = useDialog((s) => s.prompt);

  useEffect(() => {
    startSyncScheduler(activeWorkspacePath);
    return () => stopSyncScheduler();
  }, [activeWorkspacePath]);

  // 系统网络状态监听：online/offline 事件 → useNetwork.online
  useEffect(() => installNetworkListeners(), []);

  // 本地性能观察器：?perf=1 或 window.__markioPerf=true 时，把长任务 / 慢 measure
  // 推到诊断面板。数据不出本机。
  useEffect(() => {
    const handle = installLongTaskObserver();
    return () => handle.disconnect();
  }, []);

  // 全局快捷键：根据 settings.globalShortcutShow 在 Rust 端注册 / 替换；
  // 改变设置后自动重新注册。空字符串注销。
  useEffect(() => {
    const apply = (binding: string) => {
      void api.setGlobalShortcut(binding).catch(() => undefined);
    };
    apply(useSettings.getState().globalShortcutShow);
    const unsub = useSettings.subscribe((state, prev) => {
      if (state.globalShortcutShow !== prev.globalShortcutShow) {
        apply(state.globalShortcutShow);
      }
    });
    return () => unsub();
  }, []);

  // 自定义 CSS 主题：加载列表并应用记住的那一套
  useEffect(() => {
    void (async () => {
      await useCustomThemes.getState().refresh();
      const id = useSettings.getState().customThemeId;
      if (id) await useCustomThemes.getState().apply(id);
    })();
  }, []);

  // 崩溃上报：启动 5s 后 flush 上次 panic 留下的 pending 摘要到用户 webhook。
  // URL 为空（未配置）则后端直接 no-op；失败时保留 pending 等下次再试。
  useEffect(() => {
    const url = useSettings.getState().crashWebhookUrl;
    if (!url) return;
    const t = window.setTimeout(() => {
      void api.crashFlushToWebhook(url).catch((err) => {
        reportDiagnostic({
          source: "crash",
          severity: "warning",
          message: "崩溃摘要上报失败",
          detail: err,
        });
      });
    }, 5_000);
    return () => window.clearTimeout(t);
  }, []);

  // 应用更新：启动 20s 后静默检查一次（避开首屏 / 仓库 hydrate 高峰）。
  // 检查到新版本仅弹 toast 提示，不自动下载、不打断用户。
  useEffect(() => {
    if (!useSettings.getState().autoCheckUpdates) return;
    let cancelled = false;
    const t = window.setTimeout(async () => {
      if (cancelled) return;
      try {
        const { check } = await import("@tauri-apps/plugin-updater");
        const u = await check();
        if (!u || cancelled) return;
        useUI.getState().setToast({
          stage: "done",
          message: `发现新版本 ${u.version} · 设置 → 关于 中安装`,
        });
        window.setTimeout(() => {
          const cur = useUI.getState().toast;
          if (cur && cur.message.includes(u.version)) {
            useUI.getState().setToast(null);
          }
        }, 8000);
      } catch {
        // 离线 / 校验失败：保持静默，下次启动再试
      }
    }, 20_000);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
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

  // 会话恢复：hydrate 后等 workspace 注册到 Rust，逐个 openPath 上次打开的文件。
  // 同时订阅 tabs 变化，写回 session（节流 500ms）。崩溃 / 强退后下次启动恢复现场。
  useEffect(() => {
    let cancelled = false;
    const restoreTimer = window.setTimeout(async () => {
      if (cancelled) return;
      const { openTabs, activePath } = useSession.getState();
      if (openTabs.length === 0) return;
      const known = new Set(
        useWorkspace.getState().workspaces.map((w) => w.id),
      );
      // 先恢复非激活的，再恢复激活的（让激活的成为最后一个 setActive 的对象）
      const ordered = [...openTabs].sort((a, b) =>
        a.path === activePath ? 1 : b.path === activePath ? -1 : 0,
      );
      for (const t of ordered) {
        if (cancelled) return;
        if (!known.has(t.workspaceId)) continue;
        try {
          await useTabs.getState().openPath(t.path);
        } catch {
          // 文件可能已被外部删除：跳过即可
        }
      }
    }, 600);

    // 订阅 tabs 变化把元信息写回 session
    let saveTimer: number | null = null;
    const unsubTabs = useTabs.subscribe((state) => {
      if (cancelled) return;
      if (saveTimer !== null) window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => {
        const tabs = state.tabs.map((t) => ({
          workspaceId: t.workspaceId,
          path: t.path,
          pinned: t.pinned,
        }));
        const active = state.activeId
          ? state.tabs.find((t) => t.id === state.activeId)?.path ?? null
          : null;
        useSession.getState().remember(tabs, active);
      }, 500);
    });

    return () => {
      cancelled = true;
      window.clearTimeout(restoreTimer);
      if (saveTimer !== null) window.clearTimeout(saveTimer);
      unsubTabs();
    };
  }, []);

  // 系统级"用 markio 打开"：双击 Finder / 文件管理器中的 .md，
  // 或 macOS Dock 拖入文件 → Rust 端 emit "open-from-os"，前端 openPath 打开。
  // 等到 hydrate 完成（workspaces 已注册）后再处理，否则 openPath 会失败。
  useEffect(() => {
    if (!isDesktop()) return;
    const queue: string[] = [];
    let ready = false;
    let unlisten: (() => void) | null = null;
    (async () => {
      unlisten = await listen<string>("open-from-os", (e) => {
        if (typeof e.payload !== "string") return;
        if (!ready) {
          queue.push(e.payload);
          return;
        }
        void useTabs.getState().openPath(e.payload);
      });
      // 给 hydrate 一点时间——workspace 列表注册到 Rust 后 openPath 才能通过 allowlist
      await new Promise((resolve) => setTimeout(resolve, 800));
      ready = true;
      for (const p of queue.splice(0)) {
        void useTabs.getState().openPath(p);
      }
    })();
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

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
    if (!isDesktop()) return;
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
        reportDiagnostic({
          source: "rag",
          severity: "warning",
          message: "RAG 状态订阅失败",
          detail: err,
        });
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
    if (!isDesktop()) return;
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
                .catch((err) => {
                  reportDiagnostic({
                    source: "watcher",
                    severity: "warning",
                    message: "文件变化后刷新目录失败",
                    detail: err,
                    workspace,
                  });
                });
            }
          }, 600);
          pendingRefresh.set(refreshKey, handle);
        });
      } catch (err) {
        console.warn("[fs-changed] subscribe failed", err);
        reportDiagnostic({
          source: "watcher",
          severity: "error",
          message: "文件监听订阅失败",
          detail: err,
        });
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
    if (!isDesktop()) return;
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
        void (async () => {
          const outcome = await saveActive();
          if (outcome === "ok") {
            setToast({ stage: "done", message: "已保存" });
            setTimeout(() => setToast(null), 1500);
          } else if (outcome === "conflict") {
            const force = await confirmDialog({
              title: "覆盖磁盘版本？",
              message: "文件已被外部修改。继续保存会覆盖磁盘版本。",
              confirmLabel: "覆盖保存",
              danger: true,
            });
            if (force) {
              const id = useTabs.getState().activeId;
              if (id) void useTabs.getState().saveTab(id, true);
            }
          }
        })();
      },
      "app.newNote": () => {
        (async () => {
          const ws = useWorkspace.getState().activeWorkspace();
          if (!ws) {
            setToast({ stage: "error", message: "请先打开一个仓库" });
            setTimeout(() => setToast(null), 2000);
            return;
          }
          const name = await promptDialog({
            title: "新建笔记",
            message: "输入文件名；未包含 .md 时会自动追加。",
            defaultValue: "未命名",
            confirmLabel: "创建",
          });
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
              const reuse = await confirmDialog({
                title: "文件已存在",
                message: `${fname} 已存在。要打开它吗？`,
                confirmLabel: "打开",
              });
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
        void (async () => {
          if (t && t.dirty) {
            const ok = await confirmDialog({
              title: "关闭未保存标签？",
              message: `${t.title} 还有未保存的修改。继续关闭会丢失。`,
              confirmLabel: "关闭",
              danger: true,
            });
            if (!ok) return;
          }
          closeTab(activeId);
        })();
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
      "app.blockMenu": () => {
        // 把菜单弹在当前光标位置（fall back 到窗口中心）
        import("./lib/editor-bridge").then(({ selectionCoords }) => {
          const c = selectionCoords();
          useUI.getState().setBlockMenuAt(
            c ? { x: c.x, y: c.y + 18 } : { x: window.innerWidth / 2, y: window.innerHeight / 2 },
          );
        });
      },
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
        useUI.getState().setBlockMenuAt(null);
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
    confirmDialog,
    promptDialog,
  ]);

  return <AppShell />;
}
