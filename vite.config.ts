import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

const host = process.env.TAURI_DEV_HOST || "127.0.0.1";
const port = 18642;

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  server: {
    port,
    strictPort: true,
    host,
    hmr: { protocol: "ws", host, port },
    watch: {
      ignored: [
        "**/.git/**",
        "**/node_modules/**",
        "**/src-tauri/**",
        "**/dev-logs/**",
        "**/dist/**",
        "**/coverage/**",
        "**/.turbo/**",
        "**/.next/**",
        "**/.vite/**",
        // The app edits vault content during dev. If a test/demo vault lives
        // under the repo, Vite sees those saves and full-reloads the app,
        // briefly dropping in-memory tabs before session restore brings them
        // back. Keep user content out of the dev-server watcher.
        "**/store-assets/demo-vault/**",
        "**/*.md",
        "**/*.markdown",
        "**/*.mdown",
        "**/*.mkd",
        "**/*.txt",
      ],
    },
  },
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return undefined;
          const normalized = id.split(path.sep).join("/");
          if (normalized.includes("@tauri-apps")) return "tauri";
          if (
            normalized.includes("/node_modules/react/") ||
            normalized.includes("/node_modules/react-dom/") ||
            normalized.includes("/node_modules/scheduler/")
          ) {
            return "react";
          }
          if (
            normalized.includes("@codemirror/state") ||
            normalized.includes("@codemirror/view") ||
            normalized.includes("@codemirror/commands") ||
            normalized.includes("@codemirror/search") ||
            normalized.includes("@codemirror/language/") ||
            normalized.includes("@codemirror/lang-markdown") ||
            normalized.includes("@lezer/common") ||
            normalized.includes("@lezer/highlight") ||
            normalized.includes("@lezer/lr") ||
            normalized.includes("@lezer/markdown") ||
            normalized.includes("@uiw/codemirror-themes")
          ) {
            return "codemirror-core";
          }
          if (normalized.includes("/katex/")) return "katex";
          if (normalized.includes("/cytoscape/")) return "graph-engine";
          if (
            normalized.includes("/markdown-it") ||
            normalized.includes("/highlight.js") ||
            normalized.includes("/dompurify/")
          ) {
            return "markdown-tools";
          }
          if (normalized.includes("/cmdk/")) return "command-ui";
          if (normalized.includes("@tanstack/react-virtual")) return "virtual";
          if (normalized.includes("/zustand/")) return "state";
          return undefined;
        },
      },
    },
  },
}));
