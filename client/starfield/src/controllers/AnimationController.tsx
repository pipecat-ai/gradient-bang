import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from "react"
import { easings, useSpring, type SpringValue } from "@react-spring/three"
import { useThree } from "@react-three/fiber"

import { useAnimationStore } from "@/useAnimationStore"
import { useGameStore } from "@/useGameStore"

import {
  AnimationContext,
  type AnimationContextValue,
} from "./AnimationContext"

type WarpSpringValues = {
  scale: SpringValue<number>
  rotationSpeed: SpringValue<number>
  warpProgress: SpringValue<number>
  glowIntensity: SpringValue<number>
  distortion: SpringValue<number>
}

type DimSpringValues = {
  dimOpacity: SpringValue<number>
}

/**
 * Internal utility hook for creating animation springs with consistent behavior
 *
 * Automatically handles:
 * - Animation state tracking via global counter
 * - Consistent configuration pattern
 *
 * @example
 * const fadeSpring = useAnimationSpring<FadeSpringValues>({
 *   trigger: shouldFade,
 *   values: { fadeOpacity: [1, 0] },
 *   config: { duration: 300, easing: easings.easeInOut },
 *   onStart: startAnimation,
 *   onEnd: endAnimation
 * })
 */
function useAnimationSpring<T extends object>({
  trigger,
  values,
  config,
  onStart,
  onEnd,
}: {
  trigger: boolean
  values: Record<string, [inactive: number, active: number]>
  config:
    | ((trigger: boolean) => {
        duration?: number
        easing?: (t: number) => number
      })
    | { duration?: number; easing?: (t: number) => number }
  onStart: () => void
  onEnd: () => void
}) {
  const springConfig = useMemo(() => {
    const conf: Record<string, number> = {}
    for (const key in values) {
      const [inactive, active] = values[key]
      conf[key] = trigger ? active : inactive
    }
    console.log(
      "[useAnimationSpring] springConfig updated, trigger:",
      trigger,
      "config:",
      conf
    )
    return conf
  }, [trigger, values])

  const springConfigWithCallbacks = useMemo(() => {
    console.log(
      "[useAnimationSpring] springConfigWithCallbacks updated, trigger:",
      trigger
    )
    return {
      ...springConfig,
      config: typeof config === "function" ? config(trigger) : config,
      onStart,
      onRest: onEnd,
    }
  }, [springConfig, config, trigger, onStart, onEnd])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const spring = useSpring(springConfigWithCallbacks as any) as T

  return spring
}

export function AnimationController({ children }: PropsWithChildren) {
  const { isWarping, isDimmed } = useAnimationStore()
  const setIsAnimating = useAnimationStore((state) => state.setIsAnimating)
  const {
    hyperspaceEnterTime,
    hyperspaceExitTime,
    shockwaveSpeed = 1.25,
    layerDimDuration = 300,
  } = useGameStore((state) => state.starfieldConfig)
  const { invalidate } = useThree()
  const [shockwaveSequence, setShockwaveSequence] = useState(0)
  const activeAnimationsRef = useRef(0)
  const animationRafRef = useRef<number | null>(null)
  const shockwaveRafRef = useRef<number | null>(null)

  const shockwaveActiveMs = useMemo(
    () => Math.max(shockwaveSpeed, 0) * 1000,
    [shockwaveSpeed]
  )

  // Helper functions to manage global animation state
  const startAnimation = useCallback(() => {
    activeAnimationsRef.current++
    console.log(
      "[AnimationController] startAnimation - count:",
      activeAnimationsRef.current
    )
    if (activeAnimationsRef.current > 0) {
      setIsAnimating(true)
      console.log("[AnimationController] setIsAnimating(true)")
    }
  }, [setIsAnimating])

  const endAnimation = useCallback(() => {
    activeAnimationsRef.current--
    console.log(
      "[AnimationController] endAnimation - count:",
      activeAnimationsRef.current
    )
    if (activeAnimationsRef.current <= 0) {
      activeAnimationsRef.current = 0
      setIsAnimating(false)
      console.log("[AnimationController] setIsAnimating(false)")
    }
  }, [setIsAnimating])

  const triggerShockwave = useCallback(() => {
    setShockwaveSequence((value) => value + 1)
    startAnimation()

    const endTime = performance.now() + shockwaveActiveMs

    if (shockwaveRafRef.current) {
      return
    }

    const tick = () => {
      if (performance.now() < endTime) {
        shockwaveRafRef.current = requestAnimationFrame(tick)
      } else {
        shockwaveRafRef.current = null
        endAnimation()
      }
    }

    shockwaveRafRef.current = requestAnimationFrame(tick)
  }, [startAnimation, endAnimation, shockwaveActiveMs])

  // Memoize values objects to ensure stable references
  const warpValues = useMemo(
    () => ({
      scale: [0.95, 1.25] as [number, number],
      rotationSpeed: [0.3, 2] as [number, number],
      warpProgress: [0, 1] as [number, number],
      glowIntensity: [1, 3] as [number, number],
      distortion: [0, 0.5] as [number, number],
    }),
    []
  )

  const dimValues = useMemo(
    () => ({
      dimOpacity: [1.0, 0.3] as [number, number],
    }),
    []
  )

  // Memoize config objects to ensure stable references
  const warpConfig = useCallback(
    (trigger: boolean) =>
      trigger
        ? {
            duration: hyperspaceEnterTime,
            easing: easings.easeInQuad,
          }
        : {
            duration: hyperspaceExitTime,
            easing: easings.easeOutExpo,
          },
    [hyperspaceEnterTime, hyperspaceExitTime]
  )

  const dimConfig = useMemo(
    () => ({
      duration: layerDimDuration,
      easing: easings.easeInOutQuad,
    }),
    [layerDimDuration]
  )

  // Memoize callbacks for dim animation
  const dimOnStart = useCallback(() => {
    console.log("[DimSpring] onStart called")
    startAnimation()
  }, [startAnimation])

  const dimOnEnd = useCallback(() => {
    console.log("[DimSpring] onEnd called")
    endAnimation()
  }, [endAnimation])

  const warpSpring = useAnimationSpring<WarpSpringValues>({
    trigger: isWarping,
    values: warpValues,
    config: warpConfig,
    onStart: startAnimation,
    onEnd: endAnimation,
  })

  const dimSpring = useAnimationSpring<DimSpringValues>({
    trigger: isDimmed,
    values: dimValues,
    config: dimConfig,
    onStart: dimOnStart,
    onEnd: dimOnEnd,
  })

  console.log(
    "[AnimationController] isDimmed:",
    isDimmed,
    "dimSpring:",
    dimSpring
  )

  // Global RAF loop for all animations
  const isAnimating = useAnimationStore((state) => state.isAnimating)

  useEffect(() => {
    console.log(
      "[AnimationController] RAF Loop effect - isAnimating:",
      isAnimating
    )
    if (!isAnimating) {
      if (animationRafRef.current) {
        console.log("[AnimationController] Stopping RAF loop")
        cancelAnimationFrame(animationRafRef.current)
        animationRafRef.current = null
      }
      return
    }

    console.log("[AnimationController] Starting RAF loop")
    const tick = () => {
      invalidate()
      animationRafRef.current = requestAnimationFrame(tick)
    }

    tick()

    return () => {
      if (animationRafRef.current) {
        console.log("[AnimationController] Cleanup RAF loop")
        cancelAnimationFrame(animationRafRef.current)
        animationRafRef.current = null
      }
    }
  }, [isAnimating, invalidate])

  // Cleanup shockwave RAF on unmount
  useEffect(() => {
    return () => {
      if (shockwaveRafRef.current) {
        cancelAnimationFrame(shockwaveRafRef.current)
        shockwaveRafRef.current = null
      }
    }
  }, [])

  const { scale, rotationSpeed, warpProgress, glowIntensity, distortion } =
    warpSpring

  const { dimOpacity } = dimSpring

  const contextValue = useMemo<AnimationContextValue>(
    () => ({
      scale,
      rotationSpeed,
      warpProgress,
      glowIntensity,
      distortion,
      isWarping,
      isAnimating,
      dimOpacity,
      isDimmed,
      shockwaveSequence,
      triggerShockwave,
    }),
    [
      scale,
      rotationSpeed,
      warpProgress,
      glowIntensity,
      distortion,
      isWarping,
      isAnimating,
      dimOpacity,
      isDimmed,
      shockwaveSequence,
      triggerShockwave,
    ]
  )

  return (
    <AnimationContext.Provider value={contextValue}>
      {children}
    </AnimationContext.Provider>
  )
}
