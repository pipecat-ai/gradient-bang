import { useCallback, useEffect, useRef } from "react"
import { easings } from "@react-spring/three"

import { useAnimationSpring } from "./useAnimationSpring"

export interface GameObjectAnimationOptions {
  /** Duration of fade-in animation in ms. Default: 2000 */
  duration?: number
  /** Delay before starting fade-in in ms. Default: 300 */
  delay?: number
  /** Whether to animate. Default: true */
  enabled?: boolean
  /** Duration of fade-out animation in ms. Default: 1000 */
  fadeOutDuration?: number
  /** When true, plays the fade-out animation */
  removing?: boolean
  /** Called when the fade-out animation completes */
  onRemoved?: () => void
}

/**
 * Spring-based fade-in/fade-out animation for game objects.
 *
 * Returns an `update` function to call at the start of useFrame.
 * The function returns the current fade value (0 to 1) which can be
 * used as a multiplier for opacity.
 *
 * When `removing` is set to true, the spring animates back to 0 and
 * calls `onRemoved` when complete.
 *
 * @example
 * const updateFade = useGameObjectAnimation({
 *   duration: 2000,
 *   delay: 300,
 *   removing,
 *   onRemoved: () => removePositionedGameObject(id),
 * })
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
  const {
    duration = 2000,
    delay = 300,
    enabled = true,
    fadeOutDuration = 1000,
    removing = false,
    onRemoved,
  } = options

  const { progress, start } = useAnimationSpring({
    from: enabled ? 0 : 1,
    config: {
      duration,
      easing: easings.easeOutCubic,
    },
  })

  // Track if fade-in has started
  const hasStarted = useRef(false)
  // Track if fade-out has started (prevent re-triggering)
  const isFadingOut = useRef(false)

  // Start fade-in animation after delay (only runs once on mount)
  useEffect(() => {
    if (!enabled || hasStarted.current) return

    const timeout = setTimeout(() => {
      hasStarted.current = true
      start(1)
    }, delay)

    return () => clearTimeout(timeout)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // Empty deps - only run on mount

  // Start fade-out animation when removing flag flips to true
  useEffect(() => {
    if (!removing || isFadingOut.current) return
    isFadingOut.current = true

    start(0, {
      duration: fadeOutDuration,
      easing: easings.easeInCubic,
    }).then(() => {
      onRemoved?.()
    })
  }, [removing, fadeOutDuration, onRemoved, start])

  // Update function - returns current progress (0 to 1)
  const update = useCallback((): number => {
    return progress.get()
  }, [progress])

  return update
}
