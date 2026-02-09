import { CargoIcon, FighterIcon, FuelIcon, ShieldIcon, TurnsPerWarpIcon } from "@/icons"

import { Badge } from "./primitives/Badge"
import { PopoverTitle } from "./primitives/Popover"

import { SHIP_DEFINITIONS } from "@/types/ships"

const ShipDetailsItem = ({
  label,
  icon,
  value,
}: {
  label: string
  icon: React.ReactNode
  value: React.ReactNode
}) => (
  <div className="flex flex-row items-center text-xxs">
    <Badge
      size="sm"
      className="flex flex-row gap-1 items-center justify-between text-center flex-1"
    >
      {icon}
      {label}
      <span className="flex-1 text-terminal-foreground text-right">{value}</span>
    </Badge>
  </div>
)

export const ShipDetailsCallout = ({ ship_type }: { ship_type: string }) => {
  const shipDefinition = SHIP_DEFINITIONS.find(
    (s) => s.ship_type === ship_type
  ) as unknown as ShipDefinition
  return (
    <div className="uppercase">
      <PopoverTitle className="mb-ui-sm">{shipDefinition?.display_name}</PopoverTitle>
      <ul className="flex flex-col gap-1 list-none">
        <ShipDetailsItem
          label="Shields"
          icon={<ShieldIcon weight="duotone" className="size-5" />}
          value={shipDefinition.cargo_holds}
        />
        <ShipDetailsItem
          label="Fighters"
          icon={<FighterIcon weight="duotone" className="size-5" />}
          value={shipDefinition.fighters}
        />
        <ShipDetailsItem
          label="Turns per warp"
          icon={<TurnsPerWarpIcon weight="duotone" className="size-5" />}
          value={shipDefinition.turns_per_warp}
        />
        <ShipDetailsItem
          label="Warp Fuel Capacity"
          icon={<FuelIcon weight="duotone" className="size-5" />}
          value={shipDefinition.warp_power_capacity}
        />
        <ShipDetailsItem
          label="Cargo Holds"
          icon={<CargoIcon weight="duotone" className="size-5" />}
          value={shipDefinition.cargo_holds}
        />
      </ul>
    </div>
  )
}
