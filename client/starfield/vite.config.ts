import path, { resolve } from "path"
import react from "@vitejs/plugin-react-swc"
import { visualizer } from "rollup-plugin-visualizer"
import { defineConfig } from "vite"
import dts from "vite-plugin-dts"

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    dts({
      include: ["src/**/*"],
      exclude: [
        "src/**/*.test.*",
        "src/**/*.spec.*",
        "**/*.stories.*",
        "**/*.mock.*",
      ],
      outDir: "dist",
      tsconfigPath: "./tsconfig.app.json",
      rollupTypes: true,
    }),
    visualizer({
      open: false,
      gzipSize: true,
      brotliSize: true,
      filename: "bundle-analysis.html",
    }),
  ],
  resolve: {
    alias: {
      "@/assets": path.resolve(__dirname, "./src/assets"),
      "@": path.resolve(__dirname, "./src"),
    },
  },

  build: {
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      name: "Gradient Bang Starfield",
      formats: ["es"],
      fileName: "index",
    },
    // Don't copy public folder to dist
    copyPublicDir: false,
    rollupOptions: {
      // Externalize deps - let the consuming app bundle them
      // This allows dynamic imports of starfield to naturally include its deps
      external: (id) => {
        // Always externalize React and leva
        if (
          id === "react" ||
          id === "react-dom" ||
          id.startsWith("react/") ||
          id === "leva"
        ) {
          return true
        }
        // Externalize all three.js related packages
        if (
          id === "three" ||
          id.startsWith("three/") ||
          id.startsWith("@react-three/") ||
          id.startsWith("@react-spring/") ||
          id === "postprocessing" ||
          id.startsWith("postprocessing/") ||
          id.startsWith("three-")
        ) {
          return true
        }
        return false
      },
      output: {
        // Preserve module structure for tree-shaking
        preserveModules: false,
        globals: {
          react: "React",
          "react-dom": "ReactDOM",
          "react/jsx-runtime": "jsxRuntime",
        },
      },
    },
  },
})
