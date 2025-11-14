/**
 * Leva Mock for Production Builds
 *
 * This file replaces the `leva` package in production builds via Vite's alias configuration.
 * See vite.config.ts: `mode === "production" && { leva: path.resolve(__dirname, "./src/leva.mock.ts") }`
 *
 * Why this exists:
 * - Leva is a dev tool for interactive controls (~100-150KB with dependencies)
 * - We use `useControls` throughout the codebase for dev-time tweaking
 * - In production, we don't need the UI or interactivity, just the default values
 *
 * How it works:
 * - Development: `import { useControls } from "leva"` → real leva from node_modules
 * - Production: `import { useControls } from "leva"` → this mock file (via alias)
 * - The mock extracts default values from schemas and returns them as static values
 *
 * Result: Zero leva code in production bundles, full interactivity in development.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
export const useControls = (_name: string, schema: any, _options?: any) => {
  return Object.entries(schema).reduce((acc, [key, config]) => {
    acc[key] = (config as any)?.value ?? config
    return acc
  }, {} as any)
}

export const Leva = () => null

export const folder = (_name: string) => ({})
export const button = (_fn: Function) => ({})
