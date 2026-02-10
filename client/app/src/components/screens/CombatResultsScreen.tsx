import { useMemo } from "react"

import { BlankSlateTile } from "@/components/BlankSlates"
import { DottedTitle } from "@/components/DottedTitle"
import { Badge } from "@/components/primitives/Badge"
import { Button } from "@/components/primitives/Button"
import { Card, CardContent } from "@/components/primitives/Card"
import useGameStore from "@/stores/game"
import { getRoundOutcomeTone, sumRecordValues } from "@/utils/combat"
import { formatCurrency } from "@/utils/formatting"
import { cn } from "@/utils/tailwind"

/**
 * Turns the raw engine end_state into a human-friendly label.
 * Possible raw values: `{name}_fled`, `stalemate`, `mutual_defeat`,
 * `{name}_defeated`, `victory`, or null/continued.
 */
function describeCombatOutcome(
  summary: CombatEndedRound,
  playerName: string | null,
): string {
  const raw = (summary.round_result ?? summary.result ?? summary.end ?? "").toLowerCase()

  if (!raw || raw === "continued") return "Inconclusive"
  if (raw === "stalemate") return "Stalemate"
  if (raw === "mutual_defeat") return "Mutual Destruction"
  if (raw === "victory") return "All Opponents Destroyed"

  // "{name}_defeated" — check if it was us or someone else
  if (raw.endsWith("_defeated")) {
    const defeatedName = raw.replace(/_defeated$/, "").replace(/_/g, " ")
    if (playerName && defeatedName.toLowerCase() === playerName.toLowerCase()) {
      return "You Were Destroyed"
    }
    return `${defeatedName.replace(/\b\w/g, (c) => c.toUpperCase())} Destroyed`
  }

  // "{name}_fled"
  if (raw.endsWith("_fled")) {
    const fledName = raw.replace(/_fled$/, "").replace(/_/g, " ")
    if (playerName && fledName.toLowerCase() === playerName.toLowerCase()) {
      return "You Fled"
    }
    return `${fledName.replace(/\b\w/g, (c) => c.toUpperCase())} Fled`
  }

  // Fallback: humanise the raw string
  return raw.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

const getStatusLabel = ({
  destroyed,
  fled,
  paid,
}: {
  destroyed: boolean
  fled: boolean
  paid: boolean
}) => {
  if (destroyed) return "destroyed"
  if (fled) return "fled"
  if (paid) return "paid"
  return "active"
}

export const CombatResultsScreen = ({ combat }: { combat?: CombatEndedRound }) => {
  const setActiveScreen = useGameStore((state) => state.setActiveScreen)
  const playerId = useGameStore((state) => state.player?.id ?? null)
  const playerName = useGameStore((state) => state.player?.name ?? null)
  const lastCombatEnded = useGameStore((state) => state.lastCombatEnded)

  const summary = combat ?? lastCombatEnded

  const rounds = summary?.logs ?? []
  const totalHits = rounds.reduce((total, round) => total + sumRecordValues(round.hits), 0)
  const totalLosses = rounds.reduce(
    (total, round) => total + sumRecordValues(round.offensive_losses) + sumRecordValues(round.defensive_losses),
    0
  )
  const totalShieldLoss = rounds.reduce((total, round) => total + sumRecordValues(round.shield_loss), 0)
  const totalRounds = rounds.length > 0 ? rounds.length : (summary?.round ?? 0)

  const salvageStats = useMemo(() => {
    const salvage = summary?.salvage ?? []
    return salvage.reduce(
      (acc, entry) => {
        const cargoUnits = Object.values(entry.cargo ?? {}).reduce(
          (total, units) => total + (Number.isFinite(units) ? units : 0),
          0
        )
        return {
          count: acc.count + 1,
          credits: acc.credits + (entry.credits ?? 0),
          scrap: acc.scrap + (entry.scrap ?? 0),
          cargoUnits: acc.cargoUnits + cargoUnits,
        }
      },
      { count: 0, credits: 0, scrap: 0, cargoUnits: 0 }
    )
  }, [summary?.salvage])

  const participantResults = useMemo(() => {
    if (!summary) return []

    return summary.participants.map((participant) => {
      const participantKey = participant.id ?? participant.name
      const fightersRemaining =
        summary.fighters_remaining?.[participantKey] ??
        summary.fighters_remaining?.[participant.name] ??
        null
      const shieldsRemaining =
        summary.shields_remaining?.[participantKey] ??
        summary.shields_remaining?.[participant.name] ??
        null
      const fled = Boolean(
        summary.flee_results?.[participantKey] ?? summary.flee_results?.[participant.name]
      )
      const action =
        summary.actions?.[participant.name] ??
        (participant.id ? summary.actions?.[participant.id] : undefined)
      const paid = action?.action === "pay"
      const destroyed = typeof fightersRemaining === "number" && fightersRemaining <= 0
      const isYou =
        (playerId && participant.id === playerId) || (playerName && participant.name === playerName)

      return {
        participant,
        fightersRemaining,
        shieldsRemaining,
        action: action?.action?.toUpperCase() ?? "—",
        status: getStatusLabel({ destroyed, fled, paid }),
        isYou: Boolean(isYou),
      }
    })
  }, [summary, playerId, playerName])

  if (!summary) {
    return (
      <div className="w-full h-full flex items-center justify-center">
        <BlankSlateTile text="No combat results available" />
      </div>
    )
  }

  const outcome = describeCombatOutcome(summary, playerName)

  return (
    <div className="relative z-10 w-full h-full max-w-6xl mx-auto px-ui-sm py-ui-sm flex flex-col gap-ui-sm pointer-events-auto">
      <Card variant="stripes" size="sm" className="border border-accent">
        <CardContent className="flex items-center justify-between gap-ui-sm">
          <div className="flex flex-col gap-1">
            <span className="text-xs uppercase text-muted-foreground">Combat Results</span>
            <span className="text-xl uppercase font-semibold tracking-wide">
              {totalRounds} {totalRounds === 1 ? "Round" : "Rounds"}
            </span>
          </div>
          <div className="flex items-center gap-ui-xs">
            <Badge
              variant="secondary"
              border="bracket"
              className={cn("uppercase", getRoundOutcomeTone(outcome))}
            >
              {outcome}
            </Badge>
            <Button variant="secondary" onClick={() => setActiveScreen(undefined)}>
              Close
            </Button>
          </div>
        </CardContent>
      </Card>

      <section className="grid grid-cols-4 gap-ui-xs text-xxs uppercase">
        <Card size="xs" className="border border-accent bg-card">
          <CardContent className="text-center">
            <div className="text-muted-foreground">Rounds</div>
            <div className="text-sm font-bold text-foreground">{totalRounds}</div>
          </CardContent>
        </Card>
        <Card size="xs" className="border border-accent bg-card">
          <CardContent className="text-center">
            <div className="text-muted-foreground">Total Hits</div>
            <div className="text-sm font-bold text-foreground">{totalHits}</div>
          </CardContent>
        </Card>
        <Card size="xs" className="border border-accent bg-card">
          <CardContent className="text-center">
            <div className="text-muted-foreground">Total Losses</div>
            <div className="text-sm font-bold text-warning">{totalLosses}</div>
          </CardContent>
        </Card>
        <Card size="xs" className="border border-accent bg-card">
          <CardContent className="text-center">
            <div className="text-muted-foreground">Shield Loss</div>
            <div className="text-sm font-bold text-destructive">{totalShieldLoss}</div>
          </CardContent>
        </Card>
      </section>

      <section className="grid grid-cols-2 gap-ui-sm min-h-0 flex-1">
        <Card size="xs" className="border border-accent min-h-0">
          <CardContent className="flex flex-col gap-ui-xs h-full min-h-0">
            <DottedTitle title="Participants" textColor="text-foreground" />
            <ul className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-ui-xs text-xxs uppercase">
              {participantResults.map(
                ({ participant, fightersRemaining, shieldsRemaining, action, status, isYou }) => (
                  <li
                    key={participant.id ?? participant.name}
                    className="p-ui-xs border border-accent bg-card flex flex-col gap-1"
                  >
                    <div className="flex items-center justify-between gap-ui-xs">
                      <span className="font-bold text-foreground truncate">
                        {participant.name}
                        {isYou ? " (You)" : ""}
                      </span>
                      <Badge size="sm" variant="secondary" className="uppercase">
                        {status}
                      </Badge>
                    </div>
                    <div className="text-muted-foreground flex items-center gap-ui-xs">
                      <span className="truncate">{participant.ship.ship_name}</span>
                      <span>Action: {action}</span>
                    </div>
                    <div className="text-muted-foreground flex items-center gap-ui-xs">
                      <span>Fighters: {typeof fightersRemaining === "number" ? fightersRemaining : "—"}</span>
                      <span>Shields: {typeof shieldsRemaining === "number" ? shieldsRemaining : "—"}</span>
                    </div>
                  </li>
                )
              )}
            </ul>
          </CardContent>
        </Card>

        <Card size="xs" className="border border-accent min-h-0">
          <CardContent className="flex flex-col gap-ui-xs h-full min-h-0">
            <DottedTitle title="Salvage" textColor="text-foreground" />
            <div className="grid grid-cols-2 gap-ui-xs text-xxs uppercase">
              <div className="p-ui-xs border border-accent bg-card text-center">
                <div className="text-muted-foreground">Entries</div>
                <div className="font-bold text-foreground">{salvageStats.count}</div>
              </div>
              <div className="p-ui-xs border border-accent bg-card text-center">
                <div className="text-muted-foreground">Cargo Units</div>
                <div className="font-bold text-foreground">{salvageStats.cargoUnits}</div>
              </div>
              <div className="p-ui-xs border border-accent bg-card text-center">
                <div className="text-muted-foreground">Credits</div>
                <div className="font-bold text-success">
                  {formatCurrency(salvageStats.credits, "standard")}
                </div>
              </div>
              <div className="p-ui-xs border border-accent bg-card text-center">
                <div className="text-muted-foreground">Scrap</div>
                <div className="font-bold text-foreground">{salvageStats.scrap}</div>
              </div>
            </div>

            <DottedTitle title="Result Summary" textColor="text-foreground" className="pt-ui-sm" />
            <div className="flex-1 min-h-0 overflow-y-auto p-ui-xs border border-accent bg-card text-xxs uppercase text-muted-foreground">
              Combat resolved after {totalRounds} {totalRounds === 1 ? "round" : "rounds"} —{" "}
              <span className={cn("font-bold", getRoundOutcomeTone(outcome))}>{outcome}</span>.
            </div>
          </CardContent>
        </Card>
      </section>
    </div>
  )
}
