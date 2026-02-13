import { ArrowsDownUpIcon, SphereIcon } from "@phosphor-icons/react"

import useAudioStore from "@/stores/audio"
import useGameStore from "@/stores/game"

import { Button } from "./primitives/Button"
import { Tooltip, TooltipContent, TooltipTrigger } from "./primitives/ToolTip"

export const UIModeToggle = () => {
  const uiMode = useGameStore.use.uiMode()
  const setUIMode = useGameStore.use.setUIMode()
  const setLookMode = useGameStore.use.setLookMode?.()

  const playSound = useAudioStore.use.playSound()

  const handleClick = () => {
    playSound("chime4")
    setUIMode(uiMode === "tasks" ? "map" : "tasks")
  }

  return (
    <div className="flex flex-col z-20 -mr-2 -mt-2 outline-2 outline-offset-0 outline-background bracket bracket-offset-3 bracket-1 bracket-input h-fit divide-y divide-border">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="bland"
            size="icon-sm"
            onClick={handleClick}
            className="shrink-0 bg-subtle-background focus-visible:outline-0 hover:text-terminal hover:bg-accent-background focus-visible:bg-background"
          >
            <ArrowsDownUpIcon className="size-5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left">
          Expand {uiMode === "tasks" ? "Map" : "Task Engines"}
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="bland"
            size="icon-sm"
            onClick={() => setLookMode(true)}
            className="shrink-0 bg-subtle-background focus-visible:outline-0 hover:text-terminal hover:bg-accent-background focus-visible:bg-background"
          >
            <SphereIcon size={20} className="size-5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left">Look around</TooltipContent>
      </Tooltip>
    </div>
  )
}
