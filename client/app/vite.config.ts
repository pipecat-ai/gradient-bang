import path from "path"
import { visualizer } from "rollup-plugin-visualizer"
import PreprocessorDirectives from "unplugin-preprocessor-directives/vite"
import { defineConfig, type PluginOption } from "vite"
import { VitePWA } from "vite-plugin-pwa"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"

import { version } from "./package.json"

// https://vite.dev/config/
export default defineConfig(() => ({
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(version),
  },
  plugins: [
    PreprocessorDirectives(),
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      devOptions: {
        enabled: false,
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,png,jpg,jpeg,svg,woff,woff2,wav,mp3,mp4}"],
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
  build: {
    rollupOptions: {
      external: (id) => {
        if (id.includes("@ladle")) return true
        if (id.includes(".stories.")) return true
        return false
      },
    },
  },
  resolve: {
    alias: {
      "@/assets": path.resolve(__dirname, "./src/assets"),
      "@/fx": path.resolve(__dirname, "./src/fx"),
      "@/views": path.resolve(__dirname, "./src/components/views"),
      "@/screens": path.resolve(__dirname, "./src/components/screens"),
      "@/stores": path.resolve(__dirname, "./src/stores"),
      "@/mocks": path.resolve(__dirname, "./src/mocks"),
      "@": path.resolve(__dirname, "./src"),
      // TODO: leva mock breaks starfield - include real leva for now
      // ...(mode === "production" && {
      //   leva: path.resolve(__dirname, "./src/mocks/leva.mock.ts"),
      // }),
    },
  },
  optimizeDeps: {
    exclude: ["@gradient-bang/starfield"],
  },
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
    watch: {
      // Watch the starfield dist for changes
      ignored: ["!**/node_modules/@gradient-bang/**"],
    },
  },
}))
