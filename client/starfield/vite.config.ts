import { defineConfig } from "vite"
import react from "@vitejs/plugin-react-swc"
import path, { resolve } from "path"

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@/assets": path.resolve(__dirname, "./src/assets"),
      "@": path.resolve(__dirname, "./src"),
    },
  },

  build: {
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      name: "GradientBangStarfield",
      formats: ["es"],
      fileName: "index",
    },
    rollupOptions: {
      // Externalize deps that shouldn't be bundled
      external: [
        "react",
        "react-dom",
        "react/jsx-runtime",
        "three",
        "@react-three/fiber",
        "@react-three/drei",
        "zustand",
        "immer",
        "leva",
        "postprocessing",
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
