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

type CombatRoundTableRow = {
  id: string
  round: number
  roundLabel: string
  outcome: string
  takeaway: string
  roundData: CombatRound
}

const getOutcomeClassName = (outcome: string) => {
  const value = outcome.toLowerCase()
  if (value === "continued") {
    return "text-muted-foreground"
  }
  if (value.includes("victory") || value.includes("satisfied")) {
    return "text-success"
  }
  if (value.includes("defeat") || value.includes("destroyed")) {
    return "text-destructive"
  }
  if (value.includes("fled") || value.includes("stalemate")) {
    return "text-warning"
  }
  return "text-foreground"
}

const columnsCombatRounds: ColumnDef<CombatRoundTableRow>[] = [
  {
    accessorKey: "roundLabel",
    header: "Round",
    meta: { width: "22%" },
  },
  {
    accessorKey: "outcome",
    header: "Outcome",
    meta: { width: "22%", align: "center" },
    cell: ({ getValue }) => {
      const outcome = getValue() as string
      return <span className={cn("uppercase", getOutcomeClassName(outcome))}>{outcome}</span>
    },
  },
  {
    accessorKey: "takeaway",
    header: "Takeaway",
  },
]

export const CombatRoundTablePanel = ({
  className,
  onRowClick,
}: {
  className?: string
  onRowClick?: (round: CombatRound) => void
}) => {
  const combatRounds = useGameStore((state) => state.combatRounds)

  const roundRows = useMemo<CombatRoundTableRow[]>(
    () =>
      [...combatRounds]
        .sort((a, b) => b.round - a.round)
        .map((round) => {
          const outcomeRaw = round.round_result ?? round.result ?? round.end
          const outcome = outcomeRaw ? String(outcomeRaw).replace(/_/g, " ") : "continued"

          const destroyedCount = Object.entries(round.fighters_remaining ?? {}).reduce(
            (count, [combatantId, fightersRemaining]) => {
              if (fightersRemaining > 0) return count
              const lossesThisRound =
                (round.offensive_losses?.[combatantId] ?? 0) +
                (round.defensive_losses?.[combatantId] ?? 0)
              return lossesThisRound > 0 ? count + 1 : count
            },
            0
          )
          const fledCount = Object.values(round.flee_results ?? {}).filter(Boolean).length
          const paidCount = Object.values(round.actions ?? {}).filter(
            (action) => action.action === "pay"
          ).length

          const takeaway = `Destroyed: ${destroyedCount} | Fled: ${fledCount} | Paid: ${paidCount}`

          return {
            id: `${round.combat_id}:${round.round}`,
            round: round.round,
            roundLabel: `Round ${round.round}`,
            outcome,
            takeaway,
            roundData: round,
          }
        }),
    [combatRounds]
  )

  if (roundRows.length <= 0) {
    return <BlankSlateTile text="No combat rounds yet" />
  }

  return (
    <Card className={cn("flex h-full bg-background", className)} size="none">
      <CardContent className="flex flex-col h-full min-h-0 gap-2 relative px-0!">
        <DataTableScrollArea
          data={roundRows}
          columns={columnsCombatRounds}
          striped
          hoverable={Boolean(onRowClick)}
          onRowClick={onRowClick ? (row) => onRowClick(row.roundData) : undefined}
          className="text-background h-full"
          classNames={{ table: "text-xxs" }}
        />
      </CardContent>
    </Card>
  )
}
