import { useEffect, useRef } from "react"

import useAudioStore from "@/stores/audio"
import useGameStore from "@/stores/game"

const IMPACT_SOUNDS = ["impact1", "impact2", "impact3", "impact4"] as const

/**
 * Plays an impact sound when the player takes damage in a new combat round.
 * Sets tookDamageThisRound in the store so the starfield (lazy-loaded) can
 * react with a screen-shake animation independently.
 * Deduplicates via a ref so each round only fires once.
 */
export const useCombatDamageEffect = (
  combatId: string | null,
  latestResult: CombatPersonalRoundResult | null,
  isActive: boolean
) => {
  const lastRoundKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (!combatId || !latestResult || !isActive) return

    const roundKey = `${combatId}:${latestResult.round}`
    if (lastRoundKeyRef.current === roundKey) return
    lastRoundKeyRef.current = roundKey

    const damageTaken =
      latestResult.offensiveLosses + latestResult.defensiveLosses + latestResult.shieldLoss

    if (damageTaken <= 0) return

    useGameStore.getState().setTookDamageThisRound(true)

    const sound = IMPACT_SOUNDS[Math.floor(Math.random() * IMPACT_SOUNDS.length)]
    useAudioStore.getState().playSound(sound, { volume: 1 })
  }, [combatId, latestResult, isActive])
}
