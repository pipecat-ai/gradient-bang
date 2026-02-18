import { useMemo } from "react"

import { BlankSlateTile } from "../BlankSlates"
import { DottedTitle } from "../DottedTitle"
import { PlayerActionDropdown } from "../PlayerActionDropdown"
import { DotDivider } from "../primitives/DotDivider"
import { ShipLogoPopover } from "../ShipLogoPopover"

import { PLAYER_TYPE_NAMES } from "@/types/constants"

const PlayerShipCard = ({ player }: { player: Player }) => {
  return (
    <li
      key={player.id}
      className="group py-ui-xs bg-subtle-background even:bg-subtle-background/50 flex flex-row items-center"
    >
      <div className="flex flex-row gap-ui-sm items-center px-ui-xs w-full">
        <ShipLogoPopover ship_type={player.ship?.ship_type} alt={player.ship?.ship_name} />
        <div className="w-0 grow flex flex-row gap-ui-sm items-center">
          <div className="w-0 grow overflow-hidden flex flex-col gap-0.5 border-l border-accent px-ui-xs uppercase">
            <h3 className="text-sm font-bold truncate">{player.name}</h3>
            <span className="flex gap-1.5 items-center text-xxs text-subtle-foreground min-w-0">
              <span className="truncate shrink">{player.ship?.ship_name}</span>
              <DotDivider className="shrink-0" />
              <span
                className={
                  "truncate shrink text-xxs " +
                  (player.corporation?.name ? "text-subtle-foreground" : "text-accent")
                }
              >
                {player.corporation?.name ?? "No Corp"}
              </span>
            </span>
          </div>
          <div className="opacity-0 group-hover:opacity-100 has-data-[state=open]:opacity-100 shrink-0">
            <PlayerActionDropdown player={player} />
          </div>
        </div>
      </div>
    </li>
  )
}

export const SectorShipSubPanel = ({ sector, filter }: { sector?: Sector; filter: PlayerType }) => {
  const filteredPlayers = useMemo(() => {
    return sector?.players?.filter((player) => player.player_type === filter)
  }, [sector?.players, filter])

  return (
    <aside className="flex flex-col gap-ui-sm">
      <DottedTitle title={`${PLAYER_TYPE_NAMES[filter as PlayerType]}s in sector`} />
      {filteredPlayers && filteredPlayers?.length > 0 ?
        <ul className="list-none p-0 m-0">
          {sector?.players
            ?.filter((player) => player.player_type === filter)
            .map((player) => (
              <PlayerShipCard key={player.id} player={player} />
            ))}
        </ul>
      : <BlankSlateTile text="No ships in sector" />}
    </aside>
  )
}
