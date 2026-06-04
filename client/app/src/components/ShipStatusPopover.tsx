/**
 * BYOA status popover for a corp ship card.
 *
 * Surfaces:
 *   - Online / offline state from BYOA process presence.
 *   - Owner — BYOA owner name (when set).
 *   - Heartbeat — last process heartbeat timestamp if one has arrived.
 *
 * Trigger is a small icon button on the ship card; mirrors PopoverHelper.
 */

import { BroadcastIcon } from "@phosphor-icons/react"

import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/primitives/Popover"
import type { ShipTaskOccupancy } from "@/stores/taskSlice"
import { cn } from "@/utils/tailwind"

import { Badge } from "./primitives/Badge"
import { Button } from "./primitives/Button"

function StatusRow({
  label,
  value,
  valueClassName = "",
}: {
  label: string
  value: React.ReactNode
  valueClassName?: string
}) {
  return (
    <div className="flex flex-row gap-2 items-center justify-between text-xs">
      <span className="uppercase text-subtle-foreground tracking-wide">{label}</span>
      <span className={cn("font-medium tabular-nums text-right", valueClassName)}>{value}</span>
    </div>
  )
}

export const ShipStatusPopover = ({
  ship,
  isActive,
  taskOccupancy,
}: {
  ship: Ship
  isActive?: boolean
  taskOccupancy?: ShipTaskOccupancy
}) => {
  const byoa = ship.byoa ?? null
  const isOnline = byoa?.presence?.online === true
  const actor = ship.current_task_actor ?? null

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Open BYOA status for ${ship.ship_name}`}
          className={cn(
            "p-0 size-5 text-subtle-foreground hover:text-terminal data-[state=open]:text-terminal",
            isActive && "text-terminal"
          )}
        >
          <BroadcastIcon weight="duotone" className="size-3.5 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64">
        <PopoverHeader>
          <PopoverTitle className="uppercase text-xs tracking-wide flex flex-row gap-2 items-center justify-between">
            <span>BYOA status</span>
            <Badge
              variant={isOnline ? "success" : "secondary"}
              border="bracket"
              size="sm"
              className="font-semibold"
            >
              {isOnline ? "Online" : "Offline"}
            </Badge>
          </PopoverTitle>
        </PopoverHeader>
        <div className="flex flex-col gap-1.5">
          <StatusRow
            label="Owner"
            value={
              byoa?.owner_character_name ??
              byoa?.owner_character_id_prefix ?? <span className="text-subtle-foreground">—</span>
            }
          />
          <StatusRow
            label="Active actor"
            value={
              taskOccupancy?.actor_name ??
              actor?.character_name ??
              actor?.character_id_prefix ?? <span className="text-subtle-foreground">—</span>
            }
          />
          <StatusRow
            label="Task"
            value={
              taskOccupancy?.task_id ?
                <span className="font-mono">
                  {taskOccupancy.task_id.replace(/-/g, "").slice(0, 12)}
                </span>
              : <span className="text-subtle-foreground">—</span>
            }
          />
          <StatusRow
            label="Heartbeat"
            value={
              byoa?.presence?.last_seen_at ?
                <span className="text-muted-foreground">
                  {new Date(byoa.presence.last_seen_at).toLocaleTimeString()}
                </span>
              : <span className="text-subtle-foreground">—</span>
            }
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}
