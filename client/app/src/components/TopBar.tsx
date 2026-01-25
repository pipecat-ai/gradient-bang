import { SlidersHorizontalIcon, SpeakerHighIcon, UserIcon } from "@phosphor-icons/react"

import useGameStore from "@/stores/game"

import { Badge } from "./primitives/Badge"
import { Button } from "./primitives/Button"

export const TopBar = () => {
  const setActiveModal = useGameStore.use.setActiveModal()
  const player = useGameStore.use.player()

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
      <div className="flex-1"></div>
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
