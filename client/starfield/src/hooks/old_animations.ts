import { useContext, useEffect, useRef } from "react"

import { AnimationContext } from "@/controllers/AnimationContext"
import { useAnimationStore } from "@/useAnimationStore"

/**
 * Animation Hooks
 *
 * These hooks provide access to animation spring values and metadata.
 *
 * To add a new animation hook:
 * 1. Get context with useContext(AnimationContext)
 * 2. Return the relevant spring values and metadata
 * 3. Follow the existing pattern for consistency
 *
 * @example
 * export function useFade() {
 *   const context = useContext(AnimationContext)
 *   if (!context) throw new Error("useFade must be used within AnimationController")
 *   return { fadeOpacity: context.fadeOpacity, isFading: context.isFading }
 * }
 */

export function useWarpAnimation() {
  const context = useContext(AnimationContext)
  if (!context) {
    throw new Error("useWarpAnimation must be used within AnimationController")
  }
  return {
    progress: context.warpProgress,
    isWarping: context.isWarping,
  }
}

export function useShockwave() {
  const context = useContext(AnimationContext)
  if (!context) {
    throw new Error("useShockwave must be used within AnimationController")
  }
  const triggerShockwave = useAnimationStore((state) => state.triggerShockwave)
  return {
    shockwaveSequence: context.shockwaveSequence,
    progress: context.shockwaveProgress,
    triggerShockwave,
  }
}

export function useLayerDim() {
  const context = useContext(AnimationContext)
  if (!context) {
    throw new Error("useLayerDim must be used within AnimationController")
  }
  return {
    dimOpacity: context.dimOpacity,
    progress: context.dimProgress,
    isDimmed: context.isDimmed,
  }
}

export function useExposure() {
  const context = useContext(AnimationContext)
  if (!context) {
    throw new Error("useExposure must be used within AnimationController")
  }
  const setExposure = useAnimationStore((state) => state.setExposure)
  return {
    exposureValue: context.exposureValue,
    setExposure,
  }
}

export function useWarpExitEffect(callback: () => void, delay: number = 0) {
  const { isWarping } = useWarpAnimation()
  const previousWarpingRef = useRef(isWarping)
  const timeoutRef = useRef<number | null>(null)
  const callbackRef = useRef(callback)

  useEffect(() => {
    callbackRef.current = callback
  }, [callback])

  useEffect(() => {
    if (previousWarpingRef.current && !isWarping) {
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current)
      }

      const delayMs = Math.max(delay, 0)

      timeoutRef.current = window.setTimeout(() => {
        callbackRef.current()
        timeoutRef.current = null
      }, delayMs)
    }

    previousWarpingRef.current = isWarping

    return () => {
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [isWarping, delay])
}
