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
import { useSession } from "./stores/session";
import { injectSyntaxTheme } from "./lib/syntax-theme";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { api, isDesktop } from "./lib/api";
import { preloadTauriStorage } from "./lib/tauriStorage";
import { migrateLegacySettingSecrets } from "./lib/secretMigration";
import { installDigestScheduler } from "./lib/digestScheduler";
import { installRssScheduler } from "./lib/rssScheduler";
import { installLocalServices } from "./lib/localServices";
import { setLocale as setI18nLocale } from "./i18n";
import { applyFonts } from "./lib/fonts";
import { devLog, installDevLogger } from "./lib/devLogger";
import {
  refreshAIProvidersForCurrentRegion,
  sanitizeAIStateForCurrentRegion,
} from "./lib/ai-providers";
import {
  getConfiguredAIRegionMode,
  setRuntimeAIRegionFromStorefront,
} from "./lib/ai-region-policy";
import "./i18n";

function shouldInstallDevLogger(): boolean {
  if (!import.meta.env.DEV || typeof window === "undefined") return false;
  const envEnabled = import.meta.env.VITE_MARKIO_DEV_LOG === "1";
  const queryEnabled = new URLSearchParams(window.location.search).get("devlog") === "1";
  const storageEnabled = localStorage.getItem("markio.devLog") === "1";
  return envEnabled || queryEnabled || storageEnabled;
}

async function configureAIRegion() {
  if (getConfiguredAIRegionMode() !== "auto") {
    refreshAIProvidersForCurrentRegion();
    return;
  }

  if (isDesktop()) {
    try {
      const countryCode = await api.appStorefrontCountryCode();
      const region = setRuntimeAIRegionFromStorefront(countryCode);
      if (region) {
        devLog("info", "ai.region.storefront", { countryCode, region });
      } else {
        devLog("info", "ai.region.storefront.unavailable", { countryCode });
      }
    } catch (e) {
      devLog("warn", "ai.region.storefront.failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  refreshAIProvidersForCurrentRegion();
}

async function bootstrap() {
  // 开发日志会拦截 console/HMR/invoke 并写入 dev-logs/。默认关闭，排查问题时
  // 用 VITE_MARKIO_DEV_LOG=1、?devlog=1 或 localStorage markio.devLog=1 显式启用。
  if (shouldInstallDevLogger()) {
    installDevLogger();
  }

  const trace = async <T,>(name: string, fn: () => Promise<T>): Promise<T> => {
    if (!import.meta.env.DEV) return fn();
    const t0 = performance.now();
    try {
      const r = await fn();
      devLog("debug", `boot.${name}`, { ms: Math.round(performance.now() - t0) });
      return r;
    } catch (e) {
      devLog("error", `boot.${name} failed`, {
        ms: Math.round(performance.now() - t0),
        error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
        stack: e instanceof Error ? e.stack : undefined,
      });
      throw e;
    }
  };

  // 先把 store.bin 全量加载进内存（含 localStorage → plugin-store 迁移），
  // 再同步水合每个 zustand persist store，最后才 render，避免主题闪烁。
  await trace("preloadTauriStorage", () => preloadTauriStorage());
  await trace("migrateLegacySettingSecrets", () => migrateLegacySettingSecrets());
  await trace("configureAIRegion", () => configureAIRegion());
  await trace("rehydrateAll", () =>
    Promise.all([
      useSettings.persist.rehydrate(),
      useWorkspace.persist.rehydrate(),
      useUI.persist.rehydrate(),
      useAISessions.persist.rehydrate(),
      usePomodoro.persist.rehydrate(),
      useStreak.persist.rehydrate(),
      useRecents.persist.rehydrate(),
      usePinnedPlan.persist.rehydrate(),
      useFileIcons.persist.rehydrate(),
      useSession.persist.rehydrate(),
    ]),
  );

  const s = useSettings.getState();
  const aiRegionPatch = sanitizeAIStateForCurrentRegion(s);
  if (aiRegionPatch) {
    useSettings.setState(aiRegionPatch);
  }
  const settings = useSettings.getState();
  applyTheme(settings.theme);
  applyFonts({
    uiFontFamily: settings.uiFontFamily,
    bodyFontFamily: settings.bodyFontFamily,
    monoFontFamily: settings.monoFontFamily,
  });
  setI18nLocale(settings.locale);
  useSettings.subscribe((next, prev) => {
    if (next.locale !== prev.locale) setI18nLocale(next.locale);
  });
  injectSyntaxTheme();

  // 把持久化的"显示在菜单栏"应用到原生托盘
  if (isDesktop()) {
    api
      .traySetVisible(useSettings.getState().showInTray)
      .catch(() => undefined);
  }

  // 微信助手 · 每日摘要调度（仅 60s 心跳，命中条件才真正推）
  installDigestScheduler();

  // RSS 订阅 · 按 rssFetchInterval 后台定时拉取（manual 时不自动拉）
  installRssScheduler();

  // 本地服务桥接（WebClipper / SmartChannel 入站 / P2P）：推配置 + 活跃仓库 + 入站桥
  installLocalServices();

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
