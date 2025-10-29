import { produce } from "immer";
import type { StateCreator } from "zustand";

export interface CombatSlice {
  activeCombatSession: CombatSession | null;
  combatRounds: CombatRound[];
  addCombatRound: (combatRound: CombatRound) => void;
  setActiveCombatSession: (combatSession: CombatSession) => void;
  endActiveCombatSession: () => void;
}

export const createCombatSlice: StateCreator<CombatSlice> = (set) => ({
  activeCombatSession: null,
  combatRounds: [],
  addCombatRound: (combatRound: CombatRound) =>
    set(
      produce((state) => {
        state.combatRounds.push(combatRound);
        state.activeCombatSession = {
          ...state.activeCombatSession,
          round: combatRound.round,
        };
      })
    ),

  setActiveCombatSession: (combatSession: CombatSession) =>
    set(
      produce((state) => {
        state.activeCombatSession = combatSession;
      })
    ),

  endActiveCombatSession: () =>
    set(
      produce((state) => {
        state.activeCombatSession = null;
      })
    ),
});
