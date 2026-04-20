import path from "path"
import { visualizer } from "rollup-plugin-visualizer"
import PreprocessorDirectives from "unplugin-preprocessor-directives/vite"
import { defineConfig, loadEnv, type PluginOption } from "vite"
import { VitePWA } from "vite-plugin-pwa"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"

import { version } from "./package.json"

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  // Warn loudly if VITE_BOT_URL leaks into a production build. The client only
  // honors this env var in dev mode (see main.tsx); leaving it set during a
  // `vite build` is almost always a mistake that would otherwise silently do
  // nothing and confuse whoever is debugging the resulting bundle.
  if (command === "build" && mode === "production") {
    const env = loadEnv(mode, process.cwd(), "VITE_")
    if (env.VITE_BOT_URL) {
      const banner = "⚠️  WARNING: VITE_BOT_URL is set during a production build"
      const detail =
        "    VITE_BOT_URL is a dev-only override for routing the Pipecat session\n" +
        "    to a local bot. It is stripped from production bundles and will have\n" +
        "    no effect at runtime. Remove it from your build environment if you\n" +
        "    did not mean to set it."
      // Use stderr so CI log scrapers notice it.
      process.stderr.write(`\n${banner}\n${detail}\n\n`)
    }
  }

  return {
    define: {
      "import.meta.env.VITE_APP_VERSION": JSON.stringify(version),
    },
    plugins: [
      PreprocessorDirectives(),
      react(),
      tailwindcss(),
      VitePWA({
        registerType: "prompt",
        devOptions: {
          enabled: false,
        },
        workbox: {
          // Precache only CSS, HTML, fonts (~50KB). Near-instant install/update.
          // JS and media are runtime-cached when fetched (by page load or preload screen).
          globPatterns: ["**/*.{css,woff,woff2}"],
          maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
          clientsClaim: true,
          // Don't serve index.html from precache for navigations.
          // This ensures a normal refresh always fetches fresh HTML from the network,
          // so new deploys are picked up without needing a hard refresh.
          navigateFallbackDenylist: [/./],
          // Runtime caching: assets cached on first fetch via CacheFirst.
          // Vite adds content hashes to filenames, so CacheFirst is safe —
          // URL changes when content changes. maxEntries evicts old hashed URLs.
          runtimeCaching: [
            {
              urlPattern: /\.js$/i,
              handler: "CacheFirst",
              options: {
                cacheName: "gb-js",
                expiration: { maxEntries: 50, maxAgeSeconds: 30 * 24 * 60 * 60 },
              },
            },
            {
              urlPattern: /\.(?:png|jpg|jpeg|svg)$/i,
              handler: "CacheFirst",
              options: {
                cacheName: "gb-images",
                expiration: { maxEntries: 100, maxAgeSeconds: 30 * 24 * 60 * 60 },
              },
            },
            {
              urlPattern: /\.(?:wav|mp3)$/i,
              handler: "CacheFirst",
              options: {
                cacheName: "gb-audio",
                expiration: { maxEntries: 50, maxAgeSeconds: 30 * 24 * 60 * 60 },
              },
            },
            {
              urlPattern: /\.(?:mp4)$/i,
              handler: "CacheFirst",
              options: {
                cacheName: "gb-video",
                expiration: { maxEntries: 10, maxAgeSeconds: 30 * 24 * 60 * 60 },
              },
            },
          ],
        },
        manifest: {
          name: "Gradient Bang",
          short_name: "GB",
          description:
            "Gradient Bang is an online multiplayer universe where you explore, trade, battle, and collaborate with other players and with LLMs.",
          theme_color: "#000000",
          background_color: "#000000",
          display: "standalone",
          orientation: "landscape",
          icons: [
            {
              src: "/icons/icon-192x192.png",
              sizes: "192x192",
              type: "image/png",
            },
            {
              src: "/icons/icon-512x512.png",
              sizes: "512x512",
              type: "image/png",
            },
            {
              src: "/icons/icon-512x512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "maskable",
            },
          ],
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
      watch: {
        // Watch the starfield dist for changes
        ignored: ["!**/node_modules/@gradient-bang/**"],
      },
    },
  }
})
