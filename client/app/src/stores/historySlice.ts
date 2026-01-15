import { produce } from "immer"
import type { StateCreator } from "zustand"

import { createLogEntrySignature } from "@/utils/game"

const MAX_MOVEMENT_HISTORY = 50

export interface HistorySlice {
  activity_log: LogEntry[]
  addActivityLogEntry: (entry: LogEntry) => void

  movement_history: MovementHistory[]
  addMovementHistory: (history: Omit<MovementHistory, "timestamp">) => void

  known_ports: Sector[] | undefined // Note: allow undefined here to handle fetching state
  setKnownPorts: (ports: Sector[]) => void
}

export const createHistorySlice: StateCreator<HistorySlice> = (set) => ({
  activity_log: [],
  known_ports: undefined,

  addActivityLogEntry: (entry: LogEntry) =>
    set(
      produce((state) => {
        const timestamp = entry.timestamp ?? new Date().toISOString()
        const timestampClient = entry.timestamp_client ?? Date.now()
        const meta = {
          ...entry.meta,
          //@TODO: see if we need this?
          sector_id: state.sector?.id,
          //player: state.player,
          //ship: state.ship,
          //sector: state.sector,
        }

        state.activity_log.push({
          ...entry,
          timestamp,
          timestamp_client: timestampClient,
          signature:
            entry.signature ??
            createLogEntrySignature({
              type: entry.type,
              meta,
            }),
          meta,
        })
      })
    ),
  movement_history: [],
  addMovementHistory: (history: Omit<MovementHistory, "timestamp">) => {
    return set(
      produce((state) => {
        state.movement_history.push({
          ...history,
          timestamp: new Date().toISOString(),
        })
        // Keep only the last MAX_MOVEMENT_HISTORY entries
        if (state.movement_history.length > MAX_MOVEMENT_HISTORY) {
          state.movement_history.shift() // Remove oldest entry
        }
      })
    )
  },

  setKnownPorts: (ports: Sector[]) =>
    set(
      produce((state) => {
        state.known_ports = ports
      })
    ),
})
