import { PackageIcon } from "@phosphor-icons/react"

import { useGameContext } from "@/hooks/useGameContext"

import { BlankSlateTile } from "../BlankSlates"
import { DottedTitle } from "../DottedTitle"
import { Button } from "../primitives/Button"
import { DotDivider } from "../primitives/DotDivider"

import { RESOURCE_SHORT_NAMES } from "@/types/constants"

const CargoSummary = ({ cargo }: { cargo: Record<Resource, number> }) => {
  const totalCargo = Object.values(cargo).reduce((sum, v) => sum + v, 0)
  if (totalCargo === 0) return <span className="text-subtle">Empty</span>

  return (
    <span className="flex gap-1.5 items-center flex-wrap">
      {(Object.entries(cargo) as [Resource, number][])
        .filter(([, v]) => v > 0)
        .map(([resource, amount], i, arr) => (
          <span key={resource} className="inline-flex items-center gap-0.5">
            <span className="text-accent-foreground font-bold">{amount}</span>
            <span>{RESOURCE_SHORT_NAMES[resource]}</span>
            {i < arr.length - 1 && <DotDivider className="ml-1" />}
          </span>
        ))}
    </span>
  )
}

const UnownedShipCard = ({ ship }: { ship: ShipUnowned }) => {
  const { sendUserTextInput } = useGameContext()

  return (
    <li className="group py-ui-xs bg-subtle-background even:bg-subtle-background/50 flex flex-row items-center">
      <div className="flex flex-row gap-ui-sm items-center px-ui-xs w-full">
        <div className="bg-accent-background p-ui-xs flex items-center justify-center border border-accent shrink-0">
          <PackageIcon size={16} weight="duotone" className="text-subtle" />
        </div>
        <div className="w-0 grow flex flex-row gap-ui-sm items-center">
          <div className="w-0 grow overflow-hidden flex flex-col gap-0.5 border-l border-accent px-ui-xs uppercase">
            <h3 className="text-sm font-bold truncate">{ship.ship_name}</h3>
            <span className="flex gap-1.5 items-center text-xxs text-subtle-foreground min-w-0">
              <span className="truncate shrink">{ship.ship_type}</span>
              <DotDivider className="shrink-0" />
              <span className="truncate shrink">Ex: {ship.former_owner_name}</span>
            </span>
            <span className="flex gap-1.5 items-center text-xxs text-subtle-foreground min-w-0">
              <CargoSummary cargo={ship.cargo} />
            </span>
          </div>
          <div className="opacity-0 group-hover:opacity-100 shrink-0">
            <Button
              variant="ui"
              size="sm"
              onClick={() => {
                sendUserTextInput(`collect unowned ship id ${ship.ship_id} in sector`)
              }}
            >
              Collect
            </Button>
          </div>
        </div>
      </div>
    </li>
  )
}

export const SectorUnownedSubPanel = ({ sector }: { sector?: Sector }) => {
  const unownedShips = sector?.unowned_ships

  return (
    <aside className="flex flex-col gap-ui-sm">
      <DottedTitle title="Unowned ships in sector" />
      {unownedShips && unownedShips.length > 0 ?
        <ul className="list-none p-0 m-0">
          {unownedShips.map((ship) => (
            <UnownedShipCard key={ship.ship_id} ship={ship} />
          ))}
        </ul>
      : <BlankSlateTile text="No unowned ships in sector" />}
    </aside>
  )
}
