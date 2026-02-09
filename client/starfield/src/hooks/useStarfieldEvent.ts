import { useCallback } from "react"

import { useAnimationStore } from "@/useAnimationStore"

export function useStarfieldEvent() {
  const animateImpact = useCallback(
    (
      strength: number = 0.015,
      frequency: number = 50,
      duration: number = 300,
      rampUpTime: number = 50,
      settleTime: number = 200
    ) => {
      useAnimationStore.getState().animations.shake?.start({
        duration: duration,
        strength: strength,
        frequency: frequency,
        rampUpTime: rampUpTime,
        settleTime: settleTime,
      })
    },
    []
  )

  return { animateImpact }
}
