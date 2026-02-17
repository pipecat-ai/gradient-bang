import { produce } from "immer"
import type { StateCreator } from "zustand"

import { createLogEntrySignature } from "@/utils/game"

import type { EventQueryEntry } from "@/types/messages"

const MAX_MOVEMENT_HISTORY = 200

export interface HistorySlice {
  activity_log: LogEntry[]
  addActivityLogEntry: (entry: LogEntry) => void

  movement_history: MovementHistory[]
  addMovementHistory: (history: Omit<MovementHistory, "timestamp">) => void

  known_ports: SectorHistory[] | undefined // Note: allow undefined here to handle fetching state
  setKnownPorts: (ports: SectorHistory[]) => void

  // Task history from server
  task_history: TaskHistoryEntry[] | undefined
  setTaskHistory: (tasks: TaskHistoryEntry[]) => void

  // Task events (from event.query)
  task_events: EventQueryEntry[] | undefined
  setTaskEvents: (events: EventQueryEntry[]) => void
}

export const createHistorySlice: StateCreator<HistorySlice> = (set) => ({
  activity_log: [],
  known_ports: undefined,
  task_history: undefined,
  user_ships: undefined,
  task_events: undefined,

  addActivityLogEntry: (entry: LogEntry) =>
    set(
      produce((state) => {
        const timestamp = entry.timestamp ?? new Date().toISOString()
        const timestampClient = entry.timestamp_client ?? Date.now()
        const meta = entry.meta ?? {}

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

  setKnownPorts: (ports: SectorHistory[]) =>
    set(
      produce((state) => {
        state.known_ports = ports
      })
    ),

  setTaskHistory: (tasks: TaskHistoryEntry[]) =>
    set(
      produce((state) => {
        state.task_history = tasks
      })
    ),

  setTaskEvents: (events: EventQueryEntry[]) =>
    set(
      produce((state) => {
        state.task_events = events
      })
    ),
})
