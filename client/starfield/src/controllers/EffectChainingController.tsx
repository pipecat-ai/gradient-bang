import { memo } from "react"

import { useWarpExitEffect } from "@/hooks/animations"
import { useAnimationStore } from "@/useAnimationStore"
import { useGameStore } from "@/useGameStore"

const EffectChainingControllerComponent = () => {
  const { hyperspaceExitTime } = useGameStore((state) => state.starfieldConfig)
  const triggerShockwave = useAnimationStore((state) => state.triggerShockwave)

  // Trigger shockwave when warp exits
  useWarpExitEffect(
    () => {
      triggerShockwave()
    },
    Math.max((hyperspaceExitTime ?? 0) * 0.5, 0)
  )

  return null
}

export const EffectChainingController = memo(EffectChainingControllerComponent)
