import {
  CargoIcon,
  CreditsIcon,
  FighterIcon,
  FuelIcon,
  ShieldIcon,
  TurnsPerWarpIcon,
} from "@/icons"
import useGameStore from "@/stores/game"
import { formatCurrency } from "@/utils/formatting"

import { DottedTitle } from "../DottedTitle"
import { Badge } from "../primitives/Badge"
import { Button } from "../primitives/Button"
import { Tooltip, TooltipContent, TooltipTrigger } from "../primitives/ToolTip"

import { SHIP_DEFINITIONS } from "@/types/ships"

export const ShipCatalogue = () => {
  const setActiveScreen = useGameStore.use.setActiveScreen?.()

  const orderedShipDefinitions = SHIP_DEFINITIONS.sort(
    (a, b) => a.purchase_price - b.purchase_price
  )
    .filter((ship) => ship.purchase_price > 0)
    .map((ship) => ({
      ...ship,
      stats: JSON.parse(ship.stats),
    }))

  return (
    <div className="flex flex-col gap-ui-sm uppercase">
      <DottedTitle title="Ship Catalog" />
      {orderedShipDefinitions.map((ship) => (
        <div
          key={ship.idx}
          className="flex flex-row gap-ui-sm pb-ui-sm border-b border-accent justify-between"
        >
          <div className="flex flex-col gap-1.5 flex-1">
            <h4 className="text-xs font-bold flex flex-col @md/aside:flex-row @md/aside:items-center gap-0.5 @md/aside:gap-2">
              {ship.display_name} <span className="text-xxs text-accent">{ship.stats.role}</span>
            </h4>
            <ul className="flex flex-row flex-wrap gap-x-3 @md/aside:gap-x-4 gap-y-1 list-none text-subtle-foreground">
              <Tooltip>
                <TooltipTrigger asChild>
                  <li className="flex flex-row gap-0.5 items-center">
                    <FuelIcon weight="duotone" size={16} className="size-4" />
                    <span className="text-xs">{ship.warp_power_capacity}</span>
                  </li>
                </TooltipTrigger>
                <TooltipContent>Warp power capacity</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <li className="flex flex-row gap-0.5 items-center">
                    <ShieldIcon weight="duotone" size={16} className="size-4" />
                    <span className="text-xs">{ship.warp_power_capacity}</span>
                  </li>
                </TooltipTrigger>
                <TooltipContent>Shields</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <li className="flex flex-row gap-0.5 items-center">
                    <FighterIcon weight="duotone" size={16} className="size-4" />
                    <span className="text-xs">{ship.warp_power_capacity}</span>
                  </li>
                </TooltipTrigger>
                <TooltipContent>Fighters</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <li className="flex flex-row gap-0.5 items-center">
                    <TurnsPerWarpIcon weight="duotone" size={16} className="size-4" />
                    <span className="text-xs">{ship.warp_power_capacity}</span>
                  </li>
                </TooltipTrigger>
                <TooltipContent>Turns per warp</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <li className="flex flex-row gap-0.5 items-center">
                    <CargoIcon weight="duotone" size={16} className="size-4" />
                    <span className="text-xs">{ship.cargo_holds}</span>
                  </li>
                </TooltipTrigger>
                <TooltipContent>Cargo holds</TooltipContent>
              </Tooltip>
            </ul>
          </div>
          <div className="pr-1.5 flex flex-row gap-1 @md/aside:gap-ui-sm self-center">
            <Badge
              variant="ghost"
              size="sm"
              border="elbow"
              className="flex-1 self-stretch w-18 elbow-offset-0"
            >
              <CreditsIcon weight="duotone" className="size-4" />
              <span className="text-xs">{formatCurrency(ship.purchase_price)}</span>
            </Badge>
            <Button
              size="sm"
              variant="ghost"
              className="bg-accent-background/50 text-foreground hover:bg-accent-background"
              onClick={() => setActiveScreen("ship-details", { ...ship })}
            >
              View
            </Button>
          </div>
        </div>
      ))}
    </div>
  )
}
