import { DotsThreeIcon } from "@phosphor-icons/react"

import { useGameContext } from "@/hooks/useGameContext"

import { Button } from "./primitives/Button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./primitives/DropdownMenu"

export const PlayerActionDropdown = ({ player }: { player: Player }) => {
  const { sendUserTextInput } = useGameContext()
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="ui" size="icon-sm">
          <DotsThreeIcon size={16} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onClick={() => {
            sendUserTextInput(`engage combat with player with name ${player.name} in this sector`)
          }}
        >
          Engage in combat
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
