import { useCallback, useMemo, type PropsWithChildren } from "react"

import { useDimAnimationSpring } from "@/animations/dim"
import { useExposureAnimationSpring } from "@/animations/exposure"
import { useAnimationRuntime } from "@/animations/runtime"
import { useShockwaveAnimation } from "@/animations/shockwave"
import { useWarpAnimationSpring } from "@/animations/warp"
import { useAnimationStore } from "@/useAnimationStore"

import {
  AnimationContext,
  type AnimationContextValue,
} from "./AnimationContext"

export function AnimationController({ children }: PropsWithChildren) {
  // Callback to update store when animation state changes
  // Using getState() to avoid creating a subscription
  const handleAnimationStateChange = useCallback((isAnimating: boolean) => {
    useAnimationStore.getState().setIsAnimating(isAnimating)
  }, [])

  const runtime = useAnimationRuntime(handleAnimationStateChange)

  const { isWarping, warpProgress } = useWarpAnimationSpring(runtime)
  const { dimOpacity, dimProgress, isDimmed } = useDimAnimationSpring(runtime)
  const { shockwaveSequence, shockwaveProgress } =
    useShockwaveAnimation(runtime)
  const { exposureValue } = useExposureAnimationSpring(runtime)

  const contextValue = useMemo<AnimationContextValue>(
    () => ({
      isWarping,
      dimOpacity,
      dimProgress,
      isDimmed,
      warpProgress,
      shockwaveSequence,
      shockwaveProgress,
      exposureValue,
    }),
    [
      isWarping,
      dimOpacity,
      dimProgress,
      isDimmed,
      warpProgress,
      shockwaveSequence,
      shockwaveProgress,
      exposureValue,
    ]
  )

  return (
    <AnimationContext.Provider value={contextValue}>
      {children}
    </AnimationContext.Provider>
  )
}
