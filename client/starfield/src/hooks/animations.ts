import { useContext, useEffect, useRef } from "react"

import { AnimationContext } from "@/controllers/AnimationContext"

export function useWarpAnimation() {
  const context = useContext(AnimationContext)
  if (!context) {
    throw new Error("useWarpAnimation must be used within AnimationController")
  }
  return {
    scale: context.scale,
    rotationSpeed: context.rotationSpeed,
    warpProgress: context.warpProgress,
    glowIntensity: context.glowIntensity,
    distortion: context.distortion,
    isWarping: context.isWarping,
    isAnimating: context.isAnimating,
  }
}

export function useShockwave() {
  const context = useContext(AnimationContext)
  if (!context) {
    throw new Error("useShockwave must be used within AnimationController")
  }
  return {
    shockwaveSequence: context.shockwaveSequence,
    triggerShockwave: context.triggerShockwave,
  }
}

export function useLayerDim() {
  const context = useContext(AnimationContext)
  if (!context) {
    throw new Error("useLayerDim must be used within AnimationController")
  }
  return {
    dimOpacity: context.dimOpacity,
    isDimmed: context.isDimmed,
    isDimAnimating: context.isDimAnimating,
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
