import path from "path"
import { defineConfig, loadEnv } from "vite"

export default defineConfig(({ mode }) => {
  // Load .env, .env.local, .env.{mode} and .env.{mode}.local.
  // Passing "" as the third arg returns ALL variables (not just VITE_-prefixed).
  const env = loadEnv(mode, __dirname, "")
  return {
    test: {
      environment: "node",
      globals: false,
      include: ["src/**/__tests__/**/*.test.ts"],
      // Surfacing loaded env vars into process.env inside test workers so
      // code that reads `process.env.OPENAI_API_KEY` (e.g. OpenAILLMClient)
      // works without a shell export.
      env,
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
  }
})
