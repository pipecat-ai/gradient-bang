import { useEffect, useMemo } from "react"
import { folder, useControls } from "leva"
import type { Schema } from "leva/dist/declarations/src/types"

import { useUniformStore } from "@/useUniformStore"

/**
 * useUniformControls - Leva controls for testing the uniform registry
 *
 * This hook creates Leva controls for all registered uniforms, allowing
 * you to manually adjust uniform values and see the effects in real-time.
 *
 * Uses Leva's onChange callbacks to update uniforms directly, avoiding
 * issues with Immer freezing objects in Zustand state.
 *
 * Usage:
 *   // In your component (must be inside the R3F Canvas)
 *   useUniformControls()
 *
 * The controls will automatically update when uniforms are registered/unregistered.
 */
export function useUniformControls() {
  const uniformRegistry = useUniformStore((state) => state.uniformRegistry)
  const setUniform = useUniformStore((state) => state.setUniform)

  // Convert registry to array for stable iteration
  const uniformEntries = useMemo(() => {
    return Array.from(uniformRegistry.entries())
  }, [uniformRegistry])

  // Build control config from registered uniforms with onChange handlers
  const controlConfig = useMemo(() => {
    const config: Schema = {}

    for (const [key, registration] of uniformEntries) {
      const currentValue = registration.uniform.value
      const initialValue = registration.initial ?? currentValue
      const meta = registration.meta ?? {}

      // Determine control type and range based on value type and meta
      if (typeof currentValue === "number") {
        // Numeric uniform - create slider
        const numericInitial =
          typeof initialValue === "number" ? initialValue : currentValue
        const isNormalized =
          (numericInitial >= 0 && numericInitial <= 1) ||
          key.toLowerCase().includes("opacity") ||
          key.toLowerCase().includes("intensity")

        const metaMin = typeof meta.min === "number" ? meta.min : undefined
        const metaMax = typeof meta.max === "number" ? meta.max : undefined
        const metaStep = typeof meta.step === "number" ? meta.step : undefined

        config[key] = {
          value: currentValue,
          min: metaMin ?? (isNormalized ? 0 : -10),
          max: metaMax ?? (isNormalized ? 1 : 20),
          step: metaStep ?? (isNormalized ? 0.01 : 0.1),
          label: key,
          // Use onChange to directly update the uniform
          onChange: (value: number) => {
            setUniform(key, value)
          },
        }
      } else if (typeof currentValue === "boolean") {
        // Boolean uniform - create checkbox
        config[key] = {
          value: currentValue,
          label: key,
          onChange: (value: boolean) => {
            setUniform(key, value)
          },
        }
      } else {
        // Other types - show as read-only text for now
        config[key] = {
          value: String(currentValue),
          label: key,
          editable: false,
        }
      }
    }

    return config
  }, [uniformEntries, setUniform])

  // Create Leva controls
  useControls(
    () => ({
      "Uniform Registry": folder(controlConfig, {
        collapsed: false,
        order: -2,
      }),
    }),
    [controlConfig]
  )

  return {
    uniformCount: uniformEntries.length,
    uniformKeys: uniformEntries.map(([key]) => key),
  }
}

/**
 * useUniformDebug - Debug hook that logs uniform registry state
 *
 * Usage:
 *   useUniformDebug()
 */
export function useUniformDebug() {
  const uniformRegistry = useUniformStore((state) => state.uniformRegistry)

  useEffect(() => {
    console.debug("[UniformRegistry] Current uniforms:", {
      count: uniformRegistry.size,
      keys: Array.from(uniformRegistry.keys()),
      values: Object.fromEntries(
        Array.from(uniformRegistry.entries()).map(([key, reg]) => [
          key,
          {
            current: reg.uniform.value,
            initial: reg.initial,
            meta: reg.meta,
          },
        ])
      ),
    })
  }, [uniformRegistry])
}
