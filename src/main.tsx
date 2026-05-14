import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { applyTheme } from "./themes";
import { useSettings } from "./stores/settings";
import { injectSyntaxTheme } from "./lib/syntax-theme";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { api, isDesktop } from "./lib/api";
import "./i18n";

applyTheme(useSettings.getState().theme);
injectSyntaxTheme();

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
