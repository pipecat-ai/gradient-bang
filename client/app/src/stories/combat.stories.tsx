import { useEffect } from "react"

import type { Story } from "@ladle/react"

import {
  COMBAT_COLLECT_STATUS_UPDATE_PAYLOAD_MOCK,
  COMBAT_SECTOR_UPDATE_FULL_PAYLOAD_MOCK,
} from "@/mocks/combat.mock"
import useGameStore from "@/stores/game"

const JsonCard = ({ title, value }: { title: string; value: unknown }) => {
  return (
    <section className="rounded-sm border border-border/70 bg-card/60 p-3 min-h-0">
      <h3 className="text-xs uppercase tracking-wider text-subtle-foreground mb-2">{title}</h3>
      <pre className="text-xs leading-relaxed overflow-auto max-h-[280px] whitespace-pre-wrap break-all">
        {JSON.stringify(value ?? null, null, 2)}
      </pre>
    </section>
  )
}

export const CombatFlowStory: Story = () => {
  const uiState = useGameStore((state) => state.uiState)
  const activeCombatSession = useGameStore((state) => state.activeCombatSession)
  const combatRounds = useGameStore((state) => state.combatRounds)
  const combatActionReceipts = useGameStore((state) => state.combatActionReceipts)
  const lastCombatEnded = useGameStore((state) => state.lastCombatEnded)
  const combatHistory = useGameStore((state) => state.combatHistory)
  const activityLog = useGameStore((state) => state.activity_log)
  const sector = useGameStore((state) => state.sector)

  const resetCombatState = useGameStore((state) => state.resetCombatState)
  const setUIState = useGameStore((state) => state.setUIState)
  const setPlayer = useGameStore((state) => state.setPlayer)
  const setShip = useGameStore((state) => state.setShip)
  const setSector = useGameStore((state) => state.setSector)

  useEffect(() => {
    resetCombatState()
    setUIState("idle")
    setPlayer(COMBAT_COLLECT_STATUS_UPDATE_PAYLOAD_MOCK.player)
    setShip(COMBAT_COLLECT_STATUS_UPDATE_PAYLOAD_MOCK.ship)
    setSector(COMBAT_SECTOR_UPDATE_FULL_PAYLOAD_MOCK)
  }, [resetCombatState, setPlayer, setSector, setShip, setUIState])

  return (
    <div className="h-screen bg-background text-foreground p-4 overflow-auto">
      <header className="mb-4">
        <h2 className="text-lg font-medium">Combat Story</h2>
        <p className="text-sm text-subtle-foreground">
          Use the Leva `Combat` and `Combat Side Events` folders to step through mock combat
          events.
        </p>
      </header>

      <div className="mb-4 text-sm text-subtle-foreground">
        uiState: <span className="text-foreground">{uiState}</span> | rounds:{" "}
        <span className="text-foreground">{combatRounds.length}</span> | receipts:{" "}
        <span className="text-foreground">{combatActionReceipts.length}</span> | history:{" "}
        <span className="text-foreground">{combatHistory.length}</span>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <JsonCard title="Active Combat Session" value={activeCombatSession} />
        <JsonCard title="Combat Rounds" value={combatRounds} />
        <JsonCard title="Combat Action Receipts" value={combatActionReceipts} />
        <JsonCard title="Last Combat Ended" value={lastCombatEnded} />
        <JsonCard title="Current Sector" value={sector} />
        <JsonCard title="Activity Log (Recent 25)" value={activityLog.slice(-25)} />
      </div>
    </div>
  )
}

CombatFlowStory.meta = {
  useDevTools: true,
  useChatControls: false,
  disconnectedStory: true,
  enableMic: false,
  disableAudioOutput: true,
}

