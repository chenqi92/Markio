import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { applyTheme } from "./themes";
import { useSettings } from "./stores/settings";
import { useWorkspace } from "./stores/workspace";
import { useUI } from "./stores/ui";
import { useAISessions } from "./stores/aiSessions";
import { usePomodoro } from "./stores/pomodoro";
import { useStreak } from "./stores/streak";
import { useRecents } from "./stores/recents";
import { usePinnedPlan } from "./stores/pinnedPlan";
import { useFileIcons } from "./stores/fileIcons";
import { injectSyntaxTheme } from "./lib/syntax-theme";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { api, isDesktop } from "./lib/api";
import { preloadTauriStorage } from "./lib/tauriStorage";
import "./i18n";

async function bootstrap() {
  // 先把 store.bin 全量加载进内存（含 localStorage → plugin-store 迁移），
  // 再同步水合每个 zustand persist store，最后才 render，避免主题闪烁。
  await preloadTauriStorage();
  await Promise.all([
    useSettings.persist.rehydrate(),
    useWorkspace.persist.rehydrate(),
    useUI.persist.rehydrate(),
    useAISessions.persist.rehydrate(),
    usePomodoro.persist.rehydrate(),
    useStreak.persist.rehydrate(),
    useRecents.persist.rehydrate(),
    usePinnedPlan.persist.rehydrate(),
    useFileIcons.persist.rehydrate(),
  ]);

  applyTheme(useSettings.getState().theme);
  injectSyntaxTheme();

  // 把持久化的"显示在菜单栏"应用到原生托盘
  if (isDesktop()) {
    api
      .traySetVisible(useSettings.getState().showInTray)
      .catch(() => undefined);
  }

  // 未捕获 promise / window error 也写到日志
  if (typeof window !== "undefined" && isDesktop()) {
    window.addEventListener("error", (e) => {
      api
        .crashAppend(
          `[${new Date().toISOString()}] window.error\nmessage: ${e.message}\nfile: ${e.filename}:${e.lineno}:${e.colno}\n`,
        )
        .catch(() => undefined);
    });
    window.addEventListener("unhandledrejection", (e) => {
      api
        .crashAppend(
          `[${new Date().toISOString()}] unhandledrejection\nreason: ${String(e.reason)}\n`,
        )
        .catch(() => undefined);
    });
  }

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}

void bootstrap();
