import { useMemo, useState } from "react"

import { differenceInDays, differenceInMonths, differenceInYears, format } from "date-fns"
import { type ColumnDef } from "@tanstack/react-table"

type LeaderboardRow = { player_name: string }

import { DataTableScrollArea } from "@/components/DataTable"
import useGameStore from "@/stores/game"
import { formatCurrency } from "@/utils/formatting"
import { cn } from "@/utils/tailwind"

import { FullScreenLoader } from "../FullScreenLoader"
import { Badge, BadgeTitle } from "../primitives/Badge"
import { Button } from "../primitives/Button"
import { ButtonGroup } from "../primitives/ButtonGroup"
import { Card, CardContent } from "../primitives/Card"
import { Divider } from "../primitives/Divider"

const wealthColumns: ColumnDef<LeaderboardWealth>[] = [
  {
    accessorKey: "player_name",
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
    accessorKey: "player_name",
    header: "Player",
    meta: { width: "20%", cellClassName: "text-foreground" },
  },
  { accessorKey: "total_trades", header: "Total Trades", meta: { align: "center" } },
  { accessorKey: "total_trade_volume", header: "Total Trade Volume", meta: { align: "center" } },
  { accessorKey: "ports_visited", header: "Ports Visited", meta: { align: "center" } },
]

const explorationColumns: ColumnDef<LeaderboardExploration>[] = [
  {
    accessorKey: "player_name",
    header: "Player",
    meta: { width: "20%", cellClassName: "text-foreground" },
  },
  { accessorKey: "sectors_visited", header: "Sectors Visited", meta: { align: "center" } },
  {
    accessorKey: "first_visit",
    header: "Account Age",
    meta: { align: "center" },
    cell: ({ getValue }) => {
      const value = getValue() as string | null
      if (!value) return "N/A"
      const date = new Date(value)
      const now = new Date()
      const years = differenceInYears(now, date)
      const months = differenceInMonths(now, date) % 12
      const days = differenceInDays(now, date)
      if (years > 0) {
        return months > 0 ? `${years}y ${months}mo` : `${years}y`
      }
      if (months > 0) {
        return `${months}mo`
      }
      return `${days}d`
    },
  },
]

type LeaderboardTab = LeaderboardCategory | "world_events"

export const LeaderboardPanel = ({
  className,
  onScopeChange,
}: {
  className?: string
  onScopeChange?: (scope: "global" | "event") => void
}) => {
  const leaderboardData = useGameStore((state) => state.leaderboardDialogData)
  const player = useGameStore((state) => state.player)
  const playerEvent = useGameStore((state) => state.playerEvent)
  const leaderboardScope = useGameStore((state) => state.leaderboardScope)
  const worldEvents = useGameStore((state) => state.worldEvents)
  const [filter, setFilter] = useState<LeaderboardTab>("wealth")

  const wealthData = useMemo(
    () =>
      [...(leaderboardData?.wealth ?? [])]
        .filter((p) => p.player_type === "human")
        .sort((a, b) => b.total_wealth - a.total_wealth),
    [leaderboardData?.wealth]
  )

  const tradingData = useMemo(
    () =>
      [...(leaderboardData?.trading ?? [])]
        .filter((p) => p.player_type === "human")
        .sort((a, b) => b.total_trades - a.total_trades),
    [leaderboardData?.trading]
  )

  const explorationData = useMemo(
    () =>
      [...(leaderboardData?.exploration ?? [])]
        .filter((p) => p.player_type === "human")
        .sort((a, b) => b.sectors_visited - a.sectors_visited),
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

  if (filter === "world_events") {
    return (
      <Card className={cn("flex h-full bg-background flex-1", className)} size="none">
        <LeaderboardHeader
          filter={filter}
          setFilter={setFilter}
          playerEvent={playerEvent}
          leaderboardScope={leaderboardScope}
          onScopeChange={onScopeChange}
        />
        <div className="flex flex-col h-full min-h-0 gap-2 relative p-ui-xs overflow-y-auto">
          <WorldEventsList events={worldEvents} />
        </div>
      </Card>
    )
  }

  if (!leaderboardData) {
    return <FullScreenLoader message="Fetching leaderboard data..." className="h-full w-full" />
  }

  return (
    <Card className={cn("flex h-full bg-background flex-1", className)} size="none">
      <LeaderboardHeader
        filter={filter}
        setFilter={setFilter}
        playerEvent={playerEvent}
        leaderboardScope={leaderboardScope}
        onScopeChange={onScopeChange}
      />
      {leaderboardData.frozen && (
        <div className="px-ui-xs py-1 text-center text-xs uppercase tracking-wider text-muted-foreground bg-muted/30 border-b">
          Results frozen
          {leaderboardData.event_title && ` — ${leaderboardData.event_title}`}
        </div>
      )}
      <div className="flex flex-col h-full min-h-0 gap-2 relative">
        <DataTableScrollArea<LeaderboardRow>
          data={data}
          columns={columns as ColumnDef<LeaderboardRow>[]}
          striped
          getRowClassName={(row) =>
            row.player_name === player?.name ?
              "bg-fuel-background text-fuel-foreground font-bold"
            : undefined
          }
          className="text-background dither-mask-sm dither-mask-invert h-full"
        />
      </div>
    </Card>
  )
}

function LeaderboardHeader({
  filter,
  setFilter,
  playerEvent,
  leaderboardScope,
  onScopeChange,
}: {
  filter: LeaderboardTab
  setFilter: (f: LeaderboardTab) => void
  playerEvent: { event_id: string; title: string } | null
  leaderboardScope: "global" | "event"
  onScopeChange?: (scope: "global" | "event") => void
}) {
  return (
    <div className="border-b p-ui-xs flex flex-col gap-ui-xs">
      {playerEvent && (
        <div className="flex flex-row justify-center gap-ui-sm">
          <div className="dotted-bg-sm dotted-bg-accent self-stretch flex-1" />
          <ButtonGroup className="bg-background/60">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onScopeChange?.("event")}
              className={leaderboardScope === "event" ? "bg-background text-accent-foreground" : ""}
            >
              {playerEvent.title}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onScopeChange?.("global")}
              className={
                leaderboardScope === "global" ? "bg-background text-accent-foreground" : ""
              }
            >
              Global
            </Button>
          </ButtonGroup>
          <div className="dotted-bg-sm dotted-bg-accent self-stretch flex-1" />
        </div>
      )}
      <div className="flex flex-row justify-center gap-ui-sm">
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
          <Button
            variant="outline"
            size="sm"
            onClick={() => setFilter("world_events")}
            className={filter === "world_events" ? "bg-background text-accent-foreground" : ""}
          >
            World Events
          </Button>
        </ButtonGroup>
        <div className="dotted-bg-sm dotted-bg-accent self-stretch flex-1" />
      </div>
    </div>
  )
}

function WorldEventsList({ events }: { events?: WorldEvent[] }) {
  if (!events || events.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm uppercase tracking-wider">
        No active events
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {events.map((event) => (
        <WorldEventCard key={event.event_id} event={event} />
      ))}
    </div>
  )
}

function WorldEventCard({ event }: { event: WorldEvent }) {
  return (
    <Card variant="default" size="sm" className="bg-muted/20">
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-row items-start justify-between gap-2">
          <div className="flex flex-col gap-1">
            <span className="text-sm font-bold uppercase tracking-wider text-foreground">
              {event.title}
            </span>
            {event.description && (
              <span className="text-xs text-muted-foreground">{event.description}</span>
            )}
            {event.link_url && (
              <a
                href={event.link_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-accent-foreground hover:underline"
              >
                Learn more
              </a>
            )}
          </div>
          <Badge variant={event.is_ended ? "default" : "increment"} size="sm">
            <BadgeTitle>{event.is_ended ? "Ended" : "Live"}</BadgeTitle>
          </Badge>
        </div>
        <div className="flex flex-row gap-4 text-xs text-muted-foreground">
          <span>
            {format(new Date(event.starts_at), "MMM d")} —{" "}
            {format(new Date(event.ends_at), "MMM d")}
          </span>
          <span>{event.participant_count} participants</span>
        </div>
        <Divider color="secondary" decoration="none" />
        <div className="grid grid-cols-4 gap-3">
          <TopPlayersColumn
            title="Wealth"
            players={event.top_players.wealth.map((p) => ({
              player_id: p.player_id,
              player_name: p.player_name,
              value: p.total_wealth,
            }))}
          />
          <TopPlayersColumn
            title="Territory"
            players={event.top_players.territory.map((p) => ({
              player_id: p.player_id,
              player_name: p.player_name,
              value: p.sectors_controlled,
            }))}
          />
          <TopPlayersColumn
            title="Trading"
            players={event.top_players.trading.map((p) => ({
              player_id: p.player_id,
              player_name: p.player_name,
              value: p.total_trade_volume,
            }))}
          />
          <TopPlayersColumn
            title="Exploration"
            players={event.top_players.exploration.map((p) => ({
              player_id: p.player_id,
              player_name: p.player_name,
              value: p.sectors_visited,
            }))}
          />
        </div>
      </CardContent>
    </Card>
  )
}

function TopPlayersColumn({
  title,
  players,
}: {
  title: string
  players: Array<{ player_id: string; player_name: string; value: number }>
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
        {title}
      </span>
      {players.length === 0 ?
        <span className="text-xs text-muted-foreground/50">—</span>
      : players.map((p, i) => (
          <div key={p.player_id ?? i} className="flex flex-row justify-between text-xs">
            <span className="text-foreground truncate">
              {i + 1}. {p.player_name}
            </span>
            <span className="text-muted-foreground tabular-nums ml-1">
              {formatCurrency(p.value)}
            </span>
          </div>
        ))
      }
    </div>
  )
}
