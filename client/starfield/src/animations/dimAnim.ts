import { useCallback, useRef } from "react"
import { easings } from "@react-spring/three"
import { useFrame } from "@react-three/fiber"

import { useUniformStore } from "@/useUniformStore"

import type { DirectionalAnimationHook } from "./types"
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
const DEFAULT_ENTER_TIME = 800
const DEFAULT_EXIT_TIME = 800

// Layer dim: 1.0 = no dimming, 0 = fully dimmed (black)
// Dims background while keeping game objects visible
const PP_LAYER_DIM_OPACITY: AnimatedPropertyConfig = {
  target: 0.5, // Dim background significantly
  anim: {
    enter: {},
    exit: {},
  },
}

// ============================================================================

export interface DimAnimationOptions {
  /** Target opacity when dimmed (0 = fully black, 1 = no dim). Default: 0.15 */
  target?: number
  /** Duration of enter animation in ms. Default: 500 */
  enterTime?: number
  /** Duration of exit animation in ms. Default: 500 */
  exitTime?: number
}

export function useDimAnimation(
  options: DimAnimationOptions = {}
): DirectionalAnimationHook<"enter" | "exit"> {
  const {
    target = PP_LAYER_DIM_OPACITY.target,
    enterTime = DEFAULT_ENTER_TIME,
    exitTime = DEFAULT_EXIT_TIME,
  } = options

  // Track animation direction for useFrame logic
  const directionRef = useRef<"enter" | "exit">("enter")

  // Main progress spring (0 = normal, 1 = dimmed)
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

  // Set uniform to dimmed state (progress=1)
  const setUniformsToDimmed = useCallback(() => {
    const { getUniform, updateUniform } = useUniformStore.getState()

    const ppLayerDimOpacity = getUniform<number>("ppLayerDimOpacity")
    if (ppLayerDimOpacity) updateUniform(ppLayerDimOpacity, target)
  }, [target])

  // Start function that triggers the spring
  const start = useCallback(
    (direction: "enter" | "exit", onComplete?: () => void) => {
      directionRef.current = direction

      if (direction === "enter") {
        startSpring(1, { duration: enterTime } as AnimationConfig).then(() =>
          onComplete?.()
        )
      } else {
        // If starting exit from idle state, snap to dimmed first
        const current = progress.get()
        if (current < PROGRESS_THRESHOLD) {
          setUniformsToDimmed()
          setSpring(1)
        }
        startSpring(0, { duration: exitTime } as AnimationConfig).then(() =>
          onComplete?.()
        )
      }
    },
    [startSpring, setSpring, progress, enterTime, exitTime, setUniformsToDimmed]
  )

  // Animate uniform each frame based on progress
  useFrame(() => {
    const p = getProgress()
    if (p === null) return

    const isEntering = directionRef.current === "enter"
    const { getUniform, updateUniform } = useUniformStore.getState()

    // --- Layer Dim ---
    const ppLayerDimOpacity = getUniform<number>("ppLayerDimOpacity")
    if (ppLayerDimOpacity) {
      // Use config with dynamic target from options
      const config: AnimatedPropertyConfig = { ...PP_LAYER_DIM_OPACITY, target }
      updateUniform(
        ppLayerDimOpacity,
        lerpAnimatedProperty(p, isEntering, ppLayerDimOpacity.initial!, config)
      )
    }
  })

  return {
    progress,
    start,
  }
}
