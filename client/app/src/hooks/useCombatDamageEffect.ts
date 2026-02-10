import { useEffect, useRef } from "react"

import { useStarfieldEvent } from "@gradient-bang/starfield"

import useAudioStore from "@/stores/audio"
import useGameStore from "@/stores/game"

const IMPACT_SOUNDS = ["impact1", "impact2", "impact3", "impact4"] as const

/**
 * Plays a screen-shake animation and impact sound when the player
 * takes damage in a new combat round. Deduplicates via a ref so
 * each round only fires once.
 */
export const useCombatDamageEffect = (
  combatId: string | null,
  latestResult: CombatPersonalRoundResult | null,
  isActive: boolean,
) => {
  const lastRoundKeyRef = useRef<string | null>(null)
  const { animateImpact } = useStarfieldEvent()

  useEffect(() => {
    if (!combatId || !latestResult || !isActive) return

    const roundKey = `${combatId}:${latestResult.round}`
    if (lastRoundKeyRef.current === roundKey) return
    lastRoundKeyRef.current = roundKey

    const damageTaken =
      latestResult.offensiveLosses +
      latestResult.defensiveLosses +
      latestResult.shieldLoss

    if (damageTaken <= 0) return

    useGameStore.getState().setTookDamageThisRound(true)
    animateImpact(0.015, 200, 1000, 100, 2000)

    const sound = IMPACT_SOUNDS[Math.floor(Math.random() * IMPACT_SOUNDS.length)]
    useAudioStore.getState().playSound(sound, { volume: 1 })
  }, [combatId, latestResult, isActive, animateImpact])
}
