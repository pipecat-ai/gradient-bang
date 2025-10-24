import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
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
