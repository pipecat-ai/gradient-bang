import { useEffect, useRef } from "react"
import { invalidate } from "@react-three/fiber"

export interface GameObjectAnimationOptions {
  /** Duration of fade-in animation in ms. Default: 2000 */
  duration?: number
  /** Delay before starting fade-in in ms. Default: 300 */
  delay?: number
  /** Whether to animate. Default: true */
  enabled?: boolean
}

/**
 * Simple time-based fade-in animation for game objects.
 *
 * Returns an `update` function to call at the start of useFrame.
 * The function updates the animation progress and returns the current
 * fade value (0 to 1) which can be used as a multiplier for opacity.
 *
 * @example
 * const updateFade = useGameObjectAnimation({ duration: 2000, delay: 300 })
 *
 * useFrame(() => {
 *   const fade = updateFade()
 *   imageMaterial.opacity = targetOpacity * fade
 *   shadowMaterial.uniforms.uOpacity.value = shadowOpacity * fade
 * })
 */
export function useGameObjectAnimation(
  options: GameObjectAnimationOptions = {}
): () => number {
  const { duration = 2000, delay = 300, enabled = true } = options

  // Refs to track animation state - these persist across re-renders
  const startTime = useRef<number | null>(null)
  const progress = useRef(enabled ? 0 : 1)

  // Capture duration in a ref so update() always has the correct value
  const durationRef = useRef(duration)
  durationRef.current = duration

  // Schedule animation start after delay (only runs once on mount)
  useEffect(() => {
    if (!enabled) return

    const timeout = setTimeout(() => {
      startTime.current = performance.now()
      invalidate()
    }, delay)

    return () => clearTimeout(timeout)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // Empty deps - only run on mount

  // Update function - call this at the start of useFrame
  // Returns current progress (0 to 1)
  const update = (): number => {
    if (startTime.current !== null && progress.current < 1) {
      const elapsed = performance.now() - startTime.current
      progress.current = Math.min(elapsed / durationRef.current, 1)
      if (progress.current < 1) {
        invalidate() // Keep the render loop going
      }
    }
    return progress.current
  }

  return update
}
