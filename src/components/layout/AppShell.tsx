import { useEffect, useState } from "react";
import { TitleBar } from "./TitleBar";
import { Sidebar } from "./Sidebar";
import { SidebarResizer } from "./SidebarResizer";
import { TabStrip } from "./TabStrip";
import { Toolbar } from "./Toolbar";
import { Crumb } from "./Crumb";
import { StatusBar } from "./StatusBar";
import { EditorArea } from "../editor/EditorArea";
import { Welcome } from "../Welcome";
import { CommandPalette } from "../popovers/CommandPalette";
import { GlobalSearch } from "../popovers/GlobalSearch";
import { FindBar } from "../popovers/FindBar";
import { HistorySheet } from "../popovers/HistorySheet";
import { AIPanel } from "../popovers/AIPanel";
import { WeChatSheet } from "../popovers/WeChatSheet";
import { QuickCapture } from "../popovers/QuickCapture";
import { ExportSheet } from "../popovers/ExportSheet";
import { PinnedPlanBar } from "../popovers/PinnedPlanBar";
import { Settings } from "../settings/Settings";
import { ToastHost } from "../popovers/Toast";
import { useUI } from "@/stores/ui";
import { useTabs } from "@/stores/tabs";
import { useWorkspace } from "@/stores/workspace";
import { useSettings } from "@/stores/settings";
import { classNames } from "@/lib/utils";

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
  const openCommand = useUI((s) => s.openCommand);
  const openGlobalSearch = useUI((s) => s.openGlobalSearch);
  const openSettings = useUI((s) => s.openSettings);
  const openAi = useUI((s) => s.openAi);
  const openWechat = useUI((s) => s.openWechat);
  const tab = useTabs((s) => s.activeTab());
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
          <AIPanel onClose={() => openAi(false)} />
        ) : (
          <div className={classNames("body", !sidebarOpen && "no-sidebar")}>
            {sidebarOpen && <Sidebar />}
            {sidebarOpen && <SidebarResizer />}
            <div className={classNames("main", focusMode && "focus")}>
              {tab ? (
                <>
                  <TabStrip />
                  <Toolbar
                    onAi={() => openAi(true)}
                    onWechat={() => openWechat(true)}
                  />
                  <Crumb />
                  <EditorArea
                    onMeta={(m) => setMeta(m)}
                    onAskAi={() => openAi(true)}
                  />
                </>
              ) : (
                <Welcome />
              )}
              <FindBar />
              <HistorySheet />
            </div>
          </div>
        )}
        <StatusBar words={meta.words} readingMinutes={meta.readingMinutes} />
      </div>

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
      <PinnedPlanBar />
      <ToastHost />
    </div>
  );
}
