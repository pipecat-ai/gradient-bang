import { easings, useSpring, type SpringValue } from "@react-spring/three"

import { useGameStore } from "@/useGameStore"

import type { AnimationRuntime } from "./runtime"

export type TunnelSpringValues = {
  tunnelOpacity: SpringValue<number>
  tunnelDepth: SpringValue<number>
  tunnelRotationSpeed: SpringValue<number>
}

export function useTunnelAnimationSpring(runtime: AnimationRuntime) {
  const isSceneChanging = useGameStore((state) => state.isSceneChanging)
  const showDuringAnimation = useGameStore(
    (state) => state.starfieldConfig.tunnel?.showDuringAnimation ?? false
  )

  // Hard-coded timings for now
  const enterDuration = 1500 // 1.5 seconds to enter
  const exitDuration = 1000 // 1 second to exit

  // Only animate if showDuringAnimation is enabled
  const shouldAnimate = isSceneChanging && showDuringAnimation

  const tunnelSpring = useSpring<TunnelSpringValues>({
    tunnelOpacity: shouldAnimate ? 1.0 : 0.0,
    tunnelDepth: shouldAnimate ? 0.1 : 0.3,
    tunnelRotationSpeed: shouldAnimate ? 0.15 : 0.0,
    config: () =>
      shouldAnimate
        ? { duration: enterDuration, easing: easings.easeInOutCubic }
        : { duration: exitDuration, easing: easings.easeOutExpo },
    onStart: runtime.start,
    onRest: runtime.end,
    onChange: runtime.onChange,
  })

  return { ...tunnelSpring, isSceneChanging }
}
