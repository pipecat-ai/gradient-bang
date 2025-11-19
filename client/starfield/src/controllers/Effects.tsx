import { memo } from "react"
import { button, useControls } from "leva"

import { useWarpExitEffect } from "@/hooks/animations"
import { useAnimationStore } from "@/useAnimationStore"
import { useGameStore } from "@/useGameStore"

const EffectsComponent = () => {
  const { hyperspaceExitTime } = useGameStore((state) => state.starfieldConfig)
  const triggerShockwave = useAnimationStore((state) => state.triggerShockwave)

  useControls(
    "Shockwave",
    () => ({
      ["Trigger Shockwave"]: button(() => {
        triggerShockwave()
      }),
    }),
    [triggerShockwave]
  )

  // Trigger shockwave when warp exits
  useWarpExitEffect(
    () => {
      triggerShockwave()
    },
    Math.max((hyperspaceExitTime ?? 0) * 0, 0)
  )

  return null
}

export const Effects = memo(EffectsComponent)
