import { Play, ArrowCounterClockwise, ListMagnifyingGlass, Timer } from "@phosphor-icons/react"
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
    const initialState = useAppStore.getState()
    const engine = new CombatEngine({
      emitter,
      timerEnabled: initialState.timerEnabled,
      stagingMode: initialState.stagingMode,
    })
    return { engine, emitter }
  }, [])
  const timerEnabled = useAppStore((s) => s.timerEnabled)
  const setTimerEnabledInStore = useAppStore((s) => s.setTimerEnabled)
  const stagingMode = useAppStore((s) => s.stagingMode)
  const setStagingModeInStore = useAppStore((s) => s.setStagingMode)

  const handleToggleTimer = useCallback(
    (v: boolean) => {
      setTimerEnabledInStore(v)
      engine.setTimerEnabled(v)
    },
    [engine, setTimerEnabledInStore],
  )

  const handleRunScenario = useCallback(() => {
    engine.runScenario()
    setStagingModeInStore(false)
  }, [engine, setStagingModeInStore])

  const handleReStage = useCallback(() => {
    engine.setStagingMode(true)
    setStagingModeInStore(true)
  }, [engine, setStagingModeInStore])

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

  // On world.reset: drop stale per-entity UI state. Also flip the engine
  // back into staging mode so the user can compose the next scenario
  // without auto-engage firing mid-setup.
  useEffect(() => {
    const unsub = emitter.subscribe((event) => {
      if (event.type !== "world.reset") return
      const s = useAppStore.getState()
      s.clearTraces()
      s.clearInFlight()
      s.selectEntity(null)
      engine.setStagingMode(true)
      s.setStagingMode(true)
    })
    return unsub
  }, [emitter, engine])

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

  // True when `runScenario()` would actually kick off combat — mirrors the
  // three engine paths: hostile-garrison auto-engage, or any sector with 2+
  // combatants (characters + corp ships + garrisons) that the harness will
  // initiate a fight in. Without this guard the Run button blinks even when
  // the arena has nothing to fight about.
  const canRunCombat = useMemo(() => {
    // Path 1: at least one sector has an offensive/toll garrison with a
    // hostile character present.
    for (const g of world.garrisons.values()) {
      if (g.mode !== "offensive" && g.mode !== "toll") continue
      if (g.fighters <= 0) continue
      const ownerCorp = world.characters.get(g.ownerCharacterId)?.corpId ?? null
      for (const c of world.characters.values()) {
        if (c.currentSector !== g.sector) continue
        if (c.id === g.ownerCharacterId) continue
        if (ownerCorp && c.corpId === ownerCorp) continue
        return true
      }
    }
    // Path 2: any sector has 2+ combatants (chars + corp ships + garrisons).
    // Mirrors the explicit-initiate pass in engine.runScenario().
    const sectorCount = new Map<number, number>()
    const bump = (sector: number) =>
      sectorCount.set(sector, (sectorCount.get(sector) ?? 0) + 1)
    for (const c of world.characters.values()) bump(c.currentSector)
    for (const s of world.ships.values())
      if (s.ownerCorpId && s.fighters > 0) bump(s.sector)
    for (const g of world.garrisons.values())
      if (g.fighters > 0) bump(g.sector)
    for (const count of sectorCount.values()) {
      if (count >= 2) return true
    }
    return false
  }, [world])

  const [summaryOpen, setSummaryOpen] = useState(false)

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-neutral-800 bg-gradient-to-r from-neutral-950 via-neutral-950 to-neutral-900 px-4 py-2 shadow-sm shadow-black/30">
        <h1 className="text-sm font-semibold tracking-wider text-neutral-100">
          Gradient Bang Combat Sim
        </h1>
        <div className="mx-1 h-4 w-px bg-neutral-800" />
        {stagingMode ? (
          <button
            type="button"
            onClick={handleRunScenario}
            disabled={!canRunCombat}
            className={`group inline-flex items-center gap-1.5 rounded-md border px-3 py-1 text-[11px] font-semibold uppercase tracking-wider transition disabled:cursor-not-allowed ${
              canRunCombat
                ? "border-emerald-400/80 bg-emerald-900/60 text-emerald-50 shadow-md shadow-emerald-900/50 hover:border-emerald-300 hover:bg-emerald-800/70 anim-blink"
                : "border-neutral-800 bg-neutral-900/60 text-neutral-500"
            }`}
            title={
              canRunCombat
                ? "Start the scenario: auto-engage hostile garrisons and initiate combat in any sector with 2+ combatants."
                : "Need at least 2 combatants in a sector (characters, corp ships, or a garrison) before the scenario can run."
            }
          >
            <Play weight="fill" className="h-3 w-3" />
            Run scenario
          </button>
        ) : (
          <button
            type="button"
            onClick={handleReStage}
            className="inline-flex items-center gap-1.5 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1 text-[11px] font-medium uppercase tracking-wider text-neutral-400 transition hover:border-neutral-500 hover:text-neutral-200"
            title="Re-enter staging mode: future moves / deploys won't auto-engage until 'Run scenario' is clicked again."
          >
            <ArrowCounterClockwise weight="bold" className="h-3 w-3" />
            Re-stage
          </button>
        )}
        <button
          type="button"
          onClick={() => handleToggleTimer(!timerEnabled)}
          title={timerEnabled ? "Round timer is ON — disable to pause deadlines" : "Round timer is PAUSED — enable for real-time rounds"}
          className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] transition ${
            timerEnabled
              ? "border-emerald-800/60 bg-emerald-950/40 text-emerald-200 hover:bg-emerald-900/40"
              : "border-neutral-700 bg-neutral-900 text-neutral-400 hover:text-neutral-200"
          }`}
        >
          <Timer weight={timerEnabled ? "fill" : "duotone"} className="h-3.5 w-3.5" />
          <span>Timer</span>
          <span
            className={`rounded px-1 text-[9px] font-bold uppercase tracking-wider ${
              timerEnabled
                ? "bg-emerald-600/30 text-emerald-100"
                : "bg-neutral-800 text-neutral-500"
            }`}
          >
            {timerEnabled ? "on" : "off"}
          </span>
        </button>
        <button
          type="button"
          onClick={() => setSummaryOpen(true)}
          className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-neutral-700 bg-neutral-900 px-2.5 py-1 text-[11px] text-neutral-200 transition hover:border-neutral-500 hover:bg-neutral-800"
        >
          <ListMagnifyingGlass weight="duotone" className="h-3.5 w-3.5" />
          Summarize…
        </button>
      </header>
      <ScenarioBuilder engine={engine} world={world} onSetController={handleSetController} />
      <CombatPanel engine={engine} world={world} />
      <div className="flex min-h-0 flex-1">
        <aside className="w-[420px] shrink-0 overflow-auto border-r border-neutral-800">
          <EntityRoster engine={engine} world={world} onSetController={handleSetController} />
        </aside>
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <EventLog events={events} />
        </main>
      </div>
      <SummarizeModal
        events={events}
        world={world}
        open={summaryOpen}
        onClose={() => setSummaryOpen(false)}
      />
    </div>
  )
}
