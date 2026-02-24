import { useMemo } from "react"

import { ArrowRightIcon, CheckIcon } from "@phosphor-icons/react"
import { type ColumnDef } from "@tanstack/react-table"

import { DataTableScrollArea } from "@/components/DataTable"
import useGameStore from "@/stores/game"
import { sumRecordValues } from "@/utils/combat"
import { formatDateTime24, formatTimeAgoOrDate, formatTimeAgoShort } from "@/utils/date"
import { formatCurrency } from "@/utils/formatting"
import { shipTypeVerbose } from "@/utils/game"
import { getPortCode } from "@/utils/port"
import { cn } from "@/utils/tailwind"

import { BlankSlateTile } from "../BlankSlates"
import { PortCodeString } from "../PortCodeString"
import { Button } from "../primitives/Button"
import { Card, CardContent } from "../primitives/Card"

import { RESOURCE_SHORT_NAMES } from "@/types/constants"

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
    meta: { align: "right", width: "25%" },
    cell: ({ getValue }) => {
      const value = getValue() as string | null
      return <span className="uppercase">{value ? formatTimeAgoOrDate(value) : "Discovered"}</span>
    },
  },
]

export const MovementHistoryPanel = ({ className }: { className?: string }) => {
  const movementHistory = useGameStore((state) => state.movement_history)
  const reversedMovementHistory = useMemo(() => [...movementHistory].reverse(), [movementHistory])

  if (reversedMovementHistory.length <= 0) {
    return <BlankSlateTile text="No movement history" />
  }

  return (
    <Card className={cn("flex h-full bg-background", className)} size="none">
      <CardContent className="flex flex-col h-full min-h-0 gap-2 relative px-0!">
        <DataTableScrollArea
          data={reversedMovementHistory}
          columns={columns}
          striped
          className="text-background h-full"
          classNames={{ table: "text-xxs" }}
        />
      </CardContent>
    </Card>
  )
}

const columnsSectorPlayerMovement: ColumnDef<LogEntry>[] = [
  {
    id: "player",
    accessorFn: (row) => String((row.meta?.player as { name?: string } | undefined)?.name ?? "—"),
    header: "Player",
    meta: { width: "40%" },
  },
  {
    id: "ship",
    accessorFn: (row) =>
      String((row.meta?.ship as { ship_name?: string } | undefined)?.ship_name ?? "—"),
    header: "Ship",
  },
  {
    id: "direction",
    accessorFn: (row) => String(row.meta?.direction ?? ""),
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
  status: "pending" | "resolved" | "ended"
  yourAction: string
  hits: number
  roundData: CombatRound
}

const buildPendingCombatRound = (combatSession: CombatSession): CombatRound => ({
  combat_id: combatSession.combat_id,
  sector: { id: 0 },
  round: combatSession.round,
  hits: {},
  offensive_losses: {},
  defensive_losses: {},
  shield_loss: {},
  damage_mitigated: {},
  fighters_remaining: {},
  shields_remaining: {},
  flee_results: {},
  actions: {},
  participants: combatSession.participants,
  garrison: combatSession.garrison ?? null,
  deadline: combatSession.deadline,
  end: null,
  result: null,
  round_result: null,
})

const columnsCombatRounds: ColumnDef<CombatRoundTableRow>[] = [
  {
    accessorKey: "roundLabel",
    header: "Round",
    meta: { width: "12%" },
  },
  {
    accessorKey: "status",
    header: "Status",
    meta: { width: "20%", align: "center" },
    cell: ({ getValue }) => {
      const status = getValue() as CombatRoundTableRow["status"]
      const tone =
        status === "ended" ? "text-destructive"
        : status === "resolved" ? "text-muted-foreground"
        : "text-terminal"
      return <span className={cn("uppercase font-semibold", tone)}>{status}</span>
    },
  },
  {
    accessorKey: "yourAction",
    header: "Your Action",
    meta: { width: "24%", align: "center" },
    cell: ({ getValue }) => {
      const value = String(getValue() ?? "—")
      const tone =
        value === "ATTACK" ? "text-destructive"
        : value === "BRACE" ? "text-accent-foreground"
        : value === "FLEE" ? "text-warning"
        : value === "PAY" ? "text-success"
        : "text-muted-foreground"
      return <span className={cn("uppercase font-semibold", tone)}>{value}</span>
    },
  },
  {
    accessorKey: "hits",
    header: "Hits",
    meta: { width: "12%", align: "center" },
  },
  {
    id: "open",
    header: "",
    meta: { width: "10%", align: "right" },
    cell: () => (
      <Button
        type="button"
        size="ui"
        variant="link"
        className="text-muted-foreground hover:text-foreground p-0 size-4"
        aria-label="Open round details"
      >
        <ArrowRightIcon size={12} weight="bold" className="size-3" />
      </Button>
    ),
  },
]

export const CombatRoundTablePanel = ({
  className,
  onRowClick,
}: {
  className?: string
  onRowClick?: (round: CombatRound) => void
}) => {
  const activeCombatSession = useGameStore((state) => state.activeCombatSession)
  const playerId = useGameStore((state) => state.player?.id ?? null)
  const playerName = useGameStore((state) => state.player?.name ?? null)
  const combatRounds = useGameStore((state) => state.combatRounds)
  const combatActionReceipts = useGameStore((state) => state.combatActionReceipts)

  const roundRows = useMemo<CombatRoundTableRow[]>(() => {
    const activeCombatId = activeCombatSession?.combat_id
    const baseRounds =
      activeCombatId ?
        combatRounds.filter((round) => round.combat_id === activeCombatId)
      : combatRounds

    const rows: CombatRoundTableRow[] = [...baseRounds]
      .sort((a, b) => b.round - a.round)
      .map((round) => {
        const status: CombatRoundTableRow["status"] =
          round.end || round.result || round.round_result ? "ended" : "resolved"
        const selfParticipant = round.participants?.find(
          (participant) =>
            (playerId && participant.id === playerId) ||
            (playerName && participant.name === playerName)
        )
        const selfAction =
          (selfParticipant?.name ? round.actions?.[selfParticipant.name] : undefined) ??
          (selfParticipant?.id ? round.actions?.[selfParticipant.id] : undefined) ??
          (playerId ? round.actions?.[playerId] : undefined) ??
          (playerName ? round.actions?.[playerName] : undefined)

        return {
          id: `${round.combat_id}:${round.round}`,
          round: round.round,
          roundLabel: String(round.round),
          status,
          yourAction: selfAction?.action?.toUpperCase() ?? "—",
          hits: sumRecordValues(round.hits),
          roundData: round,
        }
      })

    if (activeCombatSession) {
      const hasCurrentRoundRow = rows.some(
        (row) =>
          row.round === activeCombatSession.round &&
          row.id.startsWith(`${activeCombatSession.combat_id}:`)
      )

      if (!hasCurrentRoundRow) {
        const latestPersonalReceipt = [...combatActionReceipts]
          .filter(
            (receipt) =>
              receipt.combat_id === activeCombatSession.combat_id &&
              receipt.round === activeCombatSession.round
          )
          .at(-1)
        rows.unshift({
          id: `${activeCombatSession.combat_id}:${activeCombatSession.round}:pending`,
          round: activeCombatSession.round,
          roundLabel: String(activeCombatSession.round),
          status: "pending",
          yourAction: latestPersonalReceipt?.action?.toUpperCase() ?? "—",
          hits: 0,
          roundData: buildPendingCombatRound(activeCombatSession),
        })
      }
    }

    return rows
  }, [activeCombatSession, combatActionReceipts, combatRounds, playerId, playerName])

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
          className="text-background dither-mask-sm dither-mask-invert h-full"
          classNames={{ table: "text-xxs" }}
        />
      </CardContent>
    </Card>
  )
}

// --- Sector History (Known Ports) Table ---

type SectorHistoryRow = {
  sectorId: number
  portCode: string
  qfPrice: number | null
  roPrice: number | null
  nsPrice: number | null
  hops: number | null
  updatedAt: string | null
}

const columnsSectorHistory: ColumnDef<SectorHistoryRow>[] = [
  {
    accessorKey: "sectorId",
    header: "Sector",
    meta: { align: "center", width: 0 },
    cell: ({ getValue }) => <span className="font-bold">{getValue() as number}</span>,
  },
  {
    accessorKey: "portCode",
    header: "Port",
    meta: { align: "center", width: 0 },
    cell: ({ getValue }) => <PortCodeString code={getValue() as string} />,
  },
  {
    accessorKey: "qfPrice",
    header: "QF",
    meta: { align: "right", width: 0 },
    cell: ({ getValue }) => {
      const v = getValue() as number | null
      return v != null ? v : "—"
    },
  },
  {
    accessorKey: "roPrice",
    header: "RO",
    meta: { align: "right", width: 0 },
    cell: ({ getValue }) => {
      const v = getValue() as number | null
      return v != null ? v : "—"
    },
  },
  {
    accessorKey: "nsPrice",
    header: "NS",
    meta: { align: "right", width: 0 },
    cell: ({ getValue }) => {
      const v = getValue() as number | null
      return v != null ? v : "—"
    },
  },
  {
    accessorKey: "hops",
    header: "Hops",
    meta: { align: "center", width: 0 },
    cell: ({ getValue }) => {
      const v = getValue() as number | null
      return v != null ? v : "—"
    },
  },
  {
    accessorKey: "updatedAt",
    header: "Updated",
    meta: { align: "right" },
    cell: ({ getValue }) => {
      const v = getValue() as string | null
      return v ? formatTimeAgoShort(v) : "—"
    },
  },
]

// --- Trade History Table ---

const columnsTradeHistory: ColumnDef<TradeHistoryEntry>[] = [
  {
    accessorKey: "is_buy",
    header: "Type",
    meta: { align: "center", width: 0, cellClassName: "overflow-visible relative" },
    cell: ({ getValue }) => {
      const isBuy = getValue() as boolean
      return (
        <>
          <div
            className={cn(
              "absolute inset-y-0 left-0 w-panel-gap",
              isBuy ? "bg-success" : "bg-warning"
            )}
          />
          <span
            className={cn(
              "uppercase",
              isBuy ? "text-success-foreground" : "text-warning-foreground"
            )}
          >
            {isBuy ? "Buy" : "Sell"}
          </span>
        </>
      )
    },
  },
  {
    accessorKey: "timestamp",
    header: "Time",
    meta: { width: "20%" },
    cell: ({ getValue }) => {
      const v = getValue() as string | undefined
      return v ? formatTimeAgoShort(v) : "—"
    },
  },
  {
    accessorKey: "sector",
    header: "Sector",
    meta: { align: "center", width: 0 },
    cell: ({ getValue }) => <span className="font-bold">{getValue() as number}</span>,
  },
  {
    accessorKey: "commodity",
    header: "Commodity",
    meta: { align: "center", width: 0 },
    cell: ({ getValue }) => RESOURCE_SHORT_NAMES[getValue() as Resource] ?? getValue(),
  },
  {
    accessorKey: "units",
    header: "Units",
    meta: { align: "center", width: 0 },
  },
  {
    accessorKey: "price_per_unit",
    header: "Price",
    meta: { align: "center", width: 0 },
  },
  {
    accessorKey: "total_price",
    header: "Total",
    meta: { align: "right", cellClassName: "overflow-visible" },
    cell: ({ getValue }) => (
      <span className="text-foreground font-bold">
        {formatCurrency(getValue() as number, "standard")} CR
      </span>
    ),
  },
]

export const TradeHistoryTablePanel = ({ className }: { className?: string }) => {
  const tradeHistory = useGameStore((state) => state.trade_history)

  const rows = useMemo(() => (tradeHistory ? [...tradeHistory].reverse() : []), [tradeHistory])

  if (rows.length <= 0) {
    return <BlankSlateTile text="No trade history" />
  }

  return (
    <Card className={cn("flex h-full bg-background", className)} size="none">
      <CardContent className="flex flex-col h-full min-h-0 gap-2 relative px-0!">
        <DataTableScrollArea
          data={rows}
          columns={columnsTradeHistory}
          getRowClassName={(row) =>
            cn(
              "border-l-3",
              row.is_buy ?
                "bg-success-background/40 border-l-success"
              : "bg-warning-background/40 border-l-warning"
            )
          }
          className="text-background h-full"
          classNames={{ table: "text-xxs" }}
        />
      </CardContent>
    </Card>
  )
}

// --- Sector History (Known Ports) Table ---

export const SectorHistoryTablePanel = ({
  className,
  sectorId,
}: {
  className?: string
  sectorId?: number
}) => {
  const knownPorts = useGameStore((state) => state.known_ports)

  const rows = useMemo<SectorHistoryRow[]>(() => {
    if (!knownPorts) return []
    return knownPorts
      .filter((sh) => sh.sector.port && sh.sector.id !== sectorId)
      .map((sh) => {
        const port = sh.sector.port as Port | undefined
        return {
          sectorId: sh.sector.id,
          portCode: getPortCode(port),
          qfPrice: port?.prices?.quantum_foam ?? null,
          roPrice: port?.prices?.retro_organics ?? null,
          nsPrice: port?.prices?.neuro_symbolics ?? null,
          hops: sh.hops_from_start ?? null,
          updatedAt: sh.updated_at ?? sh.last_visited ?? null,
        }
      })
  }, [knownPorts, sectorId])

  if (rows.length <= 0) {
    return <BlankSlateTile text="No known ports" />
  }

  return (
    <Card className={cn("flex h-full bg-background", className)} size="none">
      <CardContent className="flex flex-col h-full min-h-0 gap-2 relative px-0!">
        <DataTableScrollArea
          data={rows}
          columns={columnsSectorHistory}
          striped
          className="text-background h-full"
          classNames={{ table: "text-xxs" }}
        />
      </CardContent>
    </Card>
  )
}

// --- Destroyed Ships Table ---

const columnsDestroyedShips: ColumnDef<ShipSelf>[] = [
  {
    accessorKey: "ship_name",
    header: "Ship",
  },
  {
    accessorKey: "ship_type",
    header: "Type",
    cell: ({ getValue }) => shipTypeVerbose(getValue() as string),
  },
  {
    accessorKey: "sector",
    header: "Sector",
    meta: { align: "center", width: 0 },
    cell: ({ getValue }) => {
      const v = getValue() as number | null
      return v != null ? <span className="font-bold">{v}</span> : "—"
    },
  },
  {
    accessorKey: "destroyed_at",
    header: "Destroyed",
    meta: { align: "right" },
    cell: ({ getValue }) => {
      const v = getValue() as string | null
      return v ? formatTimeAgoShort(v) : "—"
    },
  },
]

export const DestroyedShipsPanel = ({ className }: { className?: string }) => {
  const ships = useGameStore((state) => state.ships.data)

  const destroyedShips = useMemo(
    () => (ships ?? []).filter((s) => s.owner_type === "corporation" && s.destroyed_at),
    [ships]
  )

  if (destroyedShips.length <= 0) {
    return <BlankSlateTile text="No destroyed ships" />
  }

  return (
    <Card className={cn("flex h-full bg-background", className)} size="none">
      <CardContent className="flex flex-col h-full min-h-0 gap-2 relative px-0!">
        <DataTableScrollArea
          data={destroyedShips}
          columns={columnsDestroyedShips}
          striped
          className="text-background h-full"
          classNames={{ table: "text-xxs" }}
        />
      </CardContent>
    </Card>
  )
}
