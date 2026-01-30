import { easings, useSpring, type SpringValue } from "@react-spring/three"

import { useAnimationStore } from "@/useAnimationStore"
import { useGameStore } from "@/useGameStore"

import type { AnimationRuntime } from "./runtime"

export type ExposureSpringValues = {
  exposureValue: SpringValue<number>
}

export function useExposureAnimationSpring(runtime: AnimationRuntime) {
  const exposure = useAnimationStore((state) => state.exposure)
  const { exposureDuration = 500 } = useGameStore(
    (state) => state.starfieldConfig
  )

  const exposureSpring = useSpring<ExposureSpringValues>({
    exposureValue: exposure,
    config: { duration: exposureDuration, easing: easings.easeInOutQuad },
    onStart: runtime.start,
    onRest: runtime.end,
    onChange: runtime.onChange,
  })

  return { ...exposureSpring, exposure }
}
