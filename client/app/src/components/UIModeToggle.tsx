import { ArrowsDownUpIcon } from "@phosphor-icons/react"

import useAudioStore from "@/stores/audio"
import useGameStore from "@/stores/game"

import { Button } from "./primitives/Button"
import { Tooltip, TooltipContent, TooltipTrigger } from "./primitives/ToolTip"

export const UIModeToggle = () => {
  const uiMode = useGameStore.use.uiMode()
  const setUIMode = useGameStore.use.setUIMode()
  const playSound = useAudioStore.use.playSound()

  const handleClick = () => {
    playSound("chime4")
    setUIMode(uiMode === "tasks" ? "map" : "tasks")
  }

  return (
    <div className="absolute -top-10 right-0 left-0 z-20">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="secondary"
            size="icon"
            onClick={handleClick}
            className="w-full bg-background"
          >
            <ArrowsDownUpIcon className="size-5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Expand {uiMode === "tasks" ? "Map" : "Task Engines"}</TooltipContent>
      </Tooltip>
    </div>
  )
}
