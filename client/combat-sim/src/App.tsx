import { useCallback, useEffect, useMemo, useState } from "react"

import { CombatPanel } from "./components/CombatPanel"
import { EntityRoster } from "./components/EntityRoster"
import { EventLog } from "./components/EventLog"
import { ScenarioBuilder } from "./components/ScenarioBuilder"
import { SummarizeModal } from "./components/SummarizeModal"
import { ControllerManager } from "./controllers/ControllerManager"
import type { ControllerConfig } from "./controllers/types"
import { InMemoryEmitter } from "./engine/emitter"
import { CombatEngine } from "./engine/engine"
import { useEngineEvents } from "./hooks/useEngineEvents"
import { useWorld } from "./hooks/useWorld"
import { MockEventRelay } from "./relay/event_relay"
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

  // MockEventRelay subscribes FIRST so every downstream subscriber
  // (DebugAgent, ControllerManager, React event-log hook) sees the
  // per-recipient append/run_llm annotations already attached to the
  // event via `event.relay`.
  const relay = useMemo(
    () => new MockEventRelay({ engine, emitter }),
    [engine, emitter],
  )
  useEffect(() => {
    relay.start()
    return () => relay.stop()
  }, [relay])

  // ControllerManager is created once per engine and wired to the Zustand
  // store for trace capture + in-flight signaling.
  const manager = useMemo(() => {
    return new ControllerManager({
      engine,
      emitter,
      getController: (id) => useAppStore.getState().controllers[id],
      onTrace: (trace) => useAppStore.getState().addTrace(trace),
      onInFlight: (id, v) =>
        useAppStore.getState().bumpInFlight(id, v ? 1 : -1),
    })
  }, [engine, emitter])

  useEffect(() => {
    manager.start()
    return () => manager.stop()
  }, [manager])

  // Flush store-side state tied to the old world whenever `world.reset`
  // fires. Without this, old decision traces pile up under char-1 / combat-1
  // ids that the engine's reset-and-restart hands out again — the Summarize
  // digest then merges pre- and post-reset decisions under the same key and
  // produces the "three Round 1 decisions for Ren-49" confusion.
  useEffect(() => {
    const unsub = emitter.subscribe((event) => {
      if (event.type !== "world.reset") return
      const s = useAppStore.getState()
      s.clearTraces()
      s.clearInFlight()
      s.selectEntity(null)
    })
    return unsub
  }, [emitter])

  // When a controller flips from LLM → non-LLM, tear the agent down. When
  // flipped TO LLM (or changed while LLM), rebuild the agent so its
  // subscription is live BEFORE the next combat event fires — lazy creation
  // inside handleEvent misses the very event that triggered it.
  const handleSetController = useCallback(
    (entityId: string, config: ControllerConfig | null) => {
      const prev = useAppStore.getState().controllers[entityId]
      useAppStore.getState().setController(entityId, config)
      if (prev?.kind === "llm" && config?.kind !== "llm") {
        manager.dropController(entityId)
      }
      if (config?.kind === "llm") {
        // Rebuild (drop first when reconfiguring an existing LLM) so the
        // agent picks up the new model/strategy. Cheap — just a replay.
        if (prev?.kind === "llm") manager.dropController(entityId)
        manager.ensureAgentNow(entityId, config)
      }
    },
    [manager],
  )

  const events = useEngineEvents(emitter)
  const world = useWorld(engine, emitter)

  const [summaryOpen, setSummaryOpen] = useState(false)

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-4 border-b border-neutral-800 bg-neutral-950 px-4 py-2">
        <h1 className="text-sm font-semibold tracking-wide text-neutral-200">
          Combat Sim
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
        <button
          type="button"
          onClick={() => setSummaryOpen(true)}
          className="ml-auto rounded bg-neutral-800 px-2 py-1 text-[11px] text-neutral-200 hover:bg-neutral-700"
        >
          Summarize…
        </button>
      </header>
      <ScenarioBuilder engine={engine} world={world} onSetController={handleSetController} />
      <EntityRoster engine={engine} world={world} onSetController={handleSetController} />
      <CombatPanel engine={engine} world={world} />
      <main className="flex-1 overflow-hidden">
        <EventLog events={events} />
      </main>
      <SummarizeModal
        events={events}
        world={world}
        open={summaryOpen}
        onClose={() => setSummaryOpen(false)}
      />
    </div>
  )
}
