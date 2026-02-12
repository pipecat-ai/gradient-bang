import { useRef } from "react"

import { AnimatePresence, motion } from "motion/react"
import { ArrowLeftIcon } from "@phosphor-icons/react"

import { LogsPanel } from "@/components/panels/LogsPanel"
import { PlayerPanel } from "@/components/panels/PlayerPanel"
import { SectorPanel } from "@/components/panels/SectorPanel"
import { TaskPanel } from "@/components/panels/TaskPanel"
import { TaskStreamPanel } from "@/components/panels/TaskStreamPanel"
import { TradePanel } from "@/components/panels/TradePanel"
import { Button } from "@/components/primitives/Button"
import { ScrollArea } from "@/components/primitives/ScrollArea"
import useGameStore from "@/stores/game"
import { cn } from "@/utils/tailwind"

export const RHSSubPanel = ({
  children,
  headerContent,
}: {
  children: React.ReactNode
  headerContent?: React.ReactNode
}) => {
  const activeSubPanel = useGameStore.use.activeSubPanel?.()
  const setActiveSubPanel = useGameStore.use.setActiveSubPanel?.()
  const panelRef = useRef<HTMLDivElement>(null)

  return (
    <AnimatePresence>
      {activeSubPanel && (
        <motion.div
          key="sub-panel"
          ref={panelRef}
          tabIndex={-1}
          initial={{ x: "100%" }}
          animate={{ x: 0 }}
          exit={{ x: "100%" }}
          transition={{ ease: "easeInOut", duration: 0.2 }}
          onAnimationComplete={(definition) => {
            if (definition === "animate") panelRef.current?.focus()
          }}
          className="h-full bg-background absolute z-50 left-6 right-0 inset-y-0 outline-none pointer-events-auto"
        >
          <div className="w-full h-full bg-card border-l text-foreground overflow-hidden">
            <header className="p-ui-xs flex flex-row gap-ui-xs items-center justify-between">
              <Button variant="link" onClick={() => setActiveSubPanel(undefined)} size="sm">
                <ArrowLeftIcon size={16} weight="bold" />
                Go Back
              </Button>
              {headerContent}
            </header>
            <ScrollArea className="p-ui-xs w-full h-full pointer-events-auto *:pb-24">
              {children}
            </ScrollArea>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export const RHSPanelContent = ({
  children,
  className,
  noScroll = false,
}: {
  children: React.ReactNode
  className?: string
  /** When true, fills the container without wrapping in a ScrollArea. Use for panels that manage their own scrolling. */
  noScroll?: boolean
}) => {
  if (noScroll) {
    return (
      <div className={cn("flex flex-col w-full h-full min-h-0", className)}>{children}</div>
    )
  }

  return (
    <ScrollArea className="w-full h-full">
      <div className={cn("flex flex-col gap-ui-sm w-full pb-12", className)}>{children}</div>
    </ScrollArea>
  )
}

export const RHSPanelContainer = () => {
  const activePanel = useGameStore.use.activePanel?.()
  const activeSubPanel = useGameStore.use.activeSubPanel?.()
  const setActiveSubPanel = useGameStore.use.setActiveSubPanel?.()

  return (
    <div
      className="relative flex-1 w-full min-h-0 text-background dither-mask-md bg-background/40 border-t border-l"
      id="panel-container"
    >
      {activePanel !== "task_stream" && (
        <div className="absolute inset-0 bottom-0 z-10 dither-mask-sm dither-mask-invert pointer-events-none" />
      )}

      <div
        className={cn(
          "w-full h-full pointer-events-auto text-foreground overflow-hidden",
          activeSubPanel && "pointer-events-none"
        )}
      >
        {activePanel === "logs" && <LogsPanel />}
        {activePanel === "sector" && <SectorPanel />}
        {activePanel === "player" && <PlayerPanel />}
        {activePanel === "trade" && <TradePanel />}
        {activePanel === "tasks" && <TaskPanel />}
        {activePanel === "corp" && <div className=""></div>}
        {activePanel === "task_stream" && <TaskStreamPanel />}
      </div>
      <div
        className={cn("absolute inset-0 bg-background/50 z-8", activeSubPanel ? "block" : "hidden")}
        onClick={() => setActiveSubPanel(undefined)}
      ></div>
    </div>
  )
}
