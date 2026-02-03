import { useMemo, useState } from "react"

import { type ColumnDef } from "@tanstack/react-table"

type LeaderboardRow = { name: string }

import { DataTableScrollArea } from "@/components/DataTable"
import useGameStore from "@/stores/game"
import { formatCurrency } from "@/utils/formatting"
import { cn } from "@/utils/tailwind"

import { FullScreenLoader } from "../FullScreenLoader"
import { Button } from "../primitives/Button"
import { ButtonGroup } from "../primitives/ButtonGroup"
import { Card } from "../primitives/Card"

const wealthColumns: ColumnDef<LeaderboardWealth>[] = [
  {
    accessorKey: "name",
    header: "Player",
    meta: { width: "20%", cellClassName: "text-foreground" },
  },
  {
    accessorKey: "bank_credits",
    header: "Bank Credits",
    meta: { align: "center" },
    cell: ({ getValue }) => formatCurrency(getValue() as number),
  },
  {
    accessorKey: "ship_credits",
    header: "Ship Credits",
    meta: { align: "center" },
    cell: ({ getValue }) => formatCurrency(getValue() as number),
  },
  {
    accessorKey: "cargo_value",
    header: "Cargo Value",
    meta: { align: "center" },
    cell: ({ getValue }) => formatCurrency(getValue() as number),
  },
  { accessorKey: "ships_owned", header: "Ships Owned", meta: { align: "center" } },
  {
    accessorKey: "ship_value",
    header: "Ship Value",
    meta: { align: "center" },
    cell: ({ getValue }) => formatCurrency(getValue() as number),
  },
  {
    accessorKey: "total_wealth",
    header: "Total Wealth",
    meta: {
      align: "center",
      headerClassName: "text-terminal",
      cellClassName: "text-terminal-foreground bg-terminal-background/20",
    },
    cell: ({ getValue }) => formatCurrency(getValue() as number),
  },
]

const tradingColumns: ColumnDef<LeaderboardTrading>[] = [
  {
    accessorKey: "name",
    header: "Player",
    meta: { width: "20%", cellClassName: "text-foreground" },
  },
  { accessorKey: "total_trades", header: "Total Trades", meta: { align: "center" } },
  { accessorKey: "total_trade_volume", header: "Total Trade Volume", meta: { align: "center" } },
  { accessorKey: "ports_visited", header: "Ports Visited", meta: { align: "center" } },
]

const explorationColumns: ColumnDef<LeaderboardExploration>[] = [
  {
    accessorKey: "name",
    header: "Player",
    meta: { width: "20%", cellClassName: "text-foreground" },
  },
  { accessorKey: "sectors_visited", header: "Sectors Visited", meta: { align: "center" } },
  { accessorKey: "first_visit", header: "First Visit", meta: { align: "center" } },
]

export const LeaderboardPanel = ({ className }: { className?: string }) => {
  const leaderboardData = useGameStore((state) => state.leaderboard_data)
  const player = useGameStore((state) => state.player)
  const [filter, setFilter] = useState<"wealth" | "territory" | "trading" | "exploration">("wealth")

  const wealthData = useMemo(
    () => [...(leaderboardData?.wealth ?? [])].sort((a, b) => b.total_wealth - a.total_wealth),
    [leaderboardData?.wealth]
  )

  const tradingData = useMemo(
    () => [...(leaderboardData?.trading ?? [])].sort((a, b) => b.total_trades - a.total_trades),
    [leaderboardData?.trading]
  )

  const explorationData = useMemo(
    () =>
      [...(leaderboardData?.exploration ?? [])].sort(
        (a, b) => b.sectors_visited - a.sectors_visited
      ),
    [leaderboardData?.exploration]
  )

  const data = useMemo(() => {
    switch (filter) {
      case "wealth":
        return wealthData
      case "trading":
        return tradingData
      case "exploration":
        return explorationData
      default:
        return wealthData
    }
  }, [filter, wealthData, tradingData, explorationData])

  const columns = useMemo(() => {
    switch (filter) {
      case "wealth":
        return wealthColumns
      case "trading":
        return tradingColumns
      case "exploration":
        return explorationColumns
      default:
        return wealthColumns
    }
  }, [filter])

  console.debug("[LEADERBOARD] Leaderboard data:", leaderboardData)
  if (!leaderboardData) {
    return <FullScreenLoader message="Fetching leaderboard data..." className="h-full w-full" />
  }
  return (
    <Card className={cn("flex h-full bg-background flex-1", className)} size="none">
      <div className="border-b p-ui-xs flex flex-row justify-center gap-ui-sm">
        <div className="dotted-bg-sm dotted-bg-accent self-stretch flex-1" />
        <ButtonGroup className="bg-background/60">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setFilter("wealth")}
            className={filter === "wealth" ? "bg-background text-accent-foreground" : ""}
          >
            Wealth
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setFilter("trading")}
            className={filter === "trading" ? "bg-background text-accent-foreground" : ""}
          >
            Trading
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setFilter("exploration")}
            className={filter === "exploration" ? "bg-background text-accent-foreground" : ""}
          >
            Exploration
          </Button>
        </ButtonGroup>
        <div className="dotted-bg-sm dotted-bg-accent self-stretch flex-1" />
      </div>
      <div className="flex flex-col h-full min-h-0 gap-2 relative">
        <DataTableScrollArea<LeaderboardRow>
          data={data}
          columns={columns as ColumnDef<LeaderboardRow>[]}
          striped
          getRowClassName={(row) =>
            row.name === player?.name ?
              "bg-terminal-background/50 text-terminal-foreground font-bold"
            : undefined
          }
          className="text-background dither-mask-sm dither-mask-invert h-full"
        />
      </div>
    </Card>
  )
}
