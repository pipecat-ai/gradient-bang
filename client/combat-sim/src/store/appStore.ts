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

  // In-flight LLM decisions per entity. Ref-counted because a slow or
  // timed-out round N decision can still be pending when round N+1's
  // decision kicks off — if we stored a plain boolean, whichever finally{}
  // fires first would flip "thinking" off while another decision is still
  // running, making the badge flicker unreliably.
  inFlight: Record<string, number>
  bumpInFlight: (entityId: string, delta: 1 | -1) => void
  /** Drop every in-flight counter — called on world reset. */
  clearInFlight: () => void

  // Round timer toggle — when off, new rounds get deadline=null so only
  // all-submitted auto-resolves (no time pressure while debugging).
  timerEnabled: boolean
  setTimerEnabled: (v: boolean) => void

  // Staging mode: compose the arena without auto-engaging. User flips to
  // false via a "Run scenario" button once setup is complete.
  stagingMode: boolean
  setStagingMode: (v: boolean) => void
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
  bumpInFlight: (entityId, delta) =>
    set((s) => {
      const next = Math.max(0, (s.inFlight[entityId] ?? 0) + delta)
      return { inFlight: { ...s.inFlight, [entityId]: next } }
    }),
  clearInFlight: () => set({ inFlight: {} }),

  timerEnabled: true,
  setTimerEnabled: (v) => set({ timerEnabled: v }),

  stagingMode: true,
  setStagingMode: (v) => set({ stagingMode: v }),
}))
