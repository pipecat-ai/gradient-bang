import { SlidersHorizontalIcon, SpeakerHighIcon, UserIcon } from "@phosphor-icons/react"

import useGameStore from "@/stores/game"
import { formatCurrency } from "@/utils/formatting"

import { Badge } from "./primitives/Badge"
import { Button } from "./primitives/Button"
import { DotDivider } from "./primitives/DotDivider"

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
  const player = useGameStore.use.player()
  const ship = useGameStore.use.ship()
  const corporation = useGameStore.use.corporation?.()

  return (
    <header className="bg-subtle-background border-b p-1.5 flex flex-row items-center">
      <div className="text-xs uppercase">
        <Badge variant="secondary" size="sm" border="bracket" className="h-8 bracket-size-8 px-2">
          <UserIcon weight="duotone" size={16} />
          {player?.name ?
            <span className="text-white">{player.name}</span>
          : <span className="text-subtle-foreground">---</span>}
        </Badge>
      </div>
      <div className="flex-1 flex flex-row gap-3 text-sm items-center justify-center">
        <TopBarTextItem
          label="Credits in Bank"
          value={player?.credits_in_bank ? formatCurrency(player.credits_in_bank) : undefined}
        />
        <TopBarTextItem
          label="on Hand"
          value={ship?.credits ? formatCurrency(ship.credits) : undefined}
        />
        {corporation && (
          <>
            <DotDivider />
            <TopBarTextItem label="Corp" value={corporation.name} />
          </>
        )}
      </div>
      <div className="flex flex-row gap-1.5">
        <Button variant="outline" size="icon-sm">
          <SpeakerHighIcon weight="bold" size={16} />
        </Button>

        <Button variant="outline" size="icon-sm" onClick={() => setActiveModal("settings")}>
          <SlidersHorizontalIcon weight="bold" size={16} />
        </Button>
      </div>
    </header>
  )
}
