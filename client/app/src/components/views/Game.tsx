import { useCallback, useEffect, useState } from "react"

import { AnimatePresence, motion } from "motion/react"
import { Group, Panel, Separator, usePanelRef } from "react-resizable-panels"
import { ArrowLeftIcon, WarningDiamondIcon } from "@phosphor-icons/react"
import { PipecatClientAudio } from "@pipecat-ai/client-react"

import { ActivityStream } from "@/components/ActivityStream"
import { Disconnect } from "@/components/dialogs/Disconnect"
import { Leaderboard } from "@/components/dialogs/Leaderboard"
import { Settings } from "@/components/dialogs/Settings"
import { HighlightOverlay } from "@/components/HighlightOverlay"
import { BigMapPanel } from "@/components/panels/BigMapPanel"
import { CombatActionPanel } from "@/components/panels/CombatActionPanel"
import { CombatDamageVignette } from "@/components/panels/CombatDamageVignette"
import { ConversationPanel } from "@/components/panels/ConversationPanel"
import { MiniMapPanel } from "@/components/panels/MiniMapPanel"
import { MiniTaskEngines } from "@/components/panels/MiniTaskEngines"
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
import { UIModeToggle } from "@/components/UIModeToggle"
import { useNotificationSound } from "@/hooks/useNotificationSound"
import useAudioStore from "@/stores/audio"
import useGameStore from "@/stores/game"
import { cn } from "@/utils/tailwind"

const disabledCx = "pointer-events-none opacity-0"
const enabledCx = "pointer-events-auto opacity-100"

export const Game = () => {
  const uiState = useGameStore.use.uiState()
  const uiMode = useGameStore.use.uiMode()
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
      useAudioStore.getState().playSound("enterCombat", { volume: 0.1, loop: false })
      // Reset look mode and active screen
      const gameStore = useGameStore.getState()
      gameStore.setLookMode(false)
      gameStore.setActiveScreen(undefined)
      gameStore.setActivePanel("sector")
    } else {
      useAudioStore.getState().stopSound("enterCombat")
    }
  }, [uiState, setLookMode])

  useEffect(() => {
    const unsub = useGameStore.subscribe((state, prevState) => {
      if (state.uiMode !== prevState.uiMode) {
        useAudioStore.getState().playSound("chime4")
      }
    })
    return unsub
  }, [])

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
        {...(lookMode ? { inert: true } : {})}
      >
        <Panel className="flex flex-col">
          <TopBar />
          <main className=" @container/main relative flex-1 flex flex-col gap-0 gap-y-ui-sm">
            <div className="absolute left-0 top-1/2 -translate-y-1/2 w-full pointer-events-none z-20">
              <ActivityStream />
            </div>

            {uiState === "combat" && <CombatDamageVignette />}
            <div className="flex-1">
              {uiState === "combat" ?
                <CombatActionPanel />
              : <>
                  <AnimatePresence mode="wait">
                    {uiMode === "tasks" ?
                      <motion.div
                        key="task-engines"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="h-full flex-1"
                      >
                        <TaskEnginesPanel />
                      </motion.div>
                    : <motion.div
                        key="mini-task-engines"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="h-full flex-1"
                      >
                        <BigMapPanel />
                      </motion.div>
                    }
                  </AnimatePresence>
                </>
              }
            </div>
            <footer className="p-ui-xs py-0 mb-ui-xs h-ui-bottom grid grid-cols-[1fr_auto_auto]">
              <ConversationPanel className="min-w-0 max-w-2xl mr-ui-xs" />
              <UIModeToggle />
              <div className="relative w-ui-minimap h-ui-bottom bracket-left bracket-offset-0 bracket-1 bracket-input">
                <motion.div
                  className="absolute inset-0 h-full w-ui-minimap"
                  animate={uiMode === "tasks" ? { opacity: 1, y: 0 } : { opacity: 0, y: -100 }}
                  initial={false}
                  style={{
                    pointerEvents: uiMode === "tasks" ? "auto" : "none",
                    contentVisibility: uiMode === "tasks" ? "visible" : "hidden",
                  }}
                  {...(uiMode !== "tasks" ? { inert: true } : {})}
                >
                  <MiniMapPanel className="w-ui-minimap" />
                </motion.div>
                <motion.div
                  className="absolute inset-0 h-full w-ui-minimap"
                  animate={uiMode !== "tasks" ? { opacity: 1, y: 0 } : { opacity: 0, y: 100 }}
                  initial={false}
                  style={{
                    pointerEvents: uiMode !== "tasks" ? "auto" : "none",
                    contentVisibility: uiMode !== "tasks" ? "visible" : "hidden",
                  }}
                  {...(uiMode === "tasks" ? { inert: true } : {})}
                >
                  <MiniTaskEngines />
                </motion.div>
                {uiState === "combat" && (
                  <div className="animate-in fade-in-0 duration-1000 absolute inset-px z-2 bg-background/60 cross-lines-subtle text-destructive-foreground flex flex-col items-center justify-center">
                    <div className="relative z-10 bg-destructive-background/70 text-center px-ui-sm py-ui-xs">
                      <WarningDiamondIcon
                        size={32}
                        className="text-destructive mx-auto mb-1"
                        weight="duotone"
                      />
                      <span className="text-xs uppercase font-bold mx-auto">Combat engaged</span>
                    </div>
                  </div>
                )}
              </div>
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
      <Disconnect />

      {/* Other Renderables */}
      <Starfield />
      <SectorTitleBanner />
      <ToastContainer />
      <HighlightOverlay />
      <PipecatClientAudio />
    </>
  )
}

export default Game
