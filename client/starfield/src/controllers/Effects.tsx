import { memo } from "react"
import { button, useControls } from "leva"

import { useShockwave, useWarpExitEffect } from "@/hooks/animations"
import { useGameStore } from "@/useGameStore"

const EffectsComponent = () => {
  const { hyperspaceExitTime, shockwaveEnabled } = useGameStore(
    (state) => state.starfieldConfig
  )
  const { triggerShockwave } = useShockwave()

  useControls(
    "Shockwave",
    () => ({
      ["Trigger Shockwave"]: button(() => {
        triggerShockwave()
      }),
    }),
    [triggerShockwave]
  )

  useWarpExitEffect(
    () => {
      if (shockwaveEnabled) {
        triggerShockwave()
      }
    },
    Math.max((hyperspaceExitTime ?? 0) * 0, 0)
  )

  return null
}

export const Effects = memo(EffectsComponent)
