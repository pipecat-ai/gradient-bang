import { useLayoutEffect } from "react"
import { invalidate, useFrame } from "@react-three/fiber"

import { useAnimationStore } from "@/useAnimationStore"
import { useGameStore } from "@/useGameStore"

/**
 * Shockwave animation hook - single-shot ripple effect
 *
 * The ShockWaveEffect has its own internal animation triggered by explode().
 * Duration is determined by shockwaveSpeed from the config.
 * Uses performance.now() to track when explode actually fires.
 */
export function useShockwaveAnimation() {
  const { shockwave: shockwaveConfig } = useGameStore(
    (state) => state.starfieldConfig
  )

  // Track animation completion using actual start time from store
  useFrame(() => {
    const { shockwaveStartTime, setShockwave, decrementAnimating, setShockwaveStartTime } =
      useAnimationStore.getState()

    if (shockwaveStartTime === null) return

    // Keep invalidating while animating
    invalidate()

    // Check if animation is complete
    // The visual effect runs longer than just the wave reaching maxRadius
    // Double the configured speed to match the full visual animation, plus 500ms buffer
    const durationMs = Math.max(shockwaveConfig?.speed ?? 0.5, 0.1) * 2 * 1000 + 500
    const elapsed = performance.now() - shockwaveStartTime

    if (elapsed >= durationMs) {
      setShockwaveStartTime(null)
      setShockwave(false)
      decrementAnimating()
    }
  })

  // Register in the animation store (once on mount)
  useLayoutEffect(() => {
    useAnimationStore.getState().registerAnimation("shockwave", {
      start: () => {
        const { triggerShockwave, incrementAnimating } = useAnimationStore.getState()
        triggerShockwave()
        incrementAnimating()
        invalidate()
      },
    })
  }, [])
}
