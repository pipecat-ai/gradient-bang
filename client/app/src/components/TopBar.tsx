import { FilmStripIcon, MedalIcon, SlidersHorizontalIcon } from "@phosphor-icons/react"

import { TopBarCreditBalance } from "@/components/TopBarCreditBalance"
import { TopBarDisconnectButton } from "@/components/TopBarDisconnectButton"
import useGameStore from "@/stores/game"
import { cn } from "@/utils/tailwind"

import { CharacterBadge } from "./CharacterBadge"
import { Button } from "./primitives/Button"
import { DotDivider } from "./primitives/DotDivider"
import { Tooltip, TooltipContent, TooltipTrigger } from "./primitives/ToolTip"

export const TopBarTextItem = ({
  label,
  value,
  className,
}: {
  label?: string
  value: string | undefined
  className?: string
}) => {
  return (
    <div className={cn("flex flex-row gap-1.5 text-xs uppercase min-w-0", className)}>
      {label && <span className="text-subtle-foreground truncate">{label + " "}</span>}
      <span className="text-white font-semibold truncate min-w-0">{value ?? "---"}</span>
    </div>
  )
}

export const TopBar = () => {
  const setActiveModal = useGameStore.use.setActiveModal()
  const corporation = useGameStore.use.corporation?.()
  const enableCapture = useGameStore((s) => s.settings.enableCapture)

  return (
    <header className="relative bg-subtle-background border-b flex flex-row items-center gap-ui-sm shadow-long z-50">
      <div className="flex-1 min-w-0 text-xs uppercase p-1.5 flex flex-row items-center gap-3">
        <div className="shrink-0">
          <CharacterBadge />
        </div>
        {corporation && <TopBarTextItem value={corporation.name} />}
      </div>
      <div className="relative h-full shrink-0 w-56">
        <TopBarCreditBalance />
      </div>
      <div className="flex-1 flex flex-row justify-end gap-1.5 p-1.5 items-center">
        {enableCapture && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Save replay"
                onClick={() => setActiveModal("social_replay")}
              >
                <FilmStripIcon weight="bold" size={16} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Clip That!</p>
            </TooltipContent>
          </Tooltip>
        )}

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Open leaderboard"
              onClick={() => setActiveModal("leaderboard")}
            >
              <MedalIcon weight="bold" size={16} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Leaderboard</p>
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Open settings"
              onClick={() => setActiveModal("settings")}
            >
              <SlidersHorizontalIcon weight="bold" size={16} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Settings</p>
          </TooltipContent>
        </Tooltip>

        <DotDivider />
        <TopBarDisconnectButton />
      </div>
    </header>
  )
}
