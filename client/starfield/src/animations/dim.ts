import { easings, useSpring, type SpringValue } from "@react-spring/three"

import { useAnimationStore } from "@/useAnimationStore"
import { useGameStore } from "@/useGameStore"

import type { AnimationRuntime } from "./runtime"

export type DimSpringValues = {
  dimOpacity: SpringValue<number>
  dimProgress: SpringValue<number>
}

export function useDimAnimationSpring(runtime: AnimationRuntime) {
  const { isDimmed } = useAnimationStore()
  const { layerDimDuration = 300 } = useGameStore(
    (state) => state.starfieldConfig
  )

  const dimSpring = useSpring<DimSpringValues>({
    dimOpacity: isDimmed ? 0.3 : 1,
    dimProgress: isDimmed ? 1 : 0,
    config: { duration: layerDimDuration, easing: easings.easeInOutQuad },
    onStart: runtime.start,
    onRest: runtime.end,
    onChange: runtime.onChange,
  })

  return { ...dimSpring, isDimmed }
}
