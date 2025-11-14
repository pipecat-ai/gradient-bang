import reactHooks from "eslint-plugin-react-hooks"
import reactRefresh from "eslint-plugin-react-refresh"
import simpleImportSort from "eslint-plugin-simple-import-sort"
import globals from "globals"
import tseslint from "typescript-eslint"

import js from "@eslint/js"

export default [
  {
    ignores: ["dist", "src/mocks/*.mock.ts"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
      "simple-import-sort": simpleImportSort,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
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
]
