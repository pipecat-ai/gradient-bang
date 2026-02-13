import type { GameStore } from "@/stores/game"

import { wait } from "./animation"

import type { ShipDestroyedMessage } from "@/types/messages"

export const getShieldColor = (shieldIntegrity: number) => {
  if (shieldIntegrity < 25) {
    return "text-destructive"
  }
  if (shieldIntegrity < 50) {
    return "text-warning"
  }
  return "text-success"
}

export const getStatusTone = (percent: number) => {
  if (percent < 25) {
    return "destructive"
  }
  if (percent < 50) {
    return "warning"
  }
  return "terminal"
}

export const getRoundOutcome = (round: Pick<CombatRound, "round_result" | "result" | "end">) => {
  const outcomeRaw = round.round_result ?? round.result ?? round.end
  return outcomeRaw ? String(outcomeRaw).replace(/_/g, " ") : "continued"
}

export const getRoundOutcomeTone = (outcome: string | null | undefined) => {
  const value = String(outcome ?? "").toLowerCase()
  if (!value || value === "continued") {
    return "text-muted-foreground"
  }
  if (value.includes("victory") || value.includes("satisfied")) {
    return "text-success"
  }
  if (value.includes("defeat") || value.includes("destroyed")) {
    return "text-destructive"
  }
  if (value.includes("fled") || value.includes("stalemate")) {
    return "text-warning"
  }
  return "text-foreground"
}

export const sumRecordValues = (values: Record<string, number> | undefined) =>
  Object.values(values ?? {}).reduce(
    (total, value) => total + (Number.isFinite(value) ? value : 0),
    0
  )

export const getRoundDestroyedCount = (round: CombatRound) =>
  Object.entries(round.fighters_remaining ?? {}).reduce(
    (count, [combatantId, fightersRemaining]) => {
      if (fightersRemaining > 0) return count
      const lossesThisRound =
        (round.offensive_losses?.[combatantId] ?? 0) + (round.defensive_losses?.[combatantId] ?? 0)
      return lossesThisRound > 0 ? count + 1 : count
    },
    0
  )

export const getRoundFledCount = (round: CombatRound) =>
  Object.values(round.flee_results ?? {}).filter(Boolean).length

export const getRoundPaidCount = (round: CombatRound) =>
  Object.values(round.actions ?? {}).filter((action) => action.action === "pay").length

const readRoundValue = (
  values: Record<string, number> | undefined,
  keys: (string | null | undefined)[]
) => {
  if (!values) return undefined
  for (const key of keys) {
    if (!key) continue
    if (key in values) return values[key]
  }
  return undefined
}

const syncShipFromCombatRound = (gameStore: GameStore, combatRound: CombatRound) => {
  const playerId = typeof gameStore.player?.id === "string" ? gameStore.player.id : undefined
  const playerName = typeof gameStore.player?.name === "string" ? gameStore.player.name : undefined

  const playerParticipant = combatRound.participants?.find(
    (participant) =>
      (playerId && participant.id === playerId) || (playerName && participant.name === playerName)
  )

  const keyCandidates = [playerParticipant?.id, playerParticipant?.name, playerId, playerName]
  const fighters = readRoundValue(combatRound.fighters_remaining, keyCandidates)
  const shields = readRoundValue(combatRound.shields_remaining, keyCandidates)

  if (!Number.isFinite(fighters) && !Number.isFinite(shields)) {
    return
  }

  gameStore.setShip({
    ...(Number.isFinite(fighters) ? { fighters: Math.max(0, fighters as number) } : {}),
    ...(Number.isFinite(shields) ? { shields: Math.max(0, shields as number) } : {}),
  })
}

export const applyCombatRoundWaitingState = (
  gameStore: GameStore,
  combatSession: CombatSession
) => {
  gameStore.setUIState("combat")

  const activeCombatId = gameStore.activeCombatSession?.combat_id
  const incomingCombatId = combatSession.combat_id
  const shouldStartSession =
    !gameStore.activeCombatSession || (activeCombatId && activeCombatId !== incomingCombatId)

  if (shouldStartSession) {
    gameStore.setActiveCombatSession(combatSession)
    gameStore.addActivityLogEntry({
      type: "combat.session.started",
      message: `Combat session started with ${combatSession.participants.length} participants`,
    })
    return
  }

  gameStore.setTookDamageThisRound(false)
  gameStore.updateActiveCombatSession({
    participants: combatSession.participants,
    garrison: combatSession.garrison ?? null,
    round: combatSession.round,
    deadline: combatSession.deadline,
    current_time: combatSession.current_time,
    initiator: combatSession.initiator,
  })
}

export const applyCombatRoundResolvedState = (gameStore: GameStore, combatRound: CombatRound) => {
  gameStore.addCombatRound(combatRound)
  syncShipFromCombatRound(gameStore, combatRound)
  gameStore.addActivityLogEntry({
    type: "combat.round.resolved",
    message: `Combat round ${combatRound.round} resolved in sector ${combatRound.sector.id}`,
  })
}

export const applyCombatActionAcceptedState = (
  gameStore: GameStore,
  receipt: CombatActionReceipt
) => {
  gameStore.addCombatActionReceipt(receipt)
  gameStore.addActivityLogEntry({
    type: "combat.action.accepted",
    message: `Combat action accepted for round ${receipt.round}: [${receipt.action}]`,
  })
}

export const applyCombatEndedState = async (
  gameStore: GameStore,
  combatEnded: CombatEndedRound
) => {
  gameStore.addCombatRound(combatEnded)
  syncShipFromCombatRound(gameStore, combatEnded)
  if (combatEnded.ship) {
    gameStore.setShip(combatEnded.ship)
  }
  gameStore.addCombatHistory(combatEnded)
  gameStore.setLastCombatEnded(combatEnded)
  gameStore.setUIState("idle")
  gameStore.endActiveCombatSession()
  gameStore.addActivityLogEntry({
    type: "combat.session.ended",
    message: `Combat session ended with result: [${combatEnded.result}]`,
  })

  await wait(1000)

  gameStore.setActiveScreen("combat-results", combatEnded)
}

export const applyShipDestroyedState = (gameStore: GameStore, destroyed: ShipDestroyedMessage) => {
  const localShipId = gameStore.ship?.ship_id
  const localPlayerName = gameStore.player?.name
  const isLocalShipDestroyed =
    (typeof localShipId === "string" && destroyed.ship_id === localShipId) ||
    (destroyed.player_type !== "corporation_ship" &&
      typeof localPlayerName === "string" &&
      destroyed.player_name === localPlayerName)

  const shipDescription =
    isLocalShipDestroyed ? "[Your ship]"
    : destroyed.player_type === "corporation_ship" ?
      `Corporation ship [${destroyed.ship_name ?? destroyed.ship_type}]`
    : `[${destroyed.player_name}]'s ship`

  if (isLocalShipDestroyed) {
    gameStore.setShip({
      fighters: 0,
      shields: 0,
    })
  }

  gameStore.addActivityLogEntry({
    type: "ship.destroyed",
    message: `${shipDescription} destroyed in [sector ${destroyed.sector.id}]${
      destroyed.salvage_created ? " - salvage created" : ""
    }`,
  })
}
