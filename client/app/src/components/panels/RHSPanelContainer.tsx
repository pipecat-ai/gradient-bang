import { PlayerPanel } from "@/components/panels/PlayerPanel"
import { ScrollArea } from "@/components/primitives/ScrollArea"
import useGameStore from "@/stores/game"
import { cn } from "@/utils/tailwind"

export const RHSPanelContent = ({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) => {
  return <div className={cn("flex flex-col gap-ui-sm p-ui-sm", className)}>{children}</div>
}
export const RHSPanelContainer = () => {
  const activePanel = useGameStore.use.activePanel?.()
  return (
    <div
      className="relative flex-1 w-full min-h-0 text-background dither-mask-md bg-background/20"
      id="panel-container"
    >
      <ScrollArea className="w-full h-full pointer-events-auto">
        {activePanel === "sector" && <div className=""></div>}
        {activePanel === "player" && <PlayerPanel />}
        {activePanel === "trade" && <div className=""></div>}
        {activePanel === "tasks" && <div className=""></div>}
        {activePanel === "corp" && <div className=""></div>}
        {activePanel === "logs" && <div className=""></div>}
      </ScrollArea>
    </div>
  )
}
