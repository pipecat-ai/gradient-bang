import { produce } from "immer";
import type { StateCreator } from "zustand";

export interface HistorySlice {
  activity_log: LogEntry[];
  addActivityLogEntry: (entry: LogEntry) => void;
  movement_history: MovementHistory[];
  addMovementHistory: (history: Omit<MovementHistory, "timestamp">) => void;
}

export const createHistorySlice: StateCreator<HistorySlice> = (set) => ({
  activity_log: [],
  addActivityLogEntry: (entry: LogEntry) =>
    set(
      produce((state) => {
        state.activity_log.push({
          ...entry,
          timestamp: new Date().toISOString(),
          // Point in time data
          // @TODO: server is better source of truth for this stuff,
          // if no use-case emerges, remove this
          meta: {
            player: state.player,
            ship: state.ship,
            sector: state.sector,
          },
        });
      })
    ),
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
