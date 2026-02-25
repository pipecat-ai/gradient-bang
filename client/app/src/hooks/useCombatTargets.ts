import { useMemo } from "react"

import useGameStore from "@/stores/game"

/**
 * Derives the list of valid attack targets from the active combat
 * session, filtering out the current player and friendly combatants
 * (same corporation).
 */
export const useCombatTargets = () => {
  const playerId = useGameStore((state) => state.player?.id ?? null)
  const playerName = useGameStore((state) => state.player?.name ?? null)
  const corpId = useGameStore((state) => state.corporation?.corp_id ?? null)
  const sectorPlayers = useGameStore((state) => state.sector?.players ?? null)
  const sectorGarrison = useGameStore((state) => state.sector?.garrison ?? null)
  const participants = useGameStore(
    (state) => state.activeCombatSession?.participants ?? null,
  )
  const garrison = useGameStore(
    (state) => state.activeCombatSession?.garrison ?? null,
  )

  const friendlyIds = useMemo(() => {
    const ids = new Set<string>()
    if (!corpId || !sectorPlayers) return ids
    for (const player of sectorPlayers) {
      if (player.corporation?.corp_id === corpId) {
        ids.add(player.id)
        if (player.name) ids.add(player.name)
      }
    }
    return ids
  }, [corpId, sectorPlayers])

  const attackTargets = useMemo<CombatAttackTargetOption[]>(() => {
    const participantTargets = (participants ?? [])
      .filter((participant) => {
        const isPlayerById = Boolean(playerId && participant.id === playerId)
        const isPlayerByName = Boolean(playerName && participant.name === playerName)
        if (isPlayerById || isPlayerByName) return false
        const isFriendlyById = Boolean(participant.id && friendlyIds.has(participant.id))
        const isFriendlyByName = Boolean(participant.name && friendlyIds.has(participant.name))
        return !isFriendlyById && !isFriendlyByName
      })
      .map((participant, index) => ({
        key: participant.id ?? participant.name ?? `target-${index}`,
        id: participant.id ?? null,
        name: participant.name ?? null,
      }))

    if (!garrison) return participantTargets

    const isOwnGarrison = garrison.owner_name === playerName
    const isFriendlyGarrison = sectorGarrison?.is_friendly === true
    if (isOwnGarrison || isFriendlyGarrison) return participantTargets

    const garrisonName = garrison.name ?? `${garrison.owner_name} Garrison`
    const garrisonKey = garrison.id ?? garrison.name ?? `garrison:${garrison.owner_name}`

    return [
      ...participantTargets,
      { key: garrisonKey, id: garrison.id ?? null, name: garrisonName },
    ]
  }, [participants, garrison, playerId, playerName, friendlyIds, sectorGarrison])

  return attackTargets
}
