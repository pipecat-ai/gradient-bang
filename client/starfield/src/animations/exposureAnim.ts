import { useCallback, useLayoutEffect, useRef } from "react"
import { easings } from "@react-spring/three"
import { useFrame } from "@react-three/fiber"

import { useAnimationStore } from "@/useAnimationStore"
import { useUniformStore } from "@/useUniformStore"

import {
  lerpAnimatedProperty,
  PROGRESS_THRESHOLD,
  useAnimationSpring,
  type AnimatedPropertyConfig,
  type AnimationConfig,
} from "./useAnimationSpring"

// ============================================================================
// Animation Configuration
// ============================================================================

// Default animation durations (in ms)
const DEFAULT_ENTER_TIME = 500
const DEFAULT_EXIT_TIME = 500

// Exposure: 1.0 = normal, <1 = darker, >1 = brighter
// Animates to target exposure value (e.g., fade to black)
const PP_EXPOSURE: AnimatedPropertyConfig = {
  target: 0.5, // Fade to black
  anim: {
    enter: { easing: easings.easeInQuad },
    exit: { easing: easings.easeOutQuad },
  },
}

// ============================================================================

export interface ExposureAnimationOptions {
  /** Target exposure value (0 = black, 1 = normal, >1 = brighter). Default: 0 */
  target?: number
  /** Duration of enter animation in ms. Default: 500 */
  enterTime?: number
  /** Duration of exit animation in ms. Default: 500 */
  exitTime?: number
}

export function useExposureAnimation(options: ExposureAnimationOptions = {}) {
  const {
    target = PP_EXPOSURE.target,
    enterTime = DEFAULT_ENTER_TIME,
    exitTime = DEFAULT_EXIT_TIME,
  } = options

  // Track animation direction for useFrame logic
  const directionRef = useRef<"enter" | "exit">("enter")

  // Main progress spring (0 = normal, 1 = at target exposure)
  const {
    progress,
    getProgress,
    start: startSpring,
    set: setSpring,
  } = useAnimationSpring({
    from: 0,
    config: {
      duration: enterTime,
      easing: easings.easeInQuad,
    } as AnimationConfig,
  })

  // Set uniform to target exposure state (progress=1)
  const setUniformsToTarget = useCallback(() => {
    const { getUniform, updateUniform } = useUniformStore.getState()

    const ppExposure = getUniform<number>("ppExposure")
    if (ppExposure) updateUniform(ppExposure, target)
  }, [target])

  // Store the start implementation in a ref (always up-to-date)
  const startRef = useRef<
    (direction: "enter" | "exit", onComplete?: () => void) => void
  >(() => {})

  // Update the ref whenever dependencies change
  useLayoutEffect(() => {
    startRef.current = (
      direction: "enter" | "exit",
      onComplete?: () => void
    ) => {
      directionRef.current = direction

      if (direction === "enter") {
        startSpring(1, { duration: enterTime } as AnimationConfig).then(() =>
          onComplete?.()
        )
      } else {
        // If starting exit from idle state, snap to target first
        const current = progress.get()
        if (current < PROGRESS_THRESHOLD) {
          setUniformsToTarget()
          setSpring(1)
        }
        startSpring(0, { duration: exitTime } as AnimationConfig).then(() =>
          onComplete?.()
        )
      }
    }
  }, [
    startSpring,
    setSpring,
    progress,
    enterTime,
    exitTime,
    setUniformsToTarget,
  ])

  // Register in the animation store (once on mount)
  useLayoutEffect(() => {
    useAnimationStore.getState().registerAnimation("exposure", {
      start: (direction, onComplete) => startRef.current(direction, onComplete),
    })
  }, [])

  // Animate uniform each frame based on progress
  useFrame(() => {
    const p = getProgress()
    if (p === null) return

    const isEntering = directionRef.current === "enter"
    const { getUniform, updateUniform } = useUniformStore.getState()

    // --- Exposure ---
    const ppExposure = getUniform<number>("ppExposure")
    if (ppExposure) {
      // Use config with dynamic target from options
      const config: AnimatedPropertyConfig = { ...PP_EXPOSURE, target }
      updateUniform(
        ppExposure,
        lerpAnimatedProperty(p, isEntering, ppExposure.initial!, config)
      )
    }
  })

  // Return progress for any components that need to read it
  return { progress }
}
