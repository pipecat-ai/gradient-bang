import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    allowedHosts: true,
    proxy: {
      // To test the map rendering component, start the http server
      // `uv run game-server/old-http-server.py`
      "/api/local_map": {
        target: "http://0.0.0.0:8000",
        changeOrigin: true,
      },
      "/api/offer": {
        target: "http://0.0.0.0:7860",
        changeOrigin: true,
      },
    },
  },
});
