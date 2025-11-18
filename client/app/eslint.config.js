import js from "@eslint/js"
import reactHooks from "eslint-plugin-react-hooks"
import reactRefresh from "eslint-plugin-react-refresh"
import simpleImportSort from "eslint-plugin-simple-import-sort"
import { defineConfig, globalIgnores } from "eslint/config"
import globals from "globals"
import tseslint from "typescript-eslint"

export default defineConfig([
  globalIgnores(["dist", "src/mocks/*.mock.ts"]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "react-refresh": reactRefresh,
      "simple-import-sort": simpleImportSort,
    },
    rules: {
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      "simple-import-sort/imports": [
        "error",
        {
          groups: [
            // React imports first
            ["^react(-dom)?(/|$)"],
            // External packages (node_modules)
            ["^\\w", "^@\\w"],
            // Internal aliases (your src mappings)
            ["^@(/|$)"],
            // Relative imports
            ["^\\."],
            // Types and mocks
            ["^@/types", "^@/mocks"],
            // Style imports last
            ["^.+\\.(css|scss|sass|less|styl)$"],
          ],
        },
      ],
      "simple-import-sort/exports": "error",
    },
  },
])
