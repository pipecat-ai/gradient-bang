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
      exclude: ["src/**/*.test.*", "src/**/*.spec.*", "**/*.stories.*"],
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
    dedupe: ["react", "react-dom"],
  },
  optimizeDeps: {
    include: ["react", "react-dom"],
  },

  build: {
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      name: "Gradient Bang Starfield",
      formats: ["es"],
      fileName: "index",
    },
    rollupOptions: {
      // Externalize only React and its ecosystem
      external: [
        "react",
        "react-dom",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
      ],
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
