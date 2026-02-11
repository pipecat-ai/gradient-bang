import { useEffect, useRef } from "react"
import { easings } from "@react-spring/three"

import { useAnimationSpring } from "./useAnimationSpring"

export interface JumpFlashAnimationOptions {
  /** Duration of the flash in ms. Default: 400 */
  duration?: number
  /** Delay before starting in ms. Default: 0 */
  delay?: number
  /** Called when the animation finishes — parent should unmount */
  onComplete?: () => void
}

/**
 * One-shot spring animation for a jump flash effect.
 *
 * Automatically starts on mount, animates progress from 0 → 1,
 * and fires `onComplete` when done. No enter/exit phases — just
 * a single burst.
 *
 * Returns a `getProgress` function to call inside useFrame.
 * Returns the current progress (0–1) while animating, or null
 * when idle (same pattern as gameObjectFadeAnim).
 *
 * @example
 * const getProgress = useJumpFlashAnimation({
 *   duration: 400,
 *   onComplete: () => removeEffect(id),
 * })
 *
 * useFrame(() => {
 *   const p = getProgress()
 *   if (p === null) return
 *   mesh.scale.setScalar(baseScale * (0.2 + 0.8 * p))
 *   material.opacity = Math.sin(p * Math.PI)
 * })
 */
export function useJumpFlashAnimation(
  options: JumpFlashAnimationOptions = {}
): () => number | null {
  const { duration = 400, delay = 0, onComplete } = options

  const { start, getProgress } = useAnimationSpring({
    from: 0,
    config: {
      duration,
      easing: easings.easeOutCubic,
    },
    onComplete,
  })

  // Track if the animation has been kicked off (prevent re-triggering)
  const hasStarted = useRef(false)

  // Auto-start on mount after optional delay
  useEffect(() => {
    if (hasStarted.current) return
    hasStarted.current = true

    if (delay > 0) {
      const timeout = setTimeout(() => {
        start(1)
      }, delay)
      return () => clearTimeout(timeout)
    }

    start(1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // Empty deps — only run on mount

  return getProgress
}
