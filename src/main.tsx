import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { applyTheme } from "./themes";
import { useSettings } from "./stores/settings";
import { injectSyntaxTheme } from "./lib/syntax-theme";

applyTheme(useSettings.getState().theme);
injectSyntaxTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
