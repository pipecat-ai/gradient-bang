import { produce } from "immer"
import type { StateCreator } from "zustand"

export interface CombatSlice {
  activeCombatSession: CombatSession | null
  combatRounds: CombatRound[]
  combatActionReceipts: CombatActionReceipt[]
  combatHistory: CombatEndedRound[]
  lastCombatEnded: CombatEndedRound | null

  setActiveCombatSession: (combatSession: CombatSession | null) => void
  updateActiveCombatSession: (updates: Partial<CombatSession>) => void

  setCombatRounds: (rounds: CombatRound[]) => void
  addCombatRound: (combatRound: CombatRound) => void
  clearCombatRounds: () => void

  setCombatActionReceipts: (receipts: CombatActionReceipt[]) => void
  addCombatActionReceipt: (receipt: CombatActionReceipt) => void
  clearCombatActionReceipts: () => void

  setLastCombatEnded: (combat: CombatEndedRound | null) => void
  addCombatHistory: (combat: CombatEndedRound) => void

  endActiveCombatSession: () => void
  resetCombatState: () => void
}

export const createCombatSlice: StateCreator<CombatSlice> = (set) => ({
  activeCombatSession: null,
  combatRounds: [],
  combatActionReceipts: [],
  combatHistory: [],
  lastCombatEnded: null,

  setActiveCombatSession: (combatSession: CombatSession | null) =>
    set(
      produce((state: CombatSlice) => {
        const previousCombatId = state.activeCombatSession?.combat_id
        const nextCombatId = combatSession?.combat_id
        const isNewCombatSession =
          !!nextCombatId && nextCombatId !== previousCombatId

        if (isNewCombatSession) {
          state.combatRounds = []
          state.combatActionReceipts = []
        }

        state.activeCombatSession = combatSession
      })
    ),

  updateActiveCombatSession: (updates: Partial<CombatSession>) =>
    set(
      produce((state: CombatSlice) => {
        if (!state.activeCombatSession) return
        state.activeCombatSession = {
          ...state.activeCombatSession,
          ...updates,
        }
      })
    ),

  setCombatRounds: (rounds: CombatRound[]) =>
    set(
      produce((state: CombatSlice) => {
        state.combatRounds = rounds
      })
    ),

  addCombatRound: (combatRound: CombatRound) =>
    set(
      produce((state: CombatSlice) => {
        const idx = state.combatRounds.findIndex(
          (entry) =>
            entry.combat_id === combatRound.combat_id &&
            entry.round === combatRound.round
        )

        if (idx >= 0) {
          state.combatRounds[idx] = combatRound
        } else {
          state.combatRounds.push(combatRound)
          state.combatRounds.sort((a, b) => a.round - b.round)
        }
      })
    ),

  clearCombatRounds: () =>
    set(
      produce((state: CombatSlice) => {
        state.combatRounds = []
      })
    ),

  setCombatActionReceipts: (receipts: CombatActionReceipt[]) =>
    set(
      produce((state: CombatSlice) => {
        state.combatActionReceipts = receipts
      })
    ),

  addCombatActionReceipt: (receipt: CombatActionReceipt) =>
    set(
      produce((state: CombatSlice) => {
        const idx = state.combatActionReceipts.findIndex(
          (entry) =>
            entry.combat_id === receipt.combat_id &&
            entry.round === receipt.round &&
            entry.action === receipt.action &&
            entry.commit === receipt.commit &&
            entry.target_id === receipt.target_id
        )
        if (idx >= 0) {
          state.combatActionReceipts[idx] = receipt
        } else {
          state.combatActionReceipts.push(receipt)
        }
      })
    ),

  clearCombatActionReceipts: () =>
    set(
      produce((state: CombatSlice) => {
        state.combatActionReceipts = []
      })
    ),

  setLastCombatEnded: (combat: CombatEndedRound | null) =>
    set(
      produce((state: CombatSlice) => {
        state.lastCombatEnded = combat
      })
    ),

  addCombatHistory: (combat: CombatEndedRound) =>
    set(
      produce((state: CombatSlice) => {
        const idx = state.combatHistory.findIndex(
          (entry) => entry.combat_id === combat.combat_id
        )
        if (idx >= 0) {
          state.combatHistory[idx] = combat
        } else {
          state.combatHistory.push(combat)
        }

        state.lastCombatEnded = combat
      })
    ),

  endActiveCombatSession: () =>
    set(
      produce((state: CombatSlice) => {
        state.activeCombatSession = null
        state.combatActionReceipts = []
      })
    ),

  resetCombatState: () =>
    set(
      produce((state: CombatSlice) => {
        state.activeCombatSession = null
        state.combatRounds = []
        state.combatActionReceipts = []
        state.combatHistory = []
        state.lastCombatEnded = null
      })
    ),
})
