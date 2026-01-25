import type { ComponentProps, ReactNode } from "react"
import { DroneIcon, LightningIcon, ShieldIcon } from "@phosphor-icons/react"

import useGameStore from "@/stores/game"
import { cn } from "@/utils/tailwind"

import { Badge } from "./primitives/Badge"
import { Progress } from "./primitives/Progress"

const incrementCx =
  "bg-success-background stripe-bar stripe-bar-success stripe-bar-8 stripe-bar-animate-1"
const decrementCx = "stripe-bar stripe-bar-8 stripe-bar-animate-1 stripe-bar-reverse"

type ProgressColor = ComponentProps<typeof Progress>["color"]

interface ColorThreshold {
  threshold: number
  color: ProgressColor
}

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

  const color = colorThresholds.find((t) => percentage <= t.threshold)?.color ?? defaultColor

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
      className={cn("flex-col gap-1.5 items-start py-1.5 text-xs", className)}
    >
      <div className="flex flex-row gap-2 items-center justify-between w-full">
        <span className="text-xs font-bold leading-none">{label}</span>
        <div className="text-xs text-subtle-foreground leading-none">
          {value}
          <span className="text-subtle/60 leading-none"> / </span>
          {maxValue}
        </div>
      </div>
      <div className="flex flex-row gap-2 items-center w-full">
        {icon}
        <Progress
          color={color}
          value={percentage}
          segmented={true}
          className="h-[16px] w-full"
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

const combatThresholds: ColorThreshold[] = [
  { threshold: 15, color: "destructive" },
  { threshold: 25, color: "warning" },
]

const fuelThresholds: ColorThreshold[] = [
  { threshold: 25, color: "destructive" },
  { threshold: 50, color: "warning" },
]

export const PlayerFightersBadge = ({ className }: { className?: string }) => {
  const ship = useGameStore.use.ship()

  return (
    <StatBadge
      label="ATK"
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
      label="DEF"
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
