import { useMemo } from "react"

import { CheckIcon } from "@phosphor-icons/react"
import { type ColumnDef } from "@tanstack/react-table"

import { DataTableScrollArea } from "@/components/DataTable"
import useGameStore from "@/stores/game"
import { formatDateTime24, formatTimeAgoOrDate } from "@/utils/date"
import { cn } from "@/utils/tailwind"

import { Card, CardContent } from "../primitives/Card"

const columns: ColumnDef<MovementHistory>[] = [
  {
    accessorKey: "timestamp",
    header: "Arrival",
    cell: ({ getValue }) => formatDateTime24(getValue() as string),
  },
  { accessorKey: "from", header: "From", size: 55, meta: { align: "center" } },
  { accessorKey: "to", header: "To", size: 55, meta: { align: "center" } },
  {
    accessorKey: "port",
    header: "Port",
    size: 40,
    meta: { align: "center" },
    cell: ({ getValue }) =>
      getValue() ? <CheckIcon size={16} className="mx-auto text-fuel" /> : null,
  },
  {
    accessorKey: "last_visited",
    header: "Last Visit",
    size: 125,
    meta: { align: "center" },
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
