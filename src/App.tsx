import { useEffect } from "react";
import { AppShell } from "./components/layout/AppShell";
import { useUI } from "./stores/ui";
import { useTabs } from "./stores/tabs";
import { useWorkspace } from "./stores/workspace";
import { useSettings } from "./stores/settings";
import { isDarkTheme } from "./themes";
import { api, pickDirectory, pickFile } from "./lib/api";

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
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
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
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        openCommand(true);
      } else if (mod && e.shiftKey && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        useUI.getState().openGlobalSearch(true);
      } else if (mod && (e.key === "p" || e.key === "P")) {
        e.preventDefault();
        openCommand(true);
      } else if (mod && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        openFind(true);
      } else if (mod && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        if (activeDirty) {
          saveActive().then(() => {
            setToast({ stage: "done", message: "已保存" });
            setTimeout(() => setToast(null), 1500);
          });
        }
      } else if (mod && (e.key === "n" || e.key === "N")) {
        e.preventDefault();
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
            await api.writeText(
              path,
              `# ${fname.replace(/\.md$/i, "")}\n\n`,
            );
            await useWorkspace.getState().refreshTree(ws.id);
            await useTabs.getState().openFile(ws.id, path);
          } catch (err) {
            setToast({
              stage: "error",
              message: `创建失败：${(err as Error).message}`,
            });
            setTimeout(() => setToast(null), 2500);
          }
        })();
      } else if (mod && e.shiftKey && (e.key === "o" || e.key === "O")) {
        e.preventDefault();
        pickDirectory().then((dir) => {
          if (dir) addWorkspace(dir);
        });
      } else if (mod && (e.key === "o" || e.key === "O")) {
        e.preventDefault();
        pickFile([
          { name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd"] },
        ]).then((f) => {
          if (f) openPath(f);
        });
      } else if (mod && (e.key === "j" || e.key === "J")) {
        e.preventDefault();
        useUI.getState().openAi(!useUI.getState().aiOpen);
      } else if (mod && (e.key === "e" || e.key === "E")) {
        e.preventDefault();
        (async () => {
          const tab = useTabs.getState().activeTab();
          if (!tab) return;
          try {
            const { exportPdf } = await import("./lib/export");
            await exportPdf(tab.title, tab.content);
          } catch (err) {
            setToast({
              stage: "error",
              message: `导出失败：${(err as Error).message}`,
            });
            setTimeout(() => setToast(null), 2500);
          }
        })();
      } else if (mod && (e.key === "," || e.key === "<")) {
        e.preventDefault();
        openSettings(true);
      } else if (mod && (e.key === "y" || e.key === "Y")) {
        e.preventDefault();
        useUI.getState().openHistory(!useUI.getState().historyOpen);
      } else if (mod && (e.key === "w" || e.key === "W")) {
        e.preventDefault();
        if (activeId) {
          const t = useTabs.getState().tabs.find((x) => x.id === activeId);
          if (t && t.dirty) {
            const ok = window.confirm(
              `${t.title} 还有未保存的修改。继续关闭会丢失。`,
            );
            if (!ok) return;
          }
          closeTab(activeId);
        }
      } else if (mod && e.key === ".") {
        e.preventDefault();
        toggleFocus();
      } else if (mod && e.shiftKey && (e.key === "l" || e.key === "L")) {
        e.preventDefault();
        toggleSidebar();
      } else if (mod && e.shiftKey && (e.key === "r" || e.key === "R")) {
        e.preventDefault();
        toggleOutline();
      } else if (mod && e.key === "1") {
        e.preventDefault();
        setMode("source");
      } else if (mod && e.key === "2") {
        e.preventDefault();
        setMode("split");
      } else if (mod && e.key === "3") {
        e.preventDefault();
        setMode("wysiwyg");
      } else if (mod && e.key === "4") {
        e.preventDefault();
        setMode("preview");
      } else if (e.key === "Escape") {
        openCommand(false);
        openFind(false);
        openSettings(false);
        useUI.getState().openAi(false);
        useUI.getState().openWechat(false);
        useUI.getState().openHistory(false);
        useUI.getState().openGlobalSearch(false);
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
