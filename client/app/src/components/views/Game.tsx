import { useCallback, useEffect, useState } from "react"

import { Group, Panel, Separator, usePanelRef } from "react-resizable-panels"
import { ArrowLeftIcon } from "@phosphor-icons/react"
import { PipecatClientAudio } from "@pipecat-ai/client-react"

import { Leaderboard } from "@/components/dialogs/Leaderboard"
import { Settings } from "@/components/dialogs/Settings"
import { CombatActionPanel } from "@/components/panels/CombatActionPanel"
import { ConversationPanel } from "@/components/panels/ConversationPanel"
import { MiniMapPanel } from "@/components/panels/MiniMapPanel"
import { PlayerShipPanel } from "@/components/panels/PlayerShipPanel"
import { RHSPanelContainer } from "@/components/panels/RHSPanelContainer"
import { RHSPanelNav } from "@/components/panels/RHSPanelNav"
import { TaskEnginesPanel } from "@/components/panels/TaskEnginesPanel"
import { Button } from "@/components/primitives/Button"
import { ScreenContainer } from "@/components/screens/ScreenContainer"
import { SectorTitleBanner } from "@/components/SectorTitleBanner"
import { Starfield } from "@/components/Starfield"
import { ToastContainer } from "@/components/toasts/ToastContainer"
import { TopBar } from "@/components/TopBar"
import { useNotificationSound } from "@/hooks/useNotificationSound"
import useAudioStore from "@/stores/audio"
import useGameStore from "@/stores/game"
import { cn } from "@/utils/tailwind"

const disabledCx = "pointer-events-none opacity-0"
const enabledCx = "pointer-events-auto opacity-100"

export const Game = () => {
  const uiState = useGameStore.use.uiState()
  const asidePanelRef = usePanelRef()
  const lookMode = useGameStore.use.lookMode()
  const setLookMode = useGameStore.use.setLookMode?.()
  const [isCollapsed, setIsCollapsed] = useState(false)

  useNotificationSound()

  const handleAsideResize = useCallback(() => {
    const collapsed = asidePanelRef.current?.isCollapsed?.() ?? false
    setIsCollapsed(collapsed)
  }, [asidePanelRef])

  useEffect(() => {
    if (uiState === "combat") {
      console.debug("%c[GAME] Entering combat", "color: red; font-weight: bold")
      useAudioStore.getState().playSound("enterCombat", { volume: 0.1, once: true, loop: false })
      // Reset look mode and active screen
      const gameStore = useGameStore.getState()
      gameStore.setLookMode(false)
      gameStore.setActiveScreen(undefined)
      gameStore.setActivePanel("sector")
    } else {
      useAudioStore.getState().stopSound("enterCombat")
    }
  }, [uiState, setLookMode])
  return (
    <>
      {lookMode && (
        <div className="fixed bottom-ui-lg z-90 inset-x-0 text-center pointer-events-none">
          <div className="flex flex-col gap-ui-md justify-center items-center">
            <span className="text-xs text-subtle-foreground uppercase bg-background/40 p-ui-xs py-ui-xxs">
              Click and drag scene to look around
            </span>
            <Button
              variant="default"
              size="lg"
              onClick={() => setLookMode(false)}
              className="mx-auto ring-4 ring-background/20 hover:bg-background pointer-events-auto"
            >
              Exit explore mode
            </Button>
          </div>
        </div>
      )}
      <Group
        orientation="horizontal"
        className={cn(
          "relative z-(--z-ui) transition-opacity duration-500",
          lookMode ? disabledCx : enabledCx
        )}
      >
        <Panel className="flex flex-col">
          <TopBar />
          <main className="relative flex-1 flex flex-col gap-0 @container/main">
            {uiState === "combat" && (
              <div className="inset-0 pointer-events-none animate-in fade-in-100 combat-vignette combat-border absolute!" />
            )}
            <div className="p-ui-xs flex-1">
              {uiState === "combat" ?
                <CombatActionPanel />
              : <TaskEnginesPanel />}
            </div>
            <footer className="p-ui-xs pt-0 h-[330px] flex flex-row gap-ui-sm justify-between">
              <ConversationPanel className="flex-1 max-w-xl" />
              <MiniMapPanel className="max-w-[330px]" />
            </footer>
          </main>
        </Panel>
        <Separator className="w-px bg-border outline-white data-[separator=active]:bg-white data-[separator=active]:outline-1 data-[separator=hover]:bg-subtle z-90" />
        <Panel
          collapsible
          defaultSize="480px"
          minSize="400px"
          maxSize="580px"
          collapsedSize="60px"
          className="@container/aside"
          panelRef={asidePanelRef}
          onResize={handleAsideResize}
        >
          <aside className="h-full border-transparent border-l-(length:--separator) border-l-background flex-col hidden @sm/aside:flex">
            <header className="pb-separator flex flex-col gap-separator bg-black">
              <PlayerShipPanel />
            </header>
            <div className="h-full flex-1 flex flex-col items-center justify-center overflow-hidden">
              <RHSPanelContainer />
            </div>
            <RHSPanelNav />
          </aside>
          {isCollapsed && (
            <div className="h-full flex-col items-center justify-center flex bg-background/80">
              <Button
                variant="secondary"
                size="icon"
                className="bg-background"
                onClick={() => asidePanelRef?.current?.expand()}
              >
                <ArrowLeftIcon size={16} />
              </Button>
            </div>
          )}
        </Panel>
      </Group>

      {/* Sub-screens (trading, ship, messaging, etc..) */}
      <ScreenContainer />

      {/* Dialogs */}
      <Settings />
      <Leaderboard />

      {/* Other Renderables */}
      <Starfield />
      <SectorTitleBanner />
      <ToastContainer />
      <PipecatClientAudio />
    </>
  )
}

export default Game
