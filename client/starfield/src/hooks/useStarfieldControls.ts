import { useEffect, useMemo, useRef } from "react"
import { useControls } from "leva"
import { shallow } from "zustand/shallow"

import type { StarfieldPalette } from "@/colors"
import type { StarfieldConfig } from "@/types"
import { useGameStore } from "@/useGameStore"

const IS_DEV = import.meta.env.DEV

/**
 * Hook to determine if Leva controls should be shown.
 * Returns true only when both IS_DEV build flag and debug prop are true.
 */
export function useShowControls(): boolean {
  const debug = useGameStore((state) => state.debug)
  return IS_DEV && debug
}

/**
 * Hook for component config controls with optional Leva UI.
 * Returns config values from store, with Leva controls only in dev+debug mode.
 */
export function useSceneControls<T extends object>(
  name: string,
  configSelector: (config: StarfieldConfig) => T,
  levaSchema: Parameters<typeof useControls>[1]
): T {
  const showControls = useShowControls()
  const configValues = useGameStore((state) =>
    configSelector(state.starfieldConfig)
  )

  const levaValues = useControls(name, showControls ? levaSchema : {})

  return showControls ? (levaValues as unknown as T) : configValues
}

/**
 * Options for the control sync hook.
 * @template T The config object shape
 */
interface UseControlSyncOptions<T extends object> {
  /** Source config from Zustand store */
  source?: Partial<T> | null
  /** Default values for all properties */
  defaults: T
  /** Palette used to derive color defaults (optional - only needed for color properties) */
  palette?: StarfieldPalette
  /** Keys to sync to Leva when source changes */
  sync: readonly (keyof T)[]
  /** Current Leva values from useControls */
  levaValues: Partial<T>
  /** Leva set function from useControls */
  set: (values: Partial<T>) => void
}

/**
 * Syncs config values between store and Leva, returns stable config.
 *
 * - Builds fallback from: defaults + palette colors + source overrides
 * - When Leva visible: uses levaValues, syncs source/palette changes to Leva
 * - When Leva hidden: uses fallback
 * - Returns shallow-compared stable reference (only changes when values change)
 */
export function useControlSync<T extends object>(
  options: UseControlSyncOptions<T>
): T {
  const { source, defaults, palette, sync, levaValues, set } = options
  const showControls = useShowControls()

  // Build fallback: defaults + palette colors (if provided) + source overrides
  const fallback = useMemo(() => {
    const merged = { ...defaults } as T & Record<string, unknown>

    // Apply palette-derived colors if palette provided and those keys exist in defaults
    if (palette) {
      if ("color" in merged)
        (merged as Record<string, unknown>).color =
          `#${palette.tint.getHexString()}`
      if ("primaryColor" in merged)
        (merged as Record<string, unknown>).primaryColor =
          `#${palette.c1.getHexString()}`
      if ("secondaryColor" in merged)
        (merged as Record<string, unknown>).secondaryColor =
          `#${palette.c2.getHexString()}`
      if ("base" in merged)
        (merged as Record<string, unknown>).base =
          `#${palette.base.getHexString()}`
    }

    // Override with source values
    if (source) {
      ;(Object.keys(source) as Array<keyof T>).forEach((key) => {
        const value = source[key]
        if (value !== undefined) {
          ;(merged as Record<keyof T, unknown>)[key] = value
        }
      })
    }

    return merged as T
  }, [defaults, palette, source])

  // Track if we've mounted (skip syncing on initial render)
  const hasMounted = useRef(false)
  // Track previous source to detect actual source changes (not Leva changes)
  const prevSourceRef = useRef(source)
  const prevPaletteRef = useRef(palette)

  // Sync transient keys to Leva when SOURCE changes (not when Leva changes)
  useEffect(() => {
    if (!hasMounted.current || !showControls || !source) return

    // Only sync if source actually changed (shallow compare)
    if (shallow(prevSourceRef.current, source)) return
    prevSourceRef.current = source

    const updates: Partial<T> = {}
    sync.forEach((key) => {
      const sourceValue = source[key]
      if (sourceValue !== undefined) {
        updates[key] = sourceValue
      }
    })
    if (Object.keys(updates).length > 0) {
      set(updates)
    }
  }, [showControls, source, sync, set])

  // Sync palette colors to Leva when PALETTE changes (not when Leva changes)
  useEffect(() => {
    if (!hasMounted.current || !showControls || !palette) return

    // Only sync if palette actually changed
    if (prevPaletteRef.current === palette) return
    prevPaletteRef.current = palette

    const hasColorOverride =
      source && "color" in source && source.color !== undefined
    const hasPrimaryOverride =
      source && "primaryColor" in source && source.primaryColor !== undefined
    const hasSecondaryOverride =
      source &&
      "secondaryColor" in source &&
      source.secondaryColor !== undefined
    const hasBaseOverride =
      source && "base" in source && source.base !== undefined

    const updates: Record<string, string> = {}

    if (!hasColorOverride && "color" in defaults) {
      updates.color = `#${palette.tint.getHexString()}`
    }
    if (!hasPrimaryOverride && "primaryColor" in defaults) {
      updates.primaryColor = `#${palette.c1.getHexString()}`
    }
    if (!hasSecondaryOverride && "secondaryColor" in defaults) {
      updates.secondaryColor = `#${palette.c2.getHexString()}`
    }
    if (!hasBaseOverride && "base" in defaults) {
      updates.base = `#${palette.base.getHexString()}`
    }

    if (Object.keys(updates).length > 0) {
      try {
        set(updates as Partial<T>)
      } catch {
        // Controls may not be mounted
      }
    }
  }, [showControls, palette, source, defaults, set])

  // Mark as mounted AFTER sync effects have had a chance to skip
  useEffect(() => {
    hasMounted.current = true
  }, [])

  // Pick raw config: levaValues when visible (Leva is source of truth), fallback when not
  // The sync effects handle pushing source changes to Leva
  const rawConfig = showControls ? (levaValues as T) : fallback

  // Stabilize config - only return new reference when values actually change
  // This pattern intentionally accesses ref during render for memoization
  const prevConfigRef = useRef(rawConfig)
  /* eslint-disable */
  const stableConfig = useMemo(() => {
    if (!shallow(prevConfigRef.current, rawConfig)) {
      prevConfigRef.current = rawConfig
    }
    return prevConfigRef.current
  }, [rawConfig])
  /* eslint-enable */

  return stableConfig
}
