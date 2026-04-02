import { FilmStripIcon, MedalIcon, SlidersHorizontalIcon } from "@phosphor-icons/react"

import { TopBarCreditBalance } from "@/components/TopBarCreditBalance"
import useGameStore from "@/stores/game"

import { CharacterBadge } from "./CharacterBadge"
import { Button } from "./primitives/Button"
import { DotDivider } from "./primitives/DotDivider"
import { Tooltip, TooltipContent, TooltipTrigger } from "./primitives/ToolTip"

export const TopBarTextItem = ({ label, value }: { label: string; value: string | undefined }) => {
  return (
    <div className="flex flex-row gap-1.5 text-xs uppercase ">
      <span className="text-subtle-foreground truncate">{label}</span>{" "}
      <span className="text-white font-semibold truncate">{value ?? "---"}</span>
    </div>
  )
}

export const TopBar = () => {
  const setActiveModal = useGameStore.use.setActiveModal()
  const corporation = useGameStore.use.corporation?.()
  const enableCapture = useGameStore((s) => s.settings.enableCapture)

  return (
    <header className="relative bg-subtle-background border-b flex flex-row items-center shadow-long z-50">
      <div className="text-xs uppercase p-1.5">
        <CharacterBadge />
      </div>
      <div className="flex-1" />
      <TopBarCreditBalance />
      {corporation && (
        <div className="flex flex-row gap-3 text-sm items-center">
          <DotDivider />
          <TopBarTextItem label="Corp" value={corporation.name} />
        </div>
      )}
      <div className="flex-1" />
      <div className="flex flex-row gap-1.5 p-1.5">
        {enableCapture && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon-sm"
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
            <Button variant="outline" size="icon-sm" onClick={() => setActiveModal("leaderboard")}>
              <MedalIcon weight="bold" size={16} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Leaderboard</p>
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" size="icon-sm" onClick={() => setActiveModal("settings")}>
              <SlidersHorizontalIcon weight="bold" size={16} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Settings</p>
          </TooltipContent>
        </Tooltip>
      </div>
    </header>
  )
}
