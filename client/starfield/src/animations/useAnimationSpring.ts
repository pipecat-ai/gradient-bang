import { useCallback, useRef } from "react"
import { SpringValue, useSpring } from "@react-spring/three"
import { invalidate } from "@react-three/fiber"

import { useAnimationStore } from "@/useAnimationStore"

// ============================================================================
// Easing & Animation Utilities
// ============================================================================

/** Easing function type */
export type EasingFn = (t: number) => number

/** Linear easing (no transformation) - use when spring easing is sufficient */
export const linear: EasingFn = (t) => t

/**
 * Configuration for animating a property with custom timing and easing.
 *
 * @example
 * // Fast on enter (complete at 25%), linear on exit
 * { enter: { offset: 0.25 }, exit: {} }
 *
 * // Custom easing both directions, complete at 75% on exit
 * { enter: { easing: easings.easeInCubic }, exit: { easing: easings.easeOutExpo, offset: 0.75 } }
 */
export interface PropertyAnimationConfig {
  enter?: {
    /** Easing function (defaults to linear) */
    easing?: EasingFn
    /** Complete at this point in the animation (0-1). 0.25 = 25% of duration */
    offset?: number
    /** Delay start until this point (0-1). 0.4 = start at 40% */
    delay?: number
  }
  exit?: {
    /** Easing function (defaults to linear) */
    easing?: EasingFn
    /** Complete at this point in the animation (0-1). 0.75 = 75% of duration */
    offset?: number
    /** Delay start until this point (0-1) */
    delay?: number
  }
}

/**
 * Configuration for an animated property with target, optional start/end values, and timing.
 *
 * @example
 * // Simple: animate from initial to target, back to initial
 * { target: 165, anim: { enter: { easing: easings.easeInCubic } } }
 *
 * // With start: snap to 50 at enter start, animate to 165
 * { target: 165, start: 50, anim: {} }
 *
 * // With end: animate from initial to 165 on enter, back to 100 on exit (not initial)
 * { target: 165, end: 100, anim: {} }
 *
 * // Full control: start at 50, animate to 165, exit back to 100
 * { target: 165, start: 50, end: 100, anim: {} }
 */
export interface AnimatedPropertyConfig {
  /** Target value to animate to during enter (when progress = 1) */
  target: number
  /** Optional: value to start from when enter begins (snaps to this at progress = 0) */
  start?: number
  /** Optional: value to animate back to during exit (defaults to uniform's initial) */
  end?: number
  /** Animation timing config per direction */
  anim: PropertyAnimationConfig
}

/**
 * Calculate the animated value for a property given progress and direction.
 *
 * Handles:
 * - Custom start value (used as base for enter instead of initial)
 * - Custom end value (used as base for exit instead of initial)
 * - Timing/easing via animateProgress
 *
 * @param progress - Raw spring progress (0 to 1)
 * @param isEntering - Whether animating in the "enter" direction
 * @param initial - The uniform's initial/default value
 * @param config - Property animation config
 * @returns The interpolated value for this frame
 *
 * @example
 * const cameraFov = getUniform<number>("cameraFov")
 * if (cameraFov) {
 *   updateUniform(cameraFov, lerpAnimatedProperty(p, isEntering, cameraFov.initial!, CAMERA_FOV))
 * }
 */
export function lerpAnimatedProperty(
  progress: number,
  isEntering: boolean,
  initial: number,
  config: AnimatedPropertyConfig
): number {
  const animatedP = animateProgress(progress, isEntering, config.anim)

  // Determine the "base" value (where progress = 0 leads)
  // - Enter: use start if defined, otherwise initial
  // - Exit: use end if defined, otherwise initial
  const baseValue = isEntering
    ? (config.start ?? initial)
    : (config.end ?? initial)

  // Lerp between base and target
  // When animatedP = 0: returns baseValue
  // When animatedP = 1: returns target
  return baseValue + (config.target - baseValue) * animatedP
}

/**
 * Transform raw progress into animated progress with timing and easing.
 *
 * Handles:
 * - Offset: Complete animation early (e.g., offset: 0.25 = finish at 25%)
 * - Delay: Start animation late (e.g., delay: 0.4 = start at 40%)
 * - Easing: Apply custom easing function (defaults to linear)
 *
 * @param p - Raw progress value (0 to 1)
 * @param isEntering - Whether animating in the "enter" direction
 * @param config - Optional animation config
 * @returns Transformed progress value (0 to 1)
 *
 * @example
 * // Simple linear animation (no config)
 * const progress = animateProgress(p, isEntering)
 *
 * // Reach target at 25% of enter duration
 * const fastP = animateProgress(p, isEntering, {
 *   enter: { offset: 0.25 }
 * })
 *
 * // Custom easing per direction, finish at 75% on exit
 * const easedP = animateProgress(p, isEntering, {
 *   enter: { easing: easings.easeInCubic },
 *   exit: { easing: easings.easeOutExpo, offset: 0.75 }
 * })
 *
 * // Delayed start on enter with easing
 * const delayedP = animateProgress(p, isEntering, {
 *   enter: { delay: 0.4, easing: easings.easeInCubic }
 * })
 */
export const animateProgress = (
  p: number,
  isEntering: boolean,
  config?: PropertyAnimationConfig
): number => {
  const dirConfig = isEntering ? config?.enter : config?.exit
  const easing = dirConfig?.easing ?? linear
  const offset = dirConfig?.offset
  const delay = dirConfig?.delay

  let result = p

  // Apply offset (complete early)
  // offset: 0.25 means animation completes when p reaches 0.25 (on enter) or 0.75 (on exit)
  if (offset !== undefined && offset > 0 && offset < 1) {
    if (isEntering) {
      // Enter: p goes 0→1, complete at offset (e.g., p/0.25 clamped)
      result = Math.min(result / offset, 1)
    } else {
      // Exit: p goes 1→0, complete at (1 - offset) of duration
      // e.g., offset=0.75 means finish at 75%, so p goes 1→0.25 for effects
      const endPoint = 1 - offset
      result = Math.max((result - endPoint) / offset, 0)
    }
  }

  // Apply delay (start late)
  // delay: 0.4 means animation starts when p reaches 0.4
  if (delay !== undefined && delay > 0 && delay < 1) {
    if (isEntering) {
      // Enter: don't start until p > delay
      result = Math.max((result - delay) / (1 - delay), 0)
    } else {
      // Exit: don't start until p < (1 - delay)
      const startPoint = 1 - delay
      result = Math.min(result / startPoint, 1)
    }
  }

  // Apply easing
  return easing(result)
}

/**
 * @deprecated Use animateProgress instead for more flexibility
 */
export const applyEasing = (
  p: number,
  isEntering: boolean,
  enterEasing: EasingFn = linear,
  exitEasing: EasingFn = linear
): number => (isEntering ? enterEasing(p) : exitEasing(p))

// ============================================================================

/** Spring animation config */
export interface AnimationConfig {
  duration?: number
  easing?: (t: number) => number
  // Physics-based config (alternative to duration)
  mass?: number
  tension?: number
  friction?: number
  clamp?: boolean
  precision?: number
  velocity?: number
}

export interface AnimationSpringOptions {
  /** Initial spring value (0 to 1 typically) */
  from: number
  /** Spring config (duration, easing, etc.) */
  config?: AnimationConfig
  /** Called when animation starts */
  onStart?: () => void
  /** Called when animation completes (after final frame is rendered) */
  onComplete?: () => void
}

/** Threshold for considering animation complete/idle */
export const PROGRESS_THRESHOLD = 0.001

export interface AnimationSpringResult {
  /** The spring progress value (use .get() in useFrame) */
  progress: SpringValue<number>
  /** Get progress if animating, null if should skip (use in useFrame) */
  getProgress: () => number | null
  /** Start animating to target value */
  start: (to: number, config?: AnimationConfig) => Promise<void>
  /** Immediately set progress without animating */
  set: (value: number) => void
  /** Stop the animation */
  stop: () => void
  /** Whether this spring is currently animating */
  isAnimating: React.RefObject<boolean>
}

type ProgressSpring = { progress: SpringValue<number> }

/**
 * A spring hook that integrates with R3F's demand rendering mode.
 *
 * Handles:
 * - Setting isAnimating in the animation store
 * - Calling invalidate() on every spring change
 * - Ensuring final values are rendered before cleanup (double rAF)
 *
 * @example
 * const { progress, start } = useAnimationSpring({ from: 0 })
 *
 * // In useFrame:
 * const p = progress.get()
 *
 * // To animate:
 * start(1, { duration: 1000 })
 */
export function useAnimationSpring(
  options: AnimationSpringOptions
): AnimationSpringResult {
  const { from, config: defaultConfig, onStart, onComplete } = options

  const setIsAnimating = useAnimationStore((state) => state.setIsAnimating)
  const isAnimatingRef = useRef(false)

  const [spring, api] = useSpring<ProgressSpring>(() => ({
    progress: from,
    config: defaultConfig,
    onChange: () => {
      invalidate()
    },
    onRest: () => {
      // Delay cleanup by one frame to ensure final uniform values are applied
      requestAnimationFrame(() => {
        invalidate() // One final render with the completed values
        requestAnimationFrame(() => {
          isAnimatingRef.current = false
          setIsAnimating(false)
          onComplete?.()
        })
      })
    },
  }))

  const start = useCallback(
    (to: number, config?: AnimationConfig) => {
      // Skip if already at target value (prevents stuck isAnimating state)
      const current = spring.progress.get()
      if (Math.abs(current - to) < PROGRESS_THRESHOLD) {
        return Promise.resolve()
      }

      // Set animating BEFORE starting spring to ensure render loop is active
      isAnimatingRef.current = true
      setIsAnimating(true)
      onStart?.()

      // Kick off the first frame
      invalidate()

      // Default to linear easing unless specified
      const finalConfig = {
        easing: linear,
        ...defaultConfig,
        ...config,
      }

      return new Promise<void>((resolve) => {
        api.start({
          progress: to,
          config: finalConfig,
          onRest: () => {
            // Delay cleanup by one frame to ensure final uniform values are applied
            requestAnimationFrame(() => {
              invalidate()
              requestAnimationFrame(() => {
                isAnimatingRef.current = false
                setIsAnimating(false)
                onComplete?.()
                resolve()
              })
            })
          },
        })
      })
    },
    [api, spring.progress, defaultConfig, onStart, onComplete, setIsAnimating]
  )

  const stop = useCallback(() => {
    api.stop()
    isAnimatingRef.current = false
    setIsAnimating(false)
  }, [api, setIsAnimating])

  // Immediately set progress without animating
  const set = useCallback(
    (value: number) => {
      api.set({ progress: value })
      invalidate()
    },
    [api]
  )

  // Returns progress if animating, null if should skip
  // Only return progress while actively animating to prevent drift after completion
  const getProgress = useCallback((): number | null => {
    if (!isAnimatingRef.current) {
      return null
    }
    return spring.progress.get()
  }, [spring.progress])

  return {
    progress: spring.progress,
    getProgress,
    start,
    set,
    stop,
    isAnimating: isAnimatingRef,
  }
}
