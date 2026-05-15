import { useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Icon } from "../ui/Icon";
import { useSettings } from "@/stores/settings";
import { useUI } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";
import { useTabs } from "@/stores/tabs";
import { isDarkTheme } from "@/themes";
import { shortcutText } from "@/lib/shortcuts";

/**
 * macOS 在 titleBarStyle: "Overlay" 模式下，需要靠 `data-tauri-drag-region` 把
 * 自绘标题栏标成可拖拽。但仅靠属性偶尔会失效，所以再叠一层 mousedown 兜底：
 * 命中标题栏时主动调用 `getCurrentWindow().startDragging()`。
 */
export function TitleBar() {
  const theme = useSettings((s) => s.theme);
  const setTheme = useSettings((s) => s.setTheme);
  const lightVariant = useSettings((s) => s.lightVariant);
  const darkVariant = useSettings((s) => s.darkVariant);
  const openSettings = useUI((s) => s.openSettings);
  const openQuickCapture = useUI((s) => s.openQuickCapture);
  const openAi = useUI((s) => s.openAi);
  const aiOpen = useUI((s) => s.aiOpen);
  const setToast = useUI((s) => s.setToast);
  const ws = useWorkspace((s) => s.activeWorkspace());
  const tabTitle = useTabs((s) => {
    const id = s.activeId;
    return id ? s.tabs.find((t) => t.id === id)?.title : undefined;
  });

  const isMac =
    typeof navigator !== "undefined" && /Mac|iPad|iPhone/.test(navigator.platform);

  const isDark = isDarkTheme(theme);
  const toggleDark = () => {
    setTheme(isDark ? lightVariant : darkVariant);
  };

  const onTitleMouseDown = useCallback(async (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (target.closest("[data-no-drag], button, input, textarea, a")) return;
    try {
      const w = getCurrentWindow();
      if (e.detail === 2) {
        // 双击 — macOS 一般是 zoom / 最大化切换
        await w.toggleMaximize();
        return;
      }
      await w.startDragging();
    } catch {
      /* not in tauri or already dragging */
    }
  }, []);

  const onSyncClick = () => {
    setToast({ stage: "uploading", message: "正在同步..." });
    setTimeout(() => setToast({ stage: "done", message: "已同步" }), 1500);
    setTimeout(() => setToast(null), 3500);
  };

  return (
    <div
      className={"titlebar" + (isMac ? "" : " no-traffic")}
      data-tauri-drag-region
      onMouseDown={onTitleMouseDown}
    >
      {!isMac && (
        <div
          className="title-brand"
          style={{ paddingLeft: 4 }}
          data-tauri-drag-region
        >
          <img
            src={isDark ? "/brand/icon-dark-256.png" : "/brand/icon-light-256.png"}
            alt="markio"
            draggable={false}
          />
          <span>markio</span>
        </div>
      )}
      <div className="title-center" data-tauri-drag-region>
        {tabTitle ? (
          <>
            <span data-tauri-drag-region>{tabTitle}</span>
            {ws && (
              <span className="title-meta" data-tauri-drag-region>
                <span
                  data-tauri-drag-region
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 999,
                    background: ws.color,
                  }}
                />
                {ws.name}
              </span>
            )}
          </>
        ) : (
          <span data-tauri-drag-region>markio · markdown 阅读器</span>
        )}
      </div>
      <div className="title-actions" data-no-drag>
        <button
          type="button"
          className="tb-quick-cap"
          title="快速捕获 ⌥Space"
          onClick={() => openQuickCapture(true)}
        >
          <span className="bolt" aria-hidden>⚡</span>
          <span>捕获</span>
        </button>
        <button
          type="button"
          className={"tb-ai-top" + (aiOpen ? " active" : "")}
          title={shortcutText(aiOpen ? "返回编辑器 ⌘J" : "AI 助手 ⌘J")}
          onClick={() => openAi(!aiOpen)}
        >
          <span className="orb" aria-hidden>{aiOpen ? "←" : "✦"}</span>
          <span>{aiOpen ? "编辑器" : "AI"}</span>
        </button>
        <div className="tb-divider" aria-hidden />
        <button className="icon-btn" title="同步" onClick={onSyncClick}>
          <Icon name="sync" size={15} />
        </button>
        <button className="icon-btn" title="切换主题" onClick={toggleDark}>
          <Icon name={isDark ? "sun" : "moon"} size={15} />
        </button>
        <button
          className="icon-btn"
          title="设置"
          onClick={() => openSettings(true)}
        >
          <Icon name="settings" size={15} />
        </button>
      </div>
    </div>
  );
}
