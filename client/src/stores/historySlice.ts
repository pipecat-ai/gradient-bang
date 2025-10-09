import { produce } from "immer";
import type { StateCreator } from "zustand";

export interface HistorySlice {
  movement_history: MovementHistory[];
  addMovementHistory: (history: Omit<MovementHistory, "timestamp">) => void;
}

export const createHistorySlice: StateCreator<HistorySlice> = (set) => ({
  movement_history: [],
  addMovementHistory: (history: Omit<MovementHistory, "timestamp">) =>
    set(
      produce((state) => {
        state.movement_history.push({
          ...history,
          timestamp: new Date().toISOString(),
        });
      })
    ),
});
