import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import cesium from "vite-plugin-cesium";
import path from "node:path";

const host = process.env.TAURI_DEV_HOST || "127.0.0.1";
const port = 18642;

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss(), cesium()],
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
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("@tauri-apps")) return "tauri";
          if (id.includes("react") || id.includes("scheduler")) return "react";
          if (id.includes("cesium")) return "cesium";
          if (id.includes("maplibre-gl")) return "maplibre";
          return undefined;
        },
      },
    },
  },
}));
