import { ScrollArea } from "@/components/primitives/ScrollArea"
import useGameStore from "@/stores/game"

export const RHSPanelContainer = () => {
  const activePanel = useGameStore.use.activePanel?.()
  return (
    <div
      className="relative flex-1 w-full min-h-0 text-background dither-mask-md bg-background/20 @sm/aside:hidden"
      id="panel-container"
    >
      <ScrollArea className="w-full h-full pointer-events-auto">
        {activePanel === "sector" && <div className="h-[2000px] text-white"></div>}
        {activePanel === "player" && <div className="h-[2000px] text-white"></div>}
        {activePanel === "trade" && <div className="h-[2000px] text-white"></div>}
        {activePanel === "tasks" && <div className="h-[2000px] text-white"></div>}
        {activePanel === "corp" && <div className="h-[2000px] text-white"></div>}
        {activePanel === "logs" && <div className="h-[2000px] text-white"></div>}
      </ScrollArea>
    </div>
  )
}
