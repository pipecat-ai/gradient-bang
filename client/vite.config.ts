import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { visualizer } from "rollup-plugin-visualizer";
import { defineConfig, type PluginOption } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      devOptions: {
        enabled: false,
      },
      workbox: {
        globPatterns: [
          "**/*.{js,css,html,png,jpg,jpeg,svg,woff,woff2,wav,mp3,mp4}",
        ],
        maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
      },
      manifest: {
        name: "Gradient Bang",
        short_name: "GB",
        description:
          "Gradient Bang is an online multiplayer universe where you explore, trade, battle, and collaborate with other players and with LLMs.",
        theme_color: "#000000",
        background_color: "#000000",
        display: "standalone",
      },
    }),
    visualizer({
      open: false,
      gzipSize: true,
      brotliSize: true,
      filename: "bundle-analysis.html",
    }) as PluginOption,
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@assets": path.resolve(__dirname, "./src/assets"),
      "@fx": path.resolve(__dirname, "./src/fx"),
      "@hud": path.resolve(__dirname, "./src/hud"),
      "@views": path.resolve(__dirname, "./src/views"),
      "@screens": path.resolve(__dirname, "./src/screens"),
      "@stores": path.resolve(__dirname, "./src/stores"),
    },
  },
  server: {
    allowedHosts: true,
    proxy: {
      "/api": {
        target: "http://0.0.0.0:7860",
        changeOrigin: true,
      },
    },
  },
});
