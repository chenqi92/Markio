import { lazy, Suspense, useEffect, useState } from "react";
import { TitleBar } from "./TitleBar";
import { Sidebar } from "./Sidebar";
import { SidebarResizer } from "./SidebarResizer";
import { TabStrip } from "./TabStrip";
import { Toolbar } from "./Toolbar";
import { Crumb } from "./Crumb";
import { StatusBar } from "./StatusBar";
import { EditorArea } from "../editor/EditorArea";
import { Welcome } from "../Welcome";
import { ToastHost } from "../popovers/Toast";
import { useUI } from "@/stores/ui";
import { useTabs } from "@/stores/tabs";
import { useWorkspace } from "@/stores/workspace";
import { useSettings } from "@/stores/settings";
import { usePinnedPlan } from "@/stores/pinnedPlan";
import { classNames } from "@/lib/utils";

const CommandPalette = lazy(() =>
  import("../popovers/CommandPalette").then((m) => ({ default: m.CommandPalette })),
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
  const [meta, setMeta] = useState<{
    words: number;
    readingMinutes: number;
  }>({ words: 0, readingMinutes: 1 });

  useEffect(() => {
    if (activeWorkspaceId) refreshTree(activeWorkspaceId);
  }, [activeWorkspaceId, refreshTree]);

  return (
    <div className="markio-root">
      <div
        className="win"
        style={
          {
            fontSize,
            ["--sidebar-w" as never]: `${sidebarWidth}px`,
          } as React.CSSProperties
        }
      >
        <TitleBar />
        {aiOpen ? (
          <Suspense fallback={null}>
            <AIPanel onClose={() => openAi(false)} />
          </Suspense>
        ) : (
          <div className={classNames("body", !sidebarOpen && "no-sidebar")}>
            {sidebarOpen && <Sidebar />}
            {sidebarOpen && <SidebarResizer />}
            <div className={classNames("main", focusMode && "focus")}>
              {activeTabId ? (
                <>
                  <TabStrip />
                  <Toolbar onCopyAs={() => openMultiCopy(true)} />
                  <Crumb />
                  <EditorArea
                    onMeta={(m) => setMeta(m)}
                    onAskAi={() => openAi(true)}
                  />
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
        )}
        <StatusBar words={meta.words} readingMinutes={meta.readingMinutes} />
      </div>

      <Suspense fallback={null}>
        {commandOpen && <CommandPalette onClose={() => openCommand(false)} />}
        {globalSearchOpen && (
          <GlobalSearch onClose={() => openGlobalSearch(false)} />
        )}
        {settingsOpen && <Settings onClose={() => openSettings(false)} />}
        {wechatOpen && <WeChatSheet onClose={() => openWechat(false)} />}
        {quickCaptureOpen && (
          <QuickCapture onClose={() => openQuickCapture(false)} />
        )}
        {exportSheetOpen && (
          <ExportSheet onClose={() => openExportSheet(false)} />
        )}
        {multiCopyOpen && <MultiCopySheet onClose={() => openMultiCopy(false)} />}
        {pinnedPlanPath && <PinnedPlanBar />}
      </Suspense>
      <ToastHost />
    </div>
  );
}
