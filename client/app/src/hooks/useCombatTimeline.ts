import { useMemo } from "react"

import useGameStore from "@/stores/game"
import { getRoundOutcome } from "@/utils/combat"

const readCombatValue = <T,>(
  values: Record<string, T> | undefined,
  keys: (string | null | undefined)[],
): T | undefined => {
  if (!values) return undefined
  for (const key of keys) {
    if (!key) continue
    if (key in values) return values[key]
  }
  return undefined
}

/**
 * Derives the combat round timeline and per-round personal results
 * from the game store. Pure data — no side effects.
 */
export const useCombatTimeline = () => {
  const playerId = useGameStore((state) => state.player?.id ?? null)
  const playerName = useGameStore((state) => state.player?.name ?? null)
  const activeCombatSession = useGameStore((state) => state.activeCombatSession)
  const combatRounds = useGameStore((state) => state.combatRounds)
  const lastCombatEnded = useGameStore((state) => state.lastCombatEnded)

  const combatId = activeCombatSession?.combat_id ?? lastCombatEnded?.combat_id ?? null

  const timelineRounds = useMemo<(CombatRound | CombatEndedRound)[]>(() => {
    if (!combatId) return []

    const roundMap = new Map<number, CombatRound | CombatEndedRound>()

    for (const round of combatRounds) {
      if (round.combat_id === combatId) {
        roundMap.set(round.round, round)
      }
    }

    if (lastCombatEnded?.combat_id === combatId) {
      roundMap.set(lastCombatEnded.round, lastCombatEnded)
    }

    return Array.from(roundMap.values()).sort((a, b) => b.round - a.round)
  }, [combatId, combatRounds, lastCombatEnded])

  const personalRoundResults = useMemo<CombatPersonalRoundResult[]>(() => {
    if (timelineRounds.length === 0) return []

    // Build a participant name lookup once — participants/garrison are
    // consistent across rounds within a single combat session.
    const firstRound = timelineRounds[0]
    const participantNameById = new Map<string, string>()
    for (const entry of firstRound.participants ?? []) {
      if (entry.id) {
        participantNameById.set(entry.id, entry.name)
      }
    }
    if (firstRound.garrison?.id) {
      participantNameById.set(
        firstRound.garrison.id,
        firstRound.garrison.name ?? `${firstRound.garrison.owner_name} Garrison`,
      )
    }

    const results: CombatPersonalRoundResult[] = []

    for (const round of timelineRounds) {
      const participant = round.participants?.find(
        (entry) =>
          (playerId && entry.id === playerId) ||
          (playerName && entry.name === playerName),
      )

      const action =
        (participant?.name ? round.actions?.[participant.name] : undefined) ??
        (participant?.id ? round.actions?.[participant.id] : undefined) ??
        (playerId ? round.actions?.[playerId] : undefined) ??
        (playerName ? round.actions?.[playerName] : undefined)

      if (!action) continue

      const keyCandidates = [participant?.id, participant?.name, playerId, playerName]

      const targetFromId =
        action.target_id
          ? (participantNameById.get(action.target_id) ?? action.target_id)
          : null
      const targetFromRaw =
        action.target
          ? (participantNameById.get(action.target) ?? action.target)
          : null

      // Build incoming attacks: find all other participants whose attack
      // targeted this player (by id or name).
      const playerKeys = new Set(keyCandidates.filter(Boolean) as string[])
      const incomingAttacks: CombatIncomingAttack[] = []

      if (round.actions) {
        for (const [attackerKey, otherAction] of Object.entries(round.actions)) {
          // Skip our own action
          if (playerKeys.has(attackerKey)) continue
          if (otherAction.action?.toLowerCase() !== "attack") continue

          // Check if their target matches us (by target_id or target name)
          const targetsUs =
            (otherAction.target_id && playerKeys.has(otherAction.target_id)) ||
            (otherAction.target && playerKeys.has(otherAction.target))

          if (targetsUs) {
            incomingAttacks.push({
              attackerName: participantNameById.get(attackerKey) ?? attackerKey,
              fightersCommitted: otherAction.commit ?? 0,
            })
          }
        }
      }

      results.push({
        round: round.round,
        action: action.action.toUpperCase(),
        outcome: getRoundOutcome(round),
        target: targetFromId ?? targetFromRaw ?? null,
        hits: readCombatValue(round.hits, keyCandidates) ?? 0,
        offensiveLosses: readCombatValue(round.offensive_losses, keyCandidates) ?? 0,
        defensiveLosses: readCombatValue(round.defensive_losses, keyCandidates) ?? 0,
        shieldLoss: readCombatValue(round.shield_loss, keyCandidates) ?? 0,
        damageMitigated: readCombatValue(round.damage_mitigated, keyCandidates) ?? 0,
        fightersRemaining: readCombatValue(round.fighters_remaining, keyCandidates) ?? null,
        shieldsRemaining: readCombatValue(round.shields_remaining, keyCandidates) ?? null,
        fleeSuccess: readCombatValue(round.flee_results, keyCandidates) ?? null,
        incomingAttacks,
      })
    }

    return results
  }, [playerId, playerName, timelineRounds])

  const latestPersonalResult: CombatPersonalRoundResult | null =
    personalRoundResults[0] ?? null

  return { combatId, timelineRounds, personalRoundResults, latestPersonalResult }
}
