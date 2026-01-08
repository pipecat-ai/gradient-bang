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

  // Hard-coded timings for now
  const enterDuration = 1500 // 1.5 seconds to enter
  const exitDuration = 1000 // 1 second to exit

  const tunnelSpring = useSpring<TunnelSpringValues>({
    tunnelOpacity: isSceneChanging ? 1.0 : 0.0,
    tunnelDepth: isSceneChanging ? 0.1 : 0.3,
    tunnelRotationSpeed: isSceneChanging ? 0.15 : 0.0,
    config: () =>
      isSceneChanging
        ? { duration: enterDuration, easing: easings.easeInOutCubic }
        : { duration: exitDuration, easing: easings.easeOutExpo },
    onStart: runtime.start,
    onRest: runtime.end,
    onChange: runtime.onChange,
  })

  return { ...tunnelSpring, isSceneChanging }
}
