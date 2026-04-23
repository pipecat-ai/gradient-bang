import { create } from "zustand"

import type { ControllerConfig, DecisionTrace } from "../controllers/types"
import type { EntityId } from "../engine/types"

interface AppState {
  // POV / filter
  selectedEntityId: EntityId | null
  selectEntity: (id: EntityId | null) => void
  toggleEntity: (id: EntityId) => void

  // Per-entity controller configuration
  controllers: Record<string, ControllerConfig>
  setController: (entityId: string, config: ControllerConfig | null) => void

  // LLM decision traces (newest appended; UI reverses for display)
  traces: DecisionTrace[]
  addTrace: (trace: DecisionTrace) => void
  clearTraces: () => void

  // In-flight LLM calls (per entity)
  inFlight: Record<string, boolean>
  setInFlight: (entityId: string, inFlight: boolean) => void

  // Round timer toggle — when off, new rounds get deadline=null so only
  // all-submitted auto-resolves (no time pressure while debugging).
  timerEnabled: boolean
  setTimerEnabled: (v: boolean) => void
}

export const useAppStore = create<AppState>()((set, get) => ({
  selectedEntityId: null,
  selectEntity: (id) => set({ selectedEntityId: id }),
  toggleEntity: (id) =>
    set({ selectedEntityId: get().selectedEntityId === id ? null : id }),

  controllers: {},
  setController: (entityId, config) =>
    set((s) => {
      const next = { ...s.controllers }
      if (config) next[entityId] = config
      else delete next[entityId]
      return { controllers: next }
    }),

  traces: [],
  addTrace: (trace) => set((s) => ({ traces: [...s.traces, trace] })),
  clearTraces: () => set({ traces: [] }),

  inFlight: {},
  setInFlight: (entityId, inFlight) =>
    set((s) => ({ inFlight: { ...s.inFlight, [entityId]: inFlight } })),

  timerEnabled: true,
  setTimerEnabled: (v) => set({ timerEnabled: v }),
}))
