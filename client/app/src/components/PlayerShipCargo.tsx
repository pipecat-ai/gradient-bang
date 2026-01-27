import { CreditsIcon } from "@/icons"
import useGameStore from "@/stores/game"
import { cargoThresholds, getColorFromThresholds } from "@/utils/thresholds"

import { LabelValueText } from "./Label"
import { NumericalBadge } from "./NumericalBadge"
import { Badge } from "./primitives/Badge"
import { Button } from "./primitives/Button"
import { Divider } from "./primitives/Divider"
import { DotDivider } from "./primitives/DotDivider"
import { Progress } from "./primitives/Progress"
import { ResourceTitle } from "./ResourceTitle"

const decrementCx =
  "bg-terminal-background stripe-bar stripe-bar-terminal stripe-bar-8 stripe-bar-animate-1 stripe-bar-reverse"

export const PlayerShipCargo = () => {
  const ship = useGameStore.use.ship()

  const cargoCapacity = ship?.cargo_capacity ?? 100
  const emptyHolds = ship?.empty_holds ?? cargoCapacity
  const emptyHoldsPercentage = (emptyHolds / cargoCapacity) * 100

  const color = getColorFromThresholds(emptyHoldsPercentage, cargoThresholds, "terminal")

  const incrementCx =
    color === "destructive" ?
      "bg-destructive-background stripe-bar stripe-bar-destructive stripe-bar-8 stripe-bar-animate-1"
    : color === "warning" ?
      "bg-warning-background stripe-bar stripe-bar-warning stripe-bar-8 stripe-bar-animate-1"
    : "bg-terminal-background stripe-bar stripe-bar-terminal stripe-bar-8 stripe-bar-animate-1"

  return (
    <div className="border-l border-b bg-background p-ui-sm select-none">
      <div className="flex flex-col gap-ui-sm">
        <Badge variant="ghost" border="bracket" className="flex-1 w-full flex flex-col gap-2">
          <LabelValueText
            label="Hold Capacity"
            value={emptyHolds.toString()}
            maxValue={cargoCapacity.toString()}
            highlightValue={true}
          />
          <Progress
            value={100 - emptyHoldsPercentage}
            color={color}
            className="h-[20px]"
            segmented={true}
            segmentHoldMs={500}
            classNames={{
              increment: incrementCx,
              decrement: decrementCx,
            }}
          />
        </Badge>
        <Divider variant="dashed" color="accent" className="h-[2px]" />
        <div className="flex flex-row gap-1 items-center">
          <ResourceTitle
            resource="quantum_foam"
            className="flex-1"
            value={ship?.cargo?.quantum_foam}
          />
          <DotDivider />
          <ResourceTitle
            resource="retro_organics"
            className="flex-1"
            value={ship?.cargo?.retro_organics}
          />
          <DotDivider />
          <ResourceTitle
            resource="neuro_symbolics"
            className="flex-1"
            value={ship?.cargo?.neuro_symbolics}
          />
        </div>
        <Divider variant="dashed" color="accent" className="h-[8px]" />
        <div className="flex flex-row gap-ui-xs items-stretch">
          <NumericalBadge
            value={ship?.credits}
            label="credits on hand"
            variant="secondary"
            border="bracket"
            className="p-ui-xs flex-1"
            formatAsCurrency={true}
            classNames={{
              value: "text-sm",
            }}
          >
            <CreditsIcon weight="duotone" className="size-4" size={20} />
          </NumericalBadge>
          <div className="border-l pl-ui-xs flex flex-col gap-1">
            <Button variant="outline" size="sm" className="flex-1 text-xxs" disabled>
              Deposit to bank
            </Button>
            <Button variant="outline" size="sm" className="flex-1 text-xxs" disabled>
              Withdraw from bank
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
