import { CheckIcon } from "@phosphor-icons/react"
import { type ColumnDef } from "@tanstack/react-table"

import { DataTable } from "@/components/DataTable"
import useGameStore from "@/stores/game"
import { formatDate, formatTimeAgoOrDate } from "@/utils/date"
import { cn } from "@/utils/tailwind"

import { Card, CardContent } from "../primitives/Card"

const columns: ColumnDef<MovementHistory>[] = [
  {
    accessorKey: "timestamp",
    header: "Arrival",
    size: 9999, // Flexible - takes remaining space
    cell: ({ getValue }) => formatDate(getValue() as string),
  },
  { accessorKey: "from", header: "From" },
  { accessorKey: "to", header: "To" },
  {
    accessorKey: "port",
    header: "Port",
    cell: ({ getValue }) =>
      getValue() ? <CheckIcon size={16} className="mx-auto text-fuel" /> : null,
  },
  {
    accessorKey: "last_visited",
    header: "Previous Visit",
    cell: ({ getValue }) => {
      const value = getValue() as string | null
      return value ? formatTimeAgoOrDate(value) : "Discovered"
    },
  },
]

export const MovementHistoryPanel = ({ className }: { className?: string }) => {
  const movementHistory = useGameStore((state) => state.movement_history)

  return (
    <Card className={cn("flex h-full bg-black", className)} size="none">
      <CardContent className="flex flex-col h-full min-h-0 gap-2 relative overflow-hidden">
        <DataTable data={movementHistory} columns={columns} striped fixedLayout={false} />
      </CardContent>
    </Card>
  )
}
