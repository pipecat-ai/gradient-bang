import { useEffect } from "react"

import { button, buttonGroup, folder, useControls } from "leva"

import useGameStore from "@/stores/game"

import {
  COMBAT_ACTION_ACCEPTED_PAYLOAD_MOCK,
  COMBAT_COLLECT_STATUS_UPDATE_PAYLOAD_MOCK,
  COMBAT_ENDED_PAYLOAD_MOCK,
  COMBAT_ERROR_PAYLOAD_MOCK,
  COMBAT_EVENT_PAYLOADS_MOCK,
  COMBAT_ROUND_RESOLVED_PAYLOAD_MOCK,
  COMBAT_ROUND_WAITING_PAYLOAD_MOCK,
  COMBAT_SECTOR_UPDATE_FULL_PAYLOAD_MOCK,
  COMBAT_SECTOR_UPDATE_MINIMAL_PAYLOAD_MOCK,
  GARRISON_CHARACTER_MOVED_PAYLOAD_MOCK,
  GARRISON_COLLECTED_PAYLOAD_MOCK,
  GARRISON_DEPLOYED_PAYLOAD_MOCK,
  GARRISON_MODE_CHANGED_PAYLOAD_MOCK,
  SALVAGE_CREATED_PAYLOAD_MOCK,
  SHIP_DESTROYED_PAYLOAD_MOCK,
} from "@/mocks/combat.mock"

const applyCombatRoundWaiting = () => {
  const state = useGameStore.getState()
  state.setUIState("combat")
  state.setActiveCombatSession(COMBAT_ROUND_WAITING_PAYLOAD_MOCK)
}

const applyCombatActionAccepted = (action: CombatActionType) => {
  const state = useGameStore.getState()
  const receipt: CombatActionReceipt = {
    combat_id: state.activeCombatSession?.combat_id ?? COMBAT_ACTION_ACCEPTED_PAYLOAD_MOCK.combat_id,
    round: state.activeCombatSession?.round ?? COMBAT_ACTION_ACCEPTED_PAYLOAD_MOCK.round,
    action,
    commit: COMBAT_ACTION_ACCEPTED_PAYLOAD_MOCK.commit + state.combatActionReceipts.length + 1,
    target_id: action === "attack" ? COMBAT_ACTION_ACCEPTED_PAYLOAD_MOCK.target_id : null,
  }

  state.addCombatActionReceipt(receipt)
  state.addActivityLogEntry({
    type: "combat.action.accepted",
    message: `Accepted [${receipt.action}] for round ${receipt.round}`,
  })
}

const applyCombatRoundResolved = () => {
  const state = useGameStore.getState()
  state.addCombatRound(COMBAT_ROUND_RESOLVED_PAYLOAD_MOCK)
  state.addActivityLogEntry({
    type: "combat.round.resolved",
    message: `Combat round ${COMBAT_ROUND_RESOLVED_PAYLOAD_MOCK.round} resolved in sector ${COMBAT_ROUND_RESOLVED_PAYLOAD_MOCK.sector.id}`,
  })
}

const applyCombatEnded = () => {
  const state = useGameStore.getState()
  const combatEndedRound: CombatEndedRound = {
    ...COMBAT_ENDED_PAYLOAD_MOCK,
    ship: COMBAT_ENDED_PAYLOAD_MOCK.ship
      ? {
          ...COMBAT_ENDED_PAYLOAD_MOCK.ship,
          turns_per_warp: COMBAT_COLLECT_STATUS_UPDATE_PAYLOAD_MOCK.ship.turns_per_warp,
          warp_power_capacity: COMBAT_COLLECT_STATUS_UPDATE_PAYLOAD_MOCK.ship.warp_power_capacity,
        }
      : undefined,
  }

  state.addCombatRound(COMBAT_ENDED_PAYLOAD_MOCK)
  state.addCombatHistory(combatEndedRound)
  state.setLastCombatEnded(combatEndedRound)
  state.endActiveCombatSession()
  state.setUIState("idle")
  state.addActivityLogEntry({
    type: "combat.session.ended",
    message: `Combat ended with result [${COMBAT_ENDED_PAYLOAD_MOCK.result}]`,
  })
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
  const state = useGameStore.getState()
  state.addActivityLogEntry({
    type: "ship.destroyed",
    message: `${SHIP_DESTROYED_PAYLOAD_MOCK.player_name}'s ship destroyed in sector ${SHIP_DESTROYED_PAYLOAD_MOCK.sector.id}`,
  })
}

const applySalvageCreated = () => {
  const state = useGameStore.getState()
  const salvageFromPayload: Salvage = {
    salvage_id: SALVAGE_CREATED_PAYLOAD_MOCK.salvage_id ?? "unknown-salvage",
    cargo: SALVAGE_CREATED_PAYLOAD_MOCK.cargo,
    scrap: SALVAGE_CREATED_PAYLOAD_MOCK.scrap,
    credits: SALVAGE_CREATED_PAYLOAD_MOCK.credits,
    source: {
      ship_name: SALVAGE_CREATED_PAYLOAD_MOCK.from_ship_name ?? "Unknown",
      ship_type: SALVAGE_CREATED_PAYLOAD_MOCK.from_ship_type ?? "unknown",
    },
  }
  state.addToast({
    type: "salvage.created",
    meta: {
      salvage: salvageFromPayload,
    },
  })
  state.addActivityLogEntry({
    type: "salvage.created",
    message: `Salvage created in sector ${SALVAGE_CREATED_PAYLOAD_MOCK.sector.id}`,
  })
}

const applySectorUpdateFull = () => {
  const state = useGameStore.getState()
  state.setSector(COMBAT_SECTOR_UPDATE_FULL_PAYLOAD_MOCK)
}

const applySectorUpdateMinimal = () => {
  const state = useGameStore.getState()
  state.updateSector({
    id: COMBAT_SECTOR_UPDATE_MINIMAL_PAYLOAD_MOCK.sector.id,
  })
}

const applyGarrisonDeployed = () => {
  const state = useGameStore.getState()
  state.addActivityLogEntry({
    type: "garrison.deployed",
    message: `Garrison deployed in sector ${GARRISON_DEPLOYED_PAYLOAD_MOCK.sector.id} with ${GARRISON_DEPLOYED_PAYLOAD_MOCK.garrison.fighters} fighters`,
  })
}

const applyGarrisonCollected = () => {
  const state = useGameStore.getState()
  state.addActivityLogEntry({
    type: "garrison.collected",
    message: `Collected ${GARRISON_COLLECTED_PAYLOAD_MOCK.fighters_on_ship} fighters to ship`,
  })
}

const applyGarrisonModeChanged = () => {
  const state = useGameStore.getState()
  state.addActivityLogEntry({
    type: "garrison.mode_changed",
    message: `Garrison mode changed to [${GARRISON_MODE_CHANGED_PAYLOAD_MOCK.garrison.mode}]`,
  })
}

const applyStatusUpdateFromCollect = () => {
  const state = useGameStore.getState()
  state.setPlayer(COMBAT_COLLECT_STATUS_UPDATE_PAYLOAD_MOCK.player)
  state.setShip(COMBAT_COLLECT_STATUS_UPDATE_PAYLOAD_MOCK.ship)
  state.setSector(COMBAT_COLLECT_STATUS_UPDATE_PAYLOAD_MOCK.sector)
}

const applyGarrisonCharacterMoved = () => {
  const state = useGameStore.getState()
  const payload = GARRISON_CHARACTER_MOVED_PAYLOAD_MOCK
  if (payload.movement === "depart") {
    state.removeSectorPlayer(payload.player)
  } else {
    state.addSectorPlayer(payload.player)
  }
  state.addActivityLogEntry({
    type: "garrison.character_moved",
    message: `${payload.player.name} ${payload.movement === "depart" ? "departed" : "arrived"} near garrison`,
  })
}

const applyCombatError = () => {
  const state = useGameStore.getState()
  state.addActivityLogEntry({
    type: "error",
    message: `[${COMBAT_ERROR_PAYLOAD_MOCK.endpoint}] ${COMBAT_ERROR_PAYLOAD_MOCK.error}`,
  })
}

export const useCombatControls = () => {
  const activeCombatSession = useGameStore((state) => state.activeCombatSession)

  const [, set] = useControls(
    () => ({
      Combat: folder(
        {
          ["Current Status"]: {
            value: "inactive",
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
              ["Combat Ended"]: button(() => applyCombatEnded()),
              ["Run Full Timeline"]: button(() => applyCombatTimeline()),
              ["Reset Combat State"]: button(() => applyCombatReset()),
            },
            { collapsed: false }
          ),
          ["Side Events"]: folder(
            {
              ["Ship Destroyed"]: button(() => applyShipDestroyed()),
              ["Salvage Created"]: button(() => applySalvageCreated()),
              ["Sector Update (Full)"]: button(() => applySectorUpdateFull()),
              ["Sector Update (Minimal)"]: button(() => applySectorUpdateMinimal()),
              ["Garrison Deployed"]: button(() => applyGarrisonDeployed()),
              ["Garrison Collected"]: button(() => applyGarrisonCollected()),
              ["Garrison Mode Changed"]: button(() => applyGarrisonModeChanged()),
              ["Status Update (Collect)"]: button(() => applyStatusUpdateFromCollect()),
              ["Garrison Character Moved"]: button(() => applyGarrisonCharacterMoved()),
              ["Combat Error"]: button(() => applyCombatError()),
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

  useEffect(() => {
    set({
      "Current Status": activeCombatSession ? "active" : "inactive",
    })
  }, [activeCombatSession, set])

  return null
}
