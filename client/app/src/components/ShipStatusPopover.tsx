/**
 * BYOA status popover for a corp ship card.
 *
 * Surfaces:
 *   - Online / offline state — placeholder; today this is derived from
 *     whether a task is actively running on the ship. Phase 3 will add
 *     a real presence signal for external BYOA operators.
 *   - BYOA mode — Private / Shared / Not BYOA (from `ship.byoa`).
 *   - Owner — BYOA owner name (when set).
 *   - Heartbeat — placeholder; today the server has
 *     `task_last_heartbeat_at` but it's not yet in the ship-list payload.
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
import { cn } from "@/utils/tailwind"

import { Badge } from "./primitives/Badge"
import { Button } from "./primitives/Button"

function modeLabel(mode: "private" | "shared" | null): string {
  if (mode === "private") return "BYOA · Private"
  if (mode === "shared") return "BYOA · Shared"
  return "Not BYOA"
}

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

export const ShipStatusPopover = ({ ship }: { ship: Ship }) => {
  const isBusy = !!ship.current_task_id
  // Placeholder: treat "task in flight" as "online" until Phase 3 adds a
  // real presence signal from the BYOA operator.
  const isOnline = isBusy
  const byoa = ship.byoa ?? null
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
            byoa && "text-terminal"
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
            label="Mode"
            value={modeLabel(byoa?.mode ?? null)}
            valueClassName={byoa ? "text-terminal" : "text-subtle-foreground"}
          />
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
              actor?.character_name ??
              actor?.character_id_prefix ?? <span className="text-subtle-foreground">—</span>
            }
          />
          <StatusRow
            label="Task"
            value={
              ship.current_task_id ?
                <span className="font-mono">
                  {ship.current_task_id.replace(/-/g, "").slice(0, 12)}
                </span>
              : <span className="text-subtle-foreground">—</span>
            }
          />
          <StatusRow
            label="Heartbeat"
            value={
              // Placeholder. task_last_heartbeat_at lives server-side but
              // is not yet in the ship-list payload. Phase 1/2 may surface
              // it; for now show a fixed dash so the layout is final.
              isBusy ?
                <span className="text-muted-foreground">just now</span>
              : <span className="text-subtle-foreground">—</span>
            }
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}
