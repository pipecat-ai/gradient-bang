import { useCallback } from "react"

import type { GameObject } from "@/types"
import { useAnimationStore } from "@/useAnimationStore"
import { useGameStore } from "@/useGameStore"

export function useStarfieldEvent() {
  const animateImpact = useCallback(
    (
      strength: number = 0.015,
      frequency: number = 50,
      duration: number = 300,
      rampUpTime: number = 50,
      settleTime: number = 200
    ) => {
      if (!useGameStore.getState().isReady) return

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

  const addGameObject = useCallback((gameObject: GameObject) => {
    if (!useGameStore.getState().isReady) return
    useGameStore.getState().addGameObject(gameObject)
  }, [])

  const removeGameObject = useCallback((id: string) => {
    if (!useGameStore.getState().isReady) return
    useGameStore.getState().removeGameObject(id)
  }, [])

  return { animateImpact, addGameObject, removeGameObject }
}
