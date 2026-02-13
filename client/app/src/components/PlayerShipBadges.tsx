import type { ReactNode } from "react"
import { DroneIcon, LightningIcon, ShieldIcon } from "@phosphor-icons/react"

import useGameStore from "@/stores/game"
import { cn } from "@/utils/tailwind"
import {
  type ColorThreshold,
  combatThresholds,
  fuelThresholds,
  getColorFromThresholds,
  type ProgressColor,
} from "@/utils/thresholds"

import { Badge } from "./primitives/Badge"
import { Progress } from "./primitives/Progress"

const incrementCx =
  "bg-success-background stripe-bar stripe-bar-success stripe-bar-8 stripe-bar-animate-1"
const decrementCx = "stripe-bar stripe-bar-8 stripe-bar-animate-1 stripe-bar-reverse"

interface StatBadgeProps {
  label: string
  value: number
  maxValue: number
  icon: ReactNode
  /** Color thresholds ordered from lowest to highest. Uses defaultColor if percentage exceeds all thresholds. */
  colorThresholds: ColorThreshold[]
  defaultColor: ProgressColor
  className?: string
}

const StatBadge = ({
  label,
  value,
  maxValue,
  icon,
  colorThresholds,
  defaultColor,
  className,
}: StatBadgeProps) => {
  const percentage = (value / maxValue) * 100

  const color = getColorFromThresholds(percentage, colorThresholds, defaultColor)

  const dCX = `${decrementCx} ${
    color === "destructive" ?
      "bg-destructive-background stripe-bar-destructive"
    : "bg-warning-background stripe-bar-warning"
  }`

  return (
    <Badge
      border="elbow"
      size="sm"
      variant="secondary"
      className={cn("elbow-offset-0 flex-col gap-1.5 items-start py-1.5 text-xs", className)}
    >
      <div className="flex flex-row gap-2 items-center justify-between w-full">
        <span className="text-xs font-bold leading-none">{label}</span>
        <div
          className={cn(
            "text-subtle-foreground leading-none",
            maxValue > 999 ? "text-xxs" : "text-xs"
          )}
        >
          {value}
          <span className="text-subtle/60 leading-none px-1">/</span>
          {maxValue}
        </div>
      </div>
      <div className="flex flex-row gap-2 items-center w-full">
        {icon}
        <Progress
          color={color}
          value={percentage}
          segmented={true}
          className="h-[16px]"
          classNames={{
            increment: incrementCx,
            decrement: dCX,
          }}
          segmentHoldMs={500}
        />
      </div>
    </Badge>
  )
}

export const PlayerFightersBadge = ({ className }: { className?: string }) => {
  const ship = useGameStore.use.ship()

  return (
    <StatBadge
      label="FGHT"
      value={ship.fighters ?? 0}
      maxValue={ship.max_fighters ?? 0}
      icon={<DroneIcon weight="duotone" size={16} className="size-5" />}
      colorThresholds={combatThresholds}
      defaultColor="terminal"
      className={className}
    />
  )
}

export const PlayerShieldsBadge = ({ className }: { className?: string }) => {
  const ship = useGameStore.use.ship()

  return (
    <StatBadge
      label="SHLD"
      value={ship.shields ?? 0}
      maxValue={ship.max_shields ?? 0}
      icon={<ShieldIcon weight="duotone" size={16} className="size-5" />}
      colorThresholds={combatThresholds}
      defaultColor="terminal"
      className={className}
    />
  )
}

export const PlayerShipFuelBadge = ({ className }: { className?: string }) => {
  const ship = useGameStore.use.ship()

  return (
    <StatBadge
      label="Fuel"
      value={ship.warp_power ?? 0}
      maxValue={ship.warp_power_capacity ?? 0}
      icon={<LightningIcon weight="duotone" size={16} className="size-5" />}
      colorThresholds={fuelThresholds}
      defaultColor="fuel"
      className={className}
    />
  )
}
