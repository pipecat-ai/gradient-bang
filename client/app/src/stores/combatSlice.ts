import { produce } from "immer"
import type { StateCreator } from "zustand"

export interface CombatSlice {
  activeCombatSession: CombatSession | null
  /**
   * Combats the local player is NOT a participant in but is observing
   * (e.g. corp ships fighting solo). Keyed by combat_id. Used to power
   * "in combat" indicators on corp ship cards without polluting the
   * personal combat UI flow that depends on activeCombatSession.
   */
  observedCombatSessions: Record<string, CombatSession>
  combatRounds: CombatRound[]
  combatActionReceipts: CombatActionReceipt[]
  combatHistory: CombatEndedRound[]
  lastCombatEnded: CombatEndedRound | null
  tookDamageThisRound: boolean
  setTookDamageThisRound: (tookDamage: boolean) => void

  setActiveCombatSession: (combatSession: CombatSession | null) => void
  updateActiveCombatSession: (updates: Partial<CombatSession>) => void

  setObservedCombatSession: (combatSession: CombatSession) => void
  removeObservedCombatSession: (combatId: string) => void

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
  observedCombatSessions: {},
  combatRounds: [],
  combatActionReceipts: [],
  combatHistory: [],
  lastCombatEnded: null,
  tookDamageThisRound: false,

  setTookDamageThisRound: (tookDamage: boolean) =>
    set(
      produce((state: CombatSlice) => {
        state.tookDamageThisRound = tookDamage
      })
    ),

  setActiveCombatSession: (combatSession: CombatSession | null) =>
    set(
      produce((state: CombatSlice) => {
        const previousCombatId = state.activeCombatSession?.combat_id
        const nextCombatId = combatSession?.combat_id
        const isNewCombatSession = !!nextCombatId && nextCombatId !== previousCombatId

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

  setObservedCombatSession: (combatSession: CombatSession) =>
    set(
      produce((state: CombatSlice) => {
        state.observedCombatSessions[combatSession.combat_id] = combatSession
      })
    ),

  removeObservedCombatSession: (combatId: string) =>
    set(
      produce((state: CombatSlice) => {
        delete state.observedCombatSessions[combatId]
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
          (entry) => entry.combat_id === combatRound.combat_id && entry.round === combatRound.round
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
        const idx = state.combatHistory.findIndex((entry) => entry.combat_id === combat.combat_id)
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
        state.observedCombatSessions = {}
        state.combatRounds = []
        state.combatActionReceipts = []
        state.combatHistory = []
        state.lastCombatEnded = null
      })
    ),
})
