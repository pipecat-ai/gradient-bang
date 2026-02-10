import { button, buttonGroup, folder, useControls } from "leva"

import useGameStore from "@/stores/game"
import {
  applyCombatActionAcceptedState,
  applyCombatEndedState,
  applyCombatRoundResolvedState,
  applyCombatRoundWaitingState,
  applyShipDestroyedState,
} from "@/utils/combat"

import {
  COMBAT_ACTION_ACCEPTED_PAYLOAD_MOCK,
  COMBAT_COLLECT_STATUS_UPDATE_PAYLOAD_MOCK,
  COMBAT_ENDED_PAYLOAD_MOCK,
  COMBAT_EVENT_PAYLOADS_MOCK,
  COMBAT_ROUND_RESOLVED_PAYLOAD_MOCK,
  COMBAT_ROUND_WAITING_PAYLOAD_MOCK,
  SHIP_DESTROYED_PAYLOAD_MOCK,
} from "@/mocks/combat.mock"

type ParticipantVisualState = "active" | "destroyed" | "fled" | "paid"

const randomInt = (min: number, max: number) =>
  Math.floor(Math.random() * (max - min + 1)) + min

const pickRandom = <T,>(values: T[]) => values[randomInt(0, values.length - 1)]

const applyCombatRoundWaiting = () => {
  const state = useGameStore.getState()
  const nowIso = new Date().toISOString()
  const deadlineIso = new Date(Date.now() + 15_000).toISOString()

  // Seed local player/ship/sector state first so combat UI has a valid actor context.
  state.setPlayer(COMBAT_COLLECT_STATUS_UPDATE_PAYLOAD_MOCK.player)
  state.setShip(COMBAT_COLLECT_STATUS_UPDATE_PAYLOAD_MOCK.ship)
  state.setSector(COMBAT_COLLECT_STATUS_UPDATE_PAYLOAD_MOCK.sector)

  const roundWaitingPayload: CombatSession = {
    ...COMBAT_ROUND_WAITING_PAYLOAD_MOCK,
    round: 1,
    current_time: nowIso,
    deadline: deadlineIso,
  }
  applyCombatRoundWaitingState(state, roundWaitingPayload)
}

const applyCombatActionAccepted = (action: CombatActionType) => {
  const state = useGameStore.getState()
  const receipt: CombatActionReceipt = {
    combat_id:
      state.activeCombatSession?.combat_id ?? COMBAT_ACTION_ACCEPTED_PAYLOAD_MOCK.combat_id,
    round: state.activeCombatSession?.round ?? COMBAT_ACTION_ACCEPTED_PAYLOAD_MOCK.round,
    action,
    commit: COMBAT_ACTION_ACCEPTED_PAYLOAD_MOCK.commit + state.combatActionReceipts.length + 1,
    target_id: action === "attack" ? COMBAT_ACTION_ACCEPTED_PAYLOAD_MOCK.target_id : null,
  }

  applyCombatActionAcceptedState(state, receipt)
}

const applyCombatRoundResolved = () => {
  const state = useGameStore.getState()
  const combatId =
    state.activeCombatSession?.combat_id ?? COMBAT_ROUND_RESOLVED_PAYLOAD_MOCK.combat_id
  const round = state.activeCombatSession?.round ?? COMBAT_ROUND_RESOLVED_PAYLOAD_MOCK.round

  // Respect the committed receipt for the player's action
  const committedReceipt = state.combatActionReceipts.findLast(
    (receipt) => receipt.combat_id === combatId && receipt.round === round
  )

  const playerName = state.player?.name
  let actions = COMBAT_ROUND_RESOLVED_PAYLOAD_MOCK.actions
  if (committedReceipt && playerName && actions?.[playerName]) {
    const participants =
      state.activeCombatSession?.participants ?? COMBAT_ROUND_RESOLVED_PAYLOAD_MOCK.participants
    actions = {
      ...actions,
      [playerName]: {
        ...actions[playerName],
        action: committedReceipt.action,
        commit: committedReceipt.commit,
        target:
          committedReceipt.action === "attack" ?
            (participants.find((p) => p.id === committedReceipt.target_id)?.name ??
              actions[playerName].target)
          : null,
        target_id:
          committedReceipt.action === "attack" ? (committedReceipt.target_id ?? null) : null,
        destination_sector: committedReceipt.action === "flee" ? 43 : null,
      },
    }
  }

  const resolvedPayload = {
    ...COMBAT_ROUND_RESOLVED_PAYLOAD_MOCK,
    combat_id: combatId,
    round,
    actions,
  }

  applyCombatRoundResolvedState(state, resolvedPayload)

  // Advance to the next round waiting state (same as applyRandomCombatRoundResult)
  if (state.activeCombatSession) {
    const nextWaitingState: CombatSession = {
      ...state.activeCombatSession,
      participants: resolvedPayload.participants,
      garrison: resolvedPayload.garrison,
      round: round + 1,
      current_time: new Date().toISOString(),
      deadline: new Date(Date.now() + 15_000).toISOString(),
    }
    applyCombatRoundWaitingState(state, nextWaitingState)
  }
}

const applyRandomCombatRoundResult = (forcedAction?: "attack" | "brace" | "flee") => {
  const state = useGameStore.getState()
  if (!state.activeCombatSession) {
    applyCombatRoundWaiting()
  }

  const refreshed = useGameStore.getState()
  const activeCombatSession = refreshed.activeCombatSession
  if (!activeCombatSession) return

  const combatId = activeCombatSession.combat_id
  const combatRounds = refreshed.combatRounds
    .filter((round) => round.combat_id === combatId)
    .sort((a, b) => a.round - b.round)
  const latestRound = combatRounds[combatRounds.length - 1]

  const nextRound =
    combatRounds.length > 0 ?
      combatRounds[combatRounds.length - 1].round + 1
    : activeCombatSession.round
  const participants =
    activeCombatSession.participants.length > 0 ?
      activeCombatSession.participants
    : COMBAT_ROUND_RESOLVED_PAYLOAD_MOCK.participants

  // Check if the player already committed an action for this round via receipts
  const committedReceipt = refreshed.combatActionReceipts.findLast(
    (receipt) =>
      receipt.combat_id === combatId &&
      receipt.round === activeCombatSession.round
  )

  const hits: Record<string, number> = {}
  const offensive_losses: Record<string, number> = {}
  const defensive_losses: Record<string, number> = {}
  const shield_loss: Record<string, number> = {}
  const damage_mitigated: Record<string, number> = {}
  const fighters_remaining: Record<string, number> = {}
  const shields_remaining: Record<string, number> = {}
  const flee_results: Record<string, boolean> = {}
  const actions: Record<string, CombatAction> = {}

  const updatedParticipants = participants.map((participant) => {
    const isPlayerParticipant =
      Boolean(refreshed.player?.id && participant.id === refreshed.player.id) ||
      Boolean(refreshed.player?.name && participant.name === refreshed.player.name)
    const participantId = participant.id ?? participant.name
    const targetPool = participants.filter((candidate) => candidate.id !== participant.id)
    const target = targetPool.length > 0 ? pickRandom(targetPool) : null
    const action =
      forcedAction && isPlayerParticipant ? forcedAction
      : isPlayerParticipant && committedReceipt ? committedReceipt.action
      : pickRandom<CombatActionType>(["attack", "brace", "flee", "pay"])
    const previousFighters =
      latestRound?.fighters_remaining?.[participantId] ?? randomInt(20, 80)
    const previousShields =
      latestRound?.shields_remaining?.[participantId] ?? Math.round(participant.ship.shield_integrity)

    let hitsValue = 0
    let offensiveLossValue = 0
    let defensiveLossValue = 0
    let shieldLossValue = 0
    let fled = false

    switch (action) {
      case "attack":
        hitsValue = randomInt(1, 8)
        offensiveLossValue = randomInt(0, 4)
        defensiveLossValue = randomInt(0, 4)
        shieldLossValue = randomInt(0, 6)
        break
      case "brace":
        hitsValue = randomInt(0, 2)
        offensiveLossValue = randomInt(0, 1)
        defensiveLossValue = randomInt(0, 2)
        shieldLossValue = randomInt(0, 3)
        break
      case "flee":
        hitsValue = randomInt(0, 1)
        offensiveLossValue = randomInt(0, 2)
        defensiveLossValue = randomInt(0, 2)
        shieldLossValue = randomInt(0, 2)
        fled = Math.random() < 0.4
        break
      case "pay":
      default:
        hitsValue = 0
        offensiveLossValue = 0
        defensiveLossValue = randomInt(0, 1)
        shieldLossValue = randomInt(0, 1)
        break
    }

    const lossTotal = offensiveLossValue + defensiveLossValue
    const nextFighters = Math.max(0, previousFighters - lossTotal)
    const nextShields = Math.max(0, previousShields - shieldLossValue)

    hits[participantId] = hitsValue
    offensive_losses[participantId] = offensiveLossValue
    defensive_losses[participantId] = defensiveLossValue
    shield_loss[participantId] = shieldLossValue
    damage_mitigated[participantId] = action === "brace" ? randomInt(1, defensiveLossValue + shieldLossValue) : randomInt(0, 2)
    fighters_remaining[participantId] = nextFighters
    shields_remaining[participantId] = nextShields
    flee_results[participantId] = fled
    const useReceipt = isPlayerParticipant && committedReceipt
    actions[participant.name] = {
      action,
      commit: useReceipt ? committedReceipt.commit : randomInt(1, 100),
      timed_out: false,
      submitted_at: new Date().toISOString(),
      target:
        useReceipt && action === "attack" ?
          (participants.find((p) => p.id === committedReceipt.target_id)?.name ?? target?.name ?? null)
        : action === "attack" ? (target?.name ?? null)
        : null,
      target_id:
        useReceipt && action === "attack" ? (committedReceipt.target_id ?? target?.id ?? null)
        : action === "attack" ? (target?.id ?? null)
        : null,
      destination_sector:
        action === "flee" ? randomInt(1, 200)
        : null,
    }

    return {
      ...participant,
      ship: {
        ...participant.ship,
        shield_integrity: nextShields,
        shield_damage: shieldLossValue,
        fighter_loss: lossTotal,
      },
    }
  })

  const randomRound: CombatRound = {
    combat_id: combatId,
    sector: latestRound?.sector ?? COMBAT_ROUND_RESOLVED_PAYLOAD_MOCK.sector,
    round: nextRound,
    hits,
    offensive_losses,
    defensive_losses,
    shield_loss,
    damage_mitigated,
    fighters_remaining,
    shields_remaining,
    flee_results,
    actions,
    participants: updatedParticipants,
    garrison:
      latestRound?.garrison ??
      activeCombatSession.garrison ??
      COMBAT_ROUND_RESOLVED_PAYLOAD_MOCK.garrison,
    deadline: null,
    end: null,
    result: null,
    round_result: null,
  }

  applyCombatRoundResolvedState(state, randomRound)

  const nextWaitingState: CombatSession = {
    ...activeCombatSession,
    participants: updatedParticipants,
    garrison: randomRound.garrison,
    round: nextRound + 1,
    current_time: new Date().toISOString(),
    deadline: new Date(Date.now() + 15_000).toISOString(),
  }
  applyCombatRoundWaitingState(state, nextWaitingState)
}

const applyCombatEnded = (overrides?: { ship?: CombatEndedRound["ship"] }) => {
  const state = useGameStore.getState()
  const combatId = state.activeCombatSession?.combat_id ?? COMBAT_ENDED_PAYLOAD_MOCK.combat_id
  const combatEndedRound: CombatEndedRound = {
    ...COMBAT_ENDED_PAYLOAD_MOCK,
    combat_id: combatId,
    ship: overrides?.ship
      ?? (COMBAT_ENDED_PAYLOAD_MOCK.ship ?
        {
          ...COMBAT_ENDED_PAYLOAD_MOCK.ship,
          turns_per_warp: COMBAT_COLLECT_STATUS_UPDATE_PAYLOAD_MOCK.ship.turns_per_warp,
          warp_power_capacity: COMBAT_COLLECT_STATUS_UPDATE_PAYLOAD_MOCK.ship.warp_power_capacity,
        }
      : undefined),
  }

  applyCombatEndedState(state, combatEndedRound)
}

const applyOpenCombatResults = () => {
  const state = useGameStore.getState()
  if (state.lastCombatEnded) {
    state.setActiveScreen("combat-results", state.lastCombatEnded)
  } else {
    applyCombatEnded()
  }
}

const applyCombatTimeline = () => {
  applyCombatRoundWaiting()
  applyCombatActionAccepted("attack")
  applyCombatRoundResolved()
  applyCombatEnded()
}

const applyCombatReset = () => {
  const state = useGameStore.getState()
  state.resetCombatState()
  state.setUIState("idle")
}

const applyShipDestroyed = () => {
  if (!useGameStore.getState().activeCombatSession) {
    applyCombatRoundWaiting()
  }

  const state = useGameStore.getState()
  const combatId = state.activeCombatSession?.combat_id ?? SHIP_DESTROYED_PAYLOAD_MOCK.combat_id

  applyShipDestroyedState(state, {
    ...SHIP_DESTROYED_PAYLOAD_MOCK,
    combat_id: combatId,
  })

  applyCombatEnded()
}

const applyOwnShipDestroyed = () => {
  if (!useGameStore.getState().activeCombatSession) {
    applyCombatRoundWaiting()
  }

  const state = useGameStore.getState()
  const combatId = state.activeCombatSession?.combat_id ?? SHIP_DESTROYED_PAYLOAD_MOCK.combat_id
  const localShip = state.ship
  const localPlayer = state.player

  applyShipDestroyedState(state, {
    ...SHIP_DESTROYED_PAYLOAD_MOCK,
    combat_id: combatId,
    ship_id: localShip?.ship_id ?? SHIP_DESTROYED_PAYLOAD_MOCK.ship_id,
    ship_type: localShip?.ship_type ?? SHIP_DESTROYED_PAYLOAD_MOCK.ship_type,
    ship_name: localShip?.ship_name ?? SHIP_DESTROYED_PAYLOAD_MOCK.ship_name,
    player_type: "human",
    player_name: localPlayer?.name ?? SHIP_DESTROYED_PAYLOAD_MOCK.player_name,
  })

  const cargoCapacity =
    localShip?.cargo_capacity ?? COMBAT_COLLECT_STATUS_UPDATE_PAYLOAD_MOCK.ship.cargo_capacity

  const destroyedShipSnapshot: CombatEndedRound["ship"] = {
    ...COMBAT_COLLECT_STATUS_UPDATE_PAYLOAD_MOCK.ship,
    ship_id: localShip?.ship_id ?? COMBAT_COLLECT_STATUS_UPDATE_PAYLOAD_MOCK.ship.ship_id,
    ship_type: "escape_pod",
    ship_name: "Escape Pod",
    credits: 0,
    cargo: {
      quantum_foam: 0,
      retro_organics: 0,
      neuro_symbolics: 0,
    },
    cargo_capacity: cargoCapacity,
    empty_holds: cargoCapacity,
    warp_power: 0,
    shields: 0,
    fighters: 0,
  }

  applyCombatEnded({ ship: destroyedShipSnapshot })
}

const getLatestRoundForActiveCombat = (state: ReturnType<typeof useGameStore.getState>) => {
  const combatId = state.activeCombatSession?.combat_id
  const rounds =
    combatId ?
      state.combatRounds.filter((round) => round.combat_id === combatId)
    : state.combatRounds

  if (!rounds.length) {
    return null
  }

  return [...rounds].sort((a, b) => b.round - a.round)[0]
}

const ensureRoundForParticipantState = () => {
  const state = useGameStore.getState()

  if (!state.activeCombatSession) {
    applyCombatRoundWaiting()
  }

  let latestRound = getLatestRoundForActiveCombat(useGameStore.getState())
  if (!latestRound) {
    applyCombatRoundResolved()
    latestRound = getLatestRoundForActiveCombat(useGameStore.getState())
  }

  return latestRound
}

const buildParticipantAction = (action: CombatActionType): CombatAction => ({
  action,
  commit: 0,
  timed_out: false,
  submitted_at: new Date().toISOString(),
  target: null,
  target_id: null,
  destination_sector: action === "flee" ? 43 : null,
})

const applyParticipantVisualState = (
  participantName: string,
  nextState: ParticipantVisualState
) => {
  const state = useGameStore.getState()
  const latestRound = ensureRoundForParticipantState()
  if (!latestRound) return

  const sessionParticipant =
    state.activeCombatSession?.participants.find(
      (participant) => participant.name === participantName
    ) ?? latestRound.participants?.find((participant) => participant.name === participantName)

  if (!sessionParticipant?.id) {
    state.addActivityLogEntry({
      type: "combat.mock.participant_state",
      message: `Unable to find participant [${participantName}]`,
    })
    return
  }

  const participantId = sessionParticipant.id
  const baselineFighters =
    COMBAT_ROUND_RESOLVED_PAYLOAD_MOCK.fighters_remaining?.[participantId] ??
    latestRound.fighters_remaining?.[participantId] ??
    25

  let fightersRemaining = latestRound.fighters_remaining?.[participantId] ?? baselineFighters
  let fled = Boolean(latestRound.flee_results?.[participantId])
  let action = latestRound.actions?.[participantName]?.action

  switch (nextState) {
    case "destroyed":
      fightersRemaining = 0
      fled = false
      action = action === "pay" ? "pay" : "attack"
      break
    case "fled":
      fightersRemaining = Math.max(1, baselineFighters)
      fled = true
      action = "flee"
      break
    case "paid":
      fightersRemaining = Math.max(1, baselineFighters)
      fled = false
      action = "pay"
      break
    case "active":
    default:
      fightersRemaining = Math.max(1, baselineFighters)
      fled = false
      action = "brace"
      break
  }

  const updatedRound: CombatRound = {
    ...latestRound,
    fighters_remaining: {
      ...latestRound.fighters_remaining,
      [participantId]: fightersRemaining,
    },
    flee_results: {
      ...latestRound.flee_results,
      [participantId]: fled,
    },
    actions: {
      ...(latestRound.actions ?? {}),
      [participantName]: buildParticipantAction(action),
    },
  }

  state.addCombatRound(updatedRound)
  state.addActivityLogEntry({
    type: "combat.mock.participant_state",
    message: `Set [${participantName}] to [${nextState}]`,
  })
}

export const useCombatControls = () => {
  const currentStatus = useGameStore.getState().activeCombatSession ? "active" : "inactive"

  useControls(
    () => ({
      Combat: folder(
        {
          ["Current Status"]: {
            value: currentStatus,
            editable: false,
          },
          Flow: folder(
            {
              ["Start / Round Waiting"]: button(() => applyCombatRoundWaiting()),
              ["Round Action"]: buttonGroup({
                Attack: () => applyCombatActionAccepted("attack"),
                Brace: () => applyCombatActionAccepted("brace"),
                Flee: () => applyCombatActionAccepted("flee"),
                Pay: () => applyCombatActionAccepted("pay"),
              }),
              ["Round Resolved"]: button(() => applyCombatRoundResolved()),
              ["Random Round Result"]: button(() => applyRandomCombatRoundResult()),
              ["Random Round (Force Action)"]: buttonGroup({
                Attack: () => applyRandomCombatRoundResult("attack"),
                Brace: () => applyRandomCombatRoundResult("brace"),
                Flee: () => applyRandomCombatRoundResult("flee"),
              }),
              ["Combat Ended"]: button(() => applyCombatEnded()),
              ["Open Results Screen"]: button(() => applyOpenCombatResults()),
              ["Run Full Timeline"]: button(() => applyCombatTimeline()),
              ["Reset Combat State"]: button(() => applyCombatReset()),
            },
            { collapsed: false }
          ),
          ["Side Events"]: folder(
            {
              ["Ship Destroyed (Other)"]: button(() => applyShipDestroyed()),
              ["Your Ship Destroyed"]: button(() => applyOwnShipDestroyed()),
            },
            { collapsed: true }
          ),
          ["Participant States"]: folder(
            {
              ["Captain Vega"]: buttonGroup({
                Active: () => applyParticipantVisualState("Captain Vega", "active"),
                Destroyed: () => applyParticipantVisualState("Captain Vega", "destroyed"),
                Fled: () => applyParticipantVisualState("Captain Vega", "fled"),
                Paid: () => applyParticipantVisualState("Captain Vega", "paid"),
              }),
              ["Rook AI"]: buttonGroup({
                Active: () => applyParticipantVisualState("Rook AI", "active"),
                Destroyed: () => applyParticipantVisualState("Rook AI", "destroyed"),
                Fled: () => applyParticipantVisualState("Rook AI", "fled"),
                Paid: () => applyParticipantVisualState("Rook AI", "paid"),
              }),
            },
            { collapsed: true }
          ),
          Payloads: folder(
            {
              Preview: buttonGroup({
                ["Round Waiting"]: () =>
                  console.log("combat.round_waiting", COMBAT_EVENT_PAYLOADS_MOCK.round_waiting),
                ["Round Resolved"]: () =>
                  console.log("combat.round_resolved", COMBAT_EVENT_PAYLOADS_MOCK.round_resolved),
                ["Ended"]: () => console.log("combat.ended", COMBAT_EVENT_PAYLOADS_MOCK.ended),
              }),
            },
            { collapsed: true }
          ),
        },
        { collapsed: true }
      ),
    }),
    []
  )

  return null
}
