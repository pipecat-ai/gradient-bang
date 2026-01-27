import type { Story } from "@ladle/react"
import { CheckIcon } from "@phosphor-icons/react"
import { type ColumnDef } from "@tanstack/react-table"

import { DataTable } from "@/components/DataTable"
import useGameStore from "@/stores/game"
import { formatDate, formatTimeAgoOrDate } from "@/utils/date"

const columns: ColumnDef<MovementHistory>[] = [
  {
    accessorKey: "timestamp",
    header: "Arrival",
    cell: ({ getValue }) => formatDate(getValue() as string),
    // No size = flexible width
  },
  { accessorKey: "from", header: "From", size: 100 },
  { accessorKey: "to", header: "To", size: 100 },
  {
    accessorKey: "port",
    header: "Port",
    size: 60,
    cell: ({ getValue }) =>
      getValue() ? <CheckIcon size={16} className="mx-auto text-fuel" /> : null,
  },
  {
    accessorKey: "last_visited",
    header: "Previous Visit",
    size: 120,
    cell: ({ getValue }) => {
      const value = getValue() as string | null
      return value ? formatTimeAgoOrDate(value) : "Discovered"
    },
  },
]

export const DataTableStory: Story = () => {
  const movementHistory = useGameStore((state) => state.movement_history)

  return (
    <div className="h-screen flex flex-col bg-background">
      {/* Top bar */}
      <header className="shrink-0 border-b px-4 py-3">
        <div className="text-sm font-medium text-foreground">Movement History</div>
      </header>

      {/* Content row */}
      <div className="flex-1 min-h-0 flex">
        {/* Main */}
        <main className="flex-1 min-w-0 min-h-0 p-3 flex">
          {/* Panel */}
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden border bg-background">
            {/* DataTable */}
            <DataTable data={movementHistory} columns={columns} striped />

            {/* Panel footer */}
            <div className="shrink-0 border-t px-4 py-3 text-xs text-muted-foreground">
              {movementHistory.length} records
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}

DataTableStory.meta = {
  useDevTools: true,
  useChatControls: false,
  disconnectedStory: true,
  enableMic: false,
  disableAudioOutput: true,
}
