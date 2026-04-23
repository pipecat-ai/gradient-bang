import { useCallback, useEffect, useMemo } from "react"

import { CombatPanel } from "./components/CombatPanel"
import { DecisionTracePanel } from "./components/DecisionTracePanel"
import { EntityRoster } from "./components/EntityRoster"
import { EventLog } from "./components/EventLog"
import { ScenarioBuilder } from "./components/ScenarioBuilder"
import { ControllerManager } from "./controllers/ControllerManager"
import type { ControllerConfig } from "./controllers/types"
import { InMemoryEmitter } from "./engine/emitter"
import { CombatEngine } from "./engine/engine"
import { useEngineEvents } from "./hooks/useEngineEvents"
import { useWorld } from "./hooks/useWorld"
import { useAppStore } from "./store/appStore"

export function App() {
  const { engine, emitter } = useMemo(() => {
    const emitter = new InMemoryEmitter()
    const engine = new CombatEngine({
      emitter,
      timerEnabled: useAppStore.getState().timerEnabled,
    })
    return { engine, emitter }
  }, [])
  const timerEnabled = useAppStore((s) => s.timerEnabled)
  const setTimerEnabledInStore = useAppStore((s) => s.setTimerEnabled)
  const handleToggleTimer = useCallback(
    (v: boolean) => {
      setTimerEnabledInStore(v)
      engine.setTimerEnabled(v)
    },
    [engine, setTimerEnabledInStore],
  )

  // ControllerManager is created once per engine and wired to the Zustand
  // store for trace capture + in-flight signaling.
  const manager = useMemo(() => {
    return new ControllerManager({
      engine,
      emitter,
      getController: (id) => useAppStore.getState().controllers[id],
      onTrace: (trace) => useAppStore.getState().addTrace(trace),
      onInFlight: (id, v) => useAppStore.getState().setInFlight(id, v),
    })
  }, [engine, emitter])

  useEffect(() => {
    manager.start()
    return () => manager.stop()
  }, [manager])

  // When a controller flips from LLM → non-LLM, tear the agent down.
  const handleSetController = useCallback(
    (entityId: string, config: ControllerConfig | null) => {
      const prev = useAppStore.getState().controllers[entityId]
      useAppStore.getState().setController(entityId, config)
      if (prev?.kind === "llm" && config?.kind !== "llm") {
        manager.dropController(entityId)
      }
    },
    [manager],
  )

  const events = useEngineEvents(emitter)
  const world = useWorld(engine, emitter)

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-4 border-b border-neutral-800 bg-neutral-950 px-4 py-2">
        <h1 className="text-sm font-semibold tracking-wide text-neutral-200">
          Combat Debug Harness
        </h1>
        <label className="flex items-center gap-1.5 text-[11px] text-neutral-400">
          <input
            type="checkbox"
            checked={timerEnabled}
            onChange={(e) => handleToggleTimer(e.target.checked)}
            className="accent-emerald-500"
          />
          <span>Round timer</span>
          <span
            className={`rounded border px-1 text-[9px] uppercase tracking-wider ${
              timerEnabled
                ? "border-emerald-700 bg-emerald-950/50 text-emerald-300"
                : "border-neutral-700 bg-neutral-900 text-neutral-400"
            }`}
          >
            {timerEnabled ? "on" : "paused"}
          </span>
        </label>
      </header>
      <ScenarioBuilder engine={engine} world={world} onSetController={handleSetController} />
      <EntityRoster engine={engine} world={world} onSetController={handleSetController} />
      <CombatPanel engine={engine} world={world} />
      <DecisionTracePanel />
      <main className="flex-1 overflow-hidden">
        <EventLog events={events} />
      </main>
    </div>
  )
}
