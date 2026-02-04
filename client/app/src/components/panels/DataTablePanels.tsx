import { useMemo } from "react"

import { CheckIcon } from "@phosphor-icons/react"
import { type ColumnDef } from "@tanstack/react-table"

import { DataTableScrollArea } from "@/components/DataTable"
import useGameStore from "@/stores/game"
import { formatDateTime24, formatTimeAgoOrDate } from "@/utils/date"
import { cn } from "@/utils/tailwind"

import { BlankSlateTile } from "../BlankSlates"
import { Card, CardContent } from "../primitives/Card"

const columns: ColumnDef<MovementHistory>[] = [
  {
    accessorKey: "timestamp",
    header: "Arrival",
    meta: { width: "25%" },
    cell: ({ getValue }) => formatDateTime24(getValue() as string),
  },
  { accessorKey: "from", header: "From", meta: { align: "center" } },
  { accessorKey: "to", header: "To", meta: { align: "center" } },
  {
    accessorKey: "port",
    header: "Port",
    meta: { align: "center" },
    cell: ({ getValue }) =>
      getValue() ? <CheckIcon size={16} className="mx-auto text-fuel" /> : null,
  },
  {
    accessorKey: "last_visited",
    header: "Last Visit",
    meta: { align: "center", width: "25%" },
    cell: ({ getValue }) => {
      const value = getValue() as string | null
      return value ? formatTimeAgoOrDate(value) : "Discovered"
    },
  },
]

export const MovementHistoryPanel = ({ className }: { className?: string }) => {
  const movementHistory = useGameStore((state) => state.movement_history)
  const reversedMovementHistory = useMemo(() => [...movementHistory].reverse(), [movementHistory])

  return (
    <Card className={cn("flex h-full bg-background", className)} size="none">
      <CardContent className="flex flex-col h-full min-h-0 gap-2 relative">
        <DataTableScrollArea
          data={reversedMovementHistory}
          columns={columns}
          striped
          className="text-background dither-mask-sm dither-mask-invert h-full"
        />
      </CardContent>
    </Card>
  )
}

const columnsSectorPlayerMovement: ColumnDef<LogEntry>[] = [
  {
    accessorKey: "meta.player.name",
    header: "Player",
    meta: { width: "40%" },
  },
  { accessorKey: "meta.ship.ship_name", header: "Ship" },
  {
    accessorKey: "meta.direction",
    header: "Direction",
    meta: { align: "center", width: 0 },
    cell: ({ getValue }) => {
      const direction = getValue() as string
      const isArrival = direction === "arrive"
      return (
        <span className={isArrival ? "text-terminal" : "text-muted-foreground"}>
          {isArrival ? "Arrive" : "Depart"}
        </span>
      )
    },
  },
]

export const SectorPlayerMovementPanel = ({ className }: { className?: string }) => {
  const activityLog = useGameStore((state) => state.activity_log)
  const sector = useGameStore((state) => state.sector)

  const movementLogs = useMemo(
    () =>
      activityLog
        .filter((entry) => entry.type === "character.moved" && entry.meta?.sector === sector?.id)
        .reverse(),
    [activityLog, sector?.id]
  )

  if (movementLogs.length <= 0) {
    return <BlankSlateTile text="No player movement data" />
  }

  return (
    <Card className={cn("flex h-full bg-background", className)} size="none">
      <CardContent className="flex flex-col h-full min-h-0 gap-2 relative px-0!">
        <DataTableScrollArea
          data={movementLogs}
          columns={columnsSectorPlayerMovement}
          getRowClassName={(row) =>
            row.meta?.direction === "arrive" ? "bg-accent-background" : "bg-subtle-background"
          }
          className="text-background h-full"
          classNames={{ table: "text-xxs" }}
        />
      </CardContent>
    </Card>
  )
}
