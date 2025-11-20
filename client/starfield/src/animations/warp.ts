import { easings, useSpring, type SpringValue } from "@react-spring/three"

import { useAnimationStore } from "@/useAnimationStore"
import { useGameStore } from "@/useGameStore"

import type { AnimationRuntime } from "./runtime"

export type WarpSpringValues = {
  warpProgress: SpringValue<number>
}

export function useWarpAnimationSpring(runtime: AnimationRuntime) {
  const { isWarping } = useAnimationStore()
  const { hyperspaceEnterTime, hyperspaceExitTime } = useGameStore(
    (state) => state.starfieldConfig
  )

  const warpSpring = useSpring<WarpSpringValues>({
    warpProgress: isWarping ? 1 : 0,
    config: () =>
      isWarping
        ? { duration: hyperspaceEnterTime, easing: easings.easeInQuad }
        : { duration: hyperspaceExitTime, easing: easings.easeOutExpo },
    onStart: runtime.start,
    onRest: runtime.end,
    onChange: runtime.onChange,
  })

  return { ...warpSpring, isWarping }
}
