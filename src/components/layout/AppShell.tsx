import { lazy, Suspense, useEffect } from "react";
import { TitleBar } from "./TitleBar";
import { Sidebar } from "./Sidebar";
import { SidebarResizer } from "./SidebarResizer";
import { TabStrip } from "./TabStrip";
import { Toolbar } from "./Toolbar";
import { Crumb } from "./Crumb";
import { StatusBar } from "./StatusBar";
import { Welcome } from "../Welcome";
import { ToastHost } from "../popovers/Toast";
import { DialogHost } from "../popovers/DialogHost";
import { useUI } from "@/stores/ui";
import { useTabs } from "@/stores/tabs";
import { useWorkspace } from "@/stores/workspace";
import { useSettings } from "@/stores/settings";
import { usePinnedPlan } from "@/stores/pinnedPlan";
import { classNames } from "@/lib/utils";

const CommandPalette = lazy(() =>
  import("../popovers/CommandPalette").then((m) => ({ default: m.CommandPalette })),
);
const EditorArea = lazy(() =>
  import("../editor/EditorArea").then((m) => ({ default: m.EditorArea })),
);
const GlobalSearch = lazy(() =>
  import("../popovers/GlobalSearch").then((m) => ({ default: m.GlobalSearch })),
);
const FindBar = lazy(() =>
  import("../popovers/FindBar").then((m) => ({ default: m.FindBar })),
);
const HistorySheet = lazy(() =>
  import("../popovers/HistorySheet").then((m) => ({ default: m.HistorySheet })),
);
const AIPanel = lazy(() =>
  import("../popovers/AIPanel").then((m) => ({ default: m.AIPanel })),
);
const WeChatSheet = lazy(() =>
  import("../popovers/WeChatSheet").then((m) => ({ default: m.WeChatSheet })),
);
const QuickCapture = lazy(() =>
  import("../popovers/QuickCapture").then((m) => ({ default: m.QuickCapture })),
);
const ExportSheet = lazy(() =>
  import("../popovers/ExportSheet").then((m) => ({ default: m.ExportSheet })),
);
const MultiCopySheet = lazy(() =>
  import("../popovers/MultiCopySheet").then((m) => ({ default: m.MultiCopySheet })),
);
const PinnedPlanBar = lazy(() =>
  import("../popovers/PinnedPlanBar").then((m) => ({ default: m.PinnedPlanBar })),
);
const Settings = lazy(() =>
  import("../settings/Settings").then((m) => ({ default: m.Settings })),
);
const BlockMenu = lazy(() =>
  import("../popovers/BlockMenu").then((m) => ({ default: m.BlockMenu })),
);

/** Settings / AIPanel 切入时 lazy chunk 还没下载完，body 区会出现一片白；
 *  给一个轻量骨架：复用 .settings-workspace 的外壳 + 顶栏 + 左 nav 占位条，
 *  视觉上不会跳。AI 模式骨架也类似但更轻。 */
function SettingsSkeleton() {
  return (
    <div className="settings-workspace" aria-busy="true">
      <div className="settings-topbar">
        <div className="settings-topbar-l">
          <div className="settings-mark" aria-hidden />
          <div className="settings-topbar-tt">
            <div className="sk-line" style={{ width: 64 }} />
            <div className="sk-line sk-dim" style={{ width: 180, marginTop: 4 }} />
          </div>
        </div>
      </div>
      <div className="settings-body2">
        <aside className="settings-nav2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="sk-line" style={{ height: 14, margin: "8px 6px" }} />
          ))}
        </aside>
        <div className="settings-main2" />
      </div>
    </div>
  );
}

function AiSkeleton() {
  return (
    <div className="ai-workspace" aria-busy="true">
      <div className="ai-top">
        <div className="ai-top-l">
          <div className="ai-glow" />
          <div>
            <div className="sk-line" style={{ width: 56 }} />
            <div className="sk-line sk-dim" style={{ width: 220, marginTop: 4 }} />
          </div>
        </div>
      </div>
    </div>
  );
}

export function AppShell() {
  const sidebarOpen = useUI((s) => s.sidebarOpen);
  const sidebarWidth = useUI((s) => s.sidebarWidth);
  const focusMode = useUI((s) => s.focusMode);
  const commandOpen = useUI((s) => s.commandOpen);
  const globalSearchOpen = useUI((s) => s.globalSearchOpen);
  const settingsOpen = useUI((s) => s.settingsOpen);
  const aiOpen = useUI((s) => s.aiOpen);
  const wechatOpen = useUI((s) => s.wechatOpen);
  const quickCaptureOpen = useUI((s) => s.quickCaptureOpen);
  const openQuickCapture = useUI((s) => s.openQuickCapture);
  const exportSheetOpen = useUI((s) => s.exportSheetOpen);
  const openExportSheet = useUI((s) => s.openExportSheet);
  const multiCopyOpen = useUI((s) => s.multiCopyOpen);
  const openMultiCopy = useUI((s) => s.openMultiCopy);
  const blockMenuAt = useUI((s) => s.blockMenuAt);
  const setBlockMenuAt = useUI((s) => s.setBlockMenuAt);
  const openCommand = useUI((s) => s.openCommand);
  const openGlobalSearch = useUI((s) => s.openGlobalSearch);
  const openSettings = useUI((s) => s.openSettings);
  const openAi = useUI((s) => s.openAi);
  const openWechat = useUI((s) => s.openWechat);
  const findOpen = useUI((s) => s.findOpen);
  const historyOpen = useUI((s) => s.historyOpen);
  const pinnedPlanPath = usePinnedPlan((s) => s.path);
  const activeTabId = useTabs((s) => s.activeId);
  const activeWorkspaceId = useWorkspace((s) => s.activeId);
  const refreshTree = useWorkspace((s) => s.refreshTree);
  const fontSize = useSettings((s) => s.fontSize);
  const workspaceOverlayOpen = settingsOpen || aiOpen;

  useEffect(() => {
    if (activeWorkspaceId) refreshTree(activeWorkspaceId);
  }, [activeWorkspaceId, refreshTree]);

  // 预热 Settings + AIPanel chunk：用户首次切换时 lazy import 已经 in-flight 或好了，
  // 不再出现空白中间态。idle callback 推后，不影响初次绘制。
  useEffect(() => {
    const idle =
      typeof window !== "undefined" &&
      typeof (window as Window & { requestIdleCallback?: (cb: IdleRequestCallback) => number }).requestIdleCallback ===
        "function"
        ? (window as Window & { requestIdleCallback: (cb: IdleRequestCallback) => number }).requestIdleCallback
        : (cb: () => void) => window.setTimeout(cb, 800);
    const handle = idle(() => {
      void import("../settings/Settings");
      void import("../popovers/AIPanel");
    });
    return () => {
      const cancel =
        typeof window !== "undefined" &&
        typeof (window as Window & { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback ===
          "function"
          ? (window as Window & { cancelIdleCallback: (h: number) => void }).cancelIdleCallback
          : (h: number) => window.clearTimeout(h);
      cancel(handle as number);
    };
  }, []);

  return (
    <div className="markio-root">
      <div
        className="win"
        style={
          {
            fontSize,
            ["--sidebar-w" as never]: `${sidebarWidth}px`,
            // 把"正文字号"也暴露成 CSS 变量，让 .preview (markdown.css) 用 var(--prose-fs)
            // 替换硬编码 16px / 17px / 14.5px，否则拖 slider 只动 slider 自己
            ["--prose-fs" as never]: `${fontSize}px`,
          } as React.CSSProperties
        }
      >
        <TitleBar />
        <div className="workspace-stage">
          <div
            className={classNames(
              "body",
              !sidebarOpen && "no-sidebar",
              workspaceOverlayOpen && "shell-obscured",
            )}
            aria-hidden={workspaceOverlayOpen ? "true" : undefined}
          >
            {sidebarOpen && <Sidebar />}
            {sidebarOpen && <SidebarResizer />}
            <div className={classNames("main", focusMode && "focus")}>
              {activeTabId ? (
                <>
                  <TabStrip />
                  <Toolbar onCopyAs={() => openMultiCopy(true)} />
                  <Crumb />
                  <Suspense fallback={null}>
                    <EditorArea onAskAi={() => openAi(true)} />
                  </Suspense>
                </>
              ) : (
                <Welcome />
              )}
              <Suspense fallback={null}>
                {findOpen && <FindBar />}
                {historyOpen && <HistorySheet />}
              </Suspense>
            </div>
          </div>
          {settingsOpen && (
            <div className="workspace-overlay">
              <Suspense fallback={<SettingsSkeleton />}>
                <Settings onClose={() => openSettings(false)} />
              </Suspense>
            </div>
          )}
          {!settingsOpen && aiOpen && (
            <div className="workspace-overlay">
              <Suspense fallback={<AiSkeleton />}>
                <AIPanel onClose={() => openAi(false)} />
              </Suspense>
            </div>
          )}
        </div>
        <StatusBar />
      </div>

      <Suspense fallback={null}>
        {commandOpen && <CommandPalette onClose={() => openCommand(false)} />}
        {globalSearchOpen && (
          <GlobalSearch onClose={() => openGlobalSearch(false)} />
        )}
        {wechatOpen && <WeChatSheet onClose={() => openWechat(false)} />}
        {quickCaptureOpen && (
          <QuickCapture onClose={() => openQuickCapture(false)} />
        )}
        {exportSheetOpen && (
          <ExportSheet onClose={() => openExportSheet(false)} />
        )}
        {multiCopyOpen && <MultiCopySheet onClose={() => openMultiCopy(false)} />}
        {blockMenuAt && (
          <BlockMenu
            x={blockMenuAt.x}
            y={blockMenuAt.y}
            onClose={() => setBlockMenuAt(null)}
          />
        )}
        {pinnedPlanPath && <PinnedPlanBar />}
      </Suspense>
      <ToastHost />
      <DialogHost />
    </div>
  );
}
