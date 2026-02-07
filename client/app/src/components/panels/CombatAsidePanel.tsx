import { useEffect, useMemo, useState } from "react"

import { Card, CardContent } from "@/components/primitives/Card"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/primitives/Popover"
import { ShipDetailsCallout } from "@/components/ShipDetailsCallout"
import { FighterIcon, ShieldIcon } from "@/icons"
import useGameStore from "@/stores/game"
import { getShipLogoImage } from "@/utils/images"
import { cn } from "@/utils/tailwind"

import { BlankSlateTile } from "../BlankSlates"
import { DottedTitle } from "../DottedTitle"
import { DotDivider } from "../primitives/DotDivider"
import { InfoIconSM } from "../svg/InfoIconSM"
import { CombatRoundTablePanel } from "./DataTablePanels"
import { RHSSubPanel } from "./RHSPanelContainer"

import { PLAYER_TYPE_NAMES } from "@/types/constants"
const getShieldColor = (shieldIntegrity: number) => {
  if (shieldIntegrity < 25) {
    return "text-destructive"
  }
  if (shieldIntegrity < 50) {
    return "text-warning"
  }
  return "text-success"
}

const getRoundOutcomeTone = (outcome: string | null | undefined) => {
  const value = String(outcome ?? "").toLowerCase()
  if (!value || value === "continued") {
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

const sumRecordValues = (values: Record<string, number> | undefined) =>
  Object.values(values ?? {}).reduce(
    (total, value) => total + (Number.isFinite(value) ? value : 0),
    0
  )

const getRoundDestroyedCount = (round: CombatRound) =>
  Object.entries(round.fighters_remaining ?? {}).reduce(
    (count, [combatantId, fightersRemaining]) => {
      if (fightersRemaining > 0) return count
      const lossesThisRound =
        (round.offensive_losses?.[combatantId] ?? 0) + (round.defensive_losses?.[combatantId] ?? 0)
      return lossesThisRound > 0 ? count + 1 : count
    },
    0
  )

const getRoundFledCount = (round: CombatRound) =>
  Object.values(round.flee_results ?? {}).filter(Boolean).length

const getRoundPaidCount = (round: CombatRound) =>
  Object.values(round.actions ?? {}).filter((action) => action.action === "pay").length

const CombatParticipant = ({
  participant,
  fightersRemaining,
  shieldsRemaining,
  initiator,
  destroyed = false,
  fled = false,
}: {
  participant: CombatParticipant
  fightersRemaining: number | null
  shieldsRemaining: number | null
  initiator?: string
  destroyed?: boolean
  fled?: boolean
}) => {
  const [popoverOpen, setPopoverOpen] = useState(false)
  const isInitiator =
    !!initiator && (participant.id === initiator || participant.name === initiator)
  const isInactive = destroyed || fled

  return (
    <li className="relative flex-1 flex flex-row items-center gap-ui-xs p-ui-xs bg-accent-background even:bg-subtle-background">
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              "group not-[]:size-6 select-none relative cursor-pointer transition-opacity duration-200",
              popoverOpen ? "opacity-30" : "",
              isInactive ? "cross-lines-destructive" : ""
            )}
          >
            <img
              src={getShipLogoImage(participant.ship.ship_type)}
              alt={participant.ship.ship_name}
              width={32}
              height={32}
              className={
                isInactive ? "opacity-30"
                : !popoverOpen ?
                  "group-hover:opacity-30"
                : ""
              }
            />
            <span className="absolute inset-0 flex items-center justify-center pointer-events-none invisible group-hover:visible">
              <InfoIconSM className="shrink-0 size-3 text-foreground" />
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent side="left" className="w-72">
          <ShipDetailsCallout ship_type={participant.ship.ship_type} />
        </PopoverContent>
      </Popover>
      <div className="flex-1 flex flex-col gap-1 border-l border-accent px-ui-xs">
        <strong
          className={cn(
            "text-xs font-semibold",
            destroyed ? "text-destructive-foreground"
            : fled ? "text-warning"
            : ""
          )}
        >
          {participant.ship.ship_name}, {participant.name}
          {isInitiator ?
            <span className="ml-1 text-subtle text-xxs uppercase"> (Initiator)</span>
          : null}
        </strong>
        <footer className="flex flex-row items-center gap-2 uppercase text-xxs">
          {destroyed || fled ?
            <div className="inline-flex items-center gap-1 text-muted-foreground">
              <span className={cn("font-bold", destroyed ? "text-destructive-foreground" : "text-warning")}>
                {destroyed ? "Destroyed" : "Fled"}
              </span>
            </div>
          : <>
              <div className="inline-flex items-center gap-1 text-muted-foreground">
                <ShieldIcon className="size-4" weight="duotone" />
                <span
                  className={cn(getShieldColor(participant.ship.shield_integrity), "font-bold")}
                >
                  {participant.ship.shield_integrity.toFixed(0)}%
                </span>
                {typeof shieldsRemaining === "number" ?
                  <span className="text-foreground">({shieldsRemaining})</span>
                : null}
              </div>
              <DotDivider />
              <div className="inline-flex items-center gap-1 text-muted-foreground">
                <FighterIcon className="size-4" weight="duotone" />
                <span className="text-foreground font-bold">
                  {typeof fightersRemaining === "number" ? fightersRemaining : "???"}
                </span>{" "}
                {participant.ship.fighter_loss ?
                  <span className="text-warning">(-{participant.ship.fighter_loss})</span>
                : null}
              </div>
            </>
          }
          <div className="self-end inline-flex items-center gap-1 text-muted-foreground ml-auto">
            {PLAYER_TYPE_NAMES[participant.player_type]}
          </div>
        </footer>
      </div>
    </li>
  )
}

const CombatRoundSummaryPanel = ({ round }: { round: CombatRound | null }) => {
  if (!round) {
    return <BlankSlateTile text="No round selected" />
  }

  const outcomeRaw = round.round_result ?? round.result ?? round.end
  const outcome = outcomeRaw ? String(outcomeRaw).replace(/_/g, " ") : "continued"

  const destroyedCount = getRoundDestroyedCount(round)
  const fledCount = getRoundFledCount(round)
  const paidCount = getRoundPaidCount(round)
  const totalHits = sumRecordValues(round.hits)
  const totalLosses =
    sumRecordValues(round.offensive_losses) + sumRecordValues(round.defensive_losses)
  const totalShieldLoss = sumRecordValues(round.shield_loss)
  const actions = Object.entries(round.actions ?? {})

  return (
    <div className="flex flex-col gap-ui-sm">
      <section className="p-ui-sm bg-accent-background/60 border border-accent bracket bracket-offset-0">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-bold uppercase text-foreground">Round {round.round}</span>
          <span className={cn("text-xxs uppercase font-bold", getRoundOutcomeTone(outcome))}>
            {outcome}
          </span>
        </div>
      </section>

      <section className="grid grid-cols-3 gap-ui-xs text-xxs uppercase">
        <div className="p-ui-xs bg-subtle-background border border-accent flex flex-col gap-1 items-center justify-center">
          <span className="text-muted-foreground">Destroyed</span>
          <span className="text-destructive font-bold text-sm leading-none">{destroyedCount}</span>
        </div>
        <div className="p-ui-xs bg-subtle-background border border-accent flex flex-col gap-1 items-center justify-center">
          <span className="text-muted-foreground">Fled</span>
          <span className="text-warning font-bold text-sm leading-none">{fledCount}</span>
        </div>
        <div className="p-ui-xs bg-subtle-background border border-accent flex flex-col gap-1 items-center justify-center">
          <span className="text-muted-foreground">Paid</span>
          <span className="text-success font-bold text-sm leading-none">{paidCount}</span>
        </div>
      </section>

      <section className="p-ui-sm bg-card border border-accent flex flex-col gap-ui-xs">
        <DottedTitle title="Round Totals" />
        <div className="grid grid-cols-3 gap-ui-xs text-xxs uppercase">
          <div className="p-ui-xs bg-subtle-background border border-accent text-center">
            <div className="text-muted-foreground">Hits</div>
            <div className="text-foreground font-bold">{totalHits}</div>
          </div>
          <div className="p-ui-xs bg-subtle-background border border-accent text-center">
            <div className="text-muted-foreground">Losses</div>
            <div className="text-warning font-bold">{totalLosses}</div>
          </div>
          <div className="p-ui-xs bg-subtle-background border border-accent text-center">
            <div className="text-muted-foreground">Shield Loss</div>
            <div className="text-destructive font-bold">{totalShieldLoss}</div>
          </div>
        </div>
      </section>

      <section className="p-ui-sm bg-card border border-accent flex flex-col gap-ui-xs">
        <DottedTitle title="Actions" />
        {actions.length > 0 ?
          <ul className="flex flex-col gap-ui-xs">
            {actions.map(([actor, action]) => {
              const actionLabel = action.action.toUpperCase()
              const target = action.target_id ?? action.target
              return (
                <li
                  key={`${actor}-${action.submitted_at}-${action.action}`}
                  className="p-ui-xs bg-subtle-background border border-accent flex flex-col gap-1 text-xxs uppercase"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-foreground font-bold truncate">{actor}</span>
                    <span className="text-accent-foreground">{actionLabel}</span>
                  </div>
                  <div className="flex items-center gap-ui-xs text-muted-foreground">
                    <span>Commit: {action.commit ?? 0}</span>
                    {target ?
                      <span className="truncate">Target: {target}</span>
                    : null}
                    {action.timed_out ?
                      <span className="text-warning">Timed out</span>
                    : null}
                  </div>
                </li>
              )
            })}
          </ul>
        : <BlankSlateTile text="No actions recorded for this round" />}
      </section>
    </div>
  )
}

export const CombatAsidePanel = () => {
  const setActiveSubPanel = useGameStore.use.setActiveSubPanel?.()
  const activeCombatSession = useGameStore.use.activeCombatSession?.()
  const combatRounds = useGameStore.use.combatRounds?.()
  const [selectedRound, setSelectedRound] = useState<CombatRound | null>(null)
  const latestCombatRound =
    combatRounds && combatRounds.length > 0 ? combatRounds[combatRounds.length - 1] : undefined
  const combatInitiator = activeCombatSession?.initiator
  const participantViews = useMemo(() => {
    if (!activeCombatSession?.participants?.length) {
      return []
    }

    const latestRoundParticipants = latestCombatRound?.participants ?? []
    const latestById = new Map<string, CombatParticipant>()
    const latestByName = new Map<string, CombatParticipant>()

    for (const participant of latestRoundParticipants) {
      if (participant.id) {
        latestById.set(participant.id, participant)
      }
      latestByName.set(participant.name, participant)
    }

    const views = activeCombatSession.participants.map((sessionParticipant) => {
      const latestParticipant =
        (sessionParticipant.id ? latestById.get(sessionParticipant.id) : undefined) ??
        latestByName.get(sessionParticipant.name)

      const participant: CombatParticipant =
        latestParticipant ?
          {
            ...sessionParticipant,
            ...latestParticipant,
            ship: {
              ...sessionParticipant.ship,
              ...latestParticipant.ship,
            },
          }
        : sessionParticipant

      const combatantId = latestParticipant?.id ?? sessionParticipant.id
      const fightersRemaining =
        combatantId ? (latestCombatRound?.fighters_remaining?.[combatantId] ?? null) : null
      const shieldsRemaining =
        combatantId ? (latestCombatRound?.shields_remaining?.[combatantId] ?? null) : null
      const destroyed = typeof fightersRemaining === "number" && fightersRemaining <= 0
      const fled = Boolean(combatantId && latestCombatRound?.flee_results?.[combatantId])

      const isInitiator =
        !!combatInitiator &&
        (participant.id === combatInitiator || participant.name === combatInitiator)

      return {
        participant,
        fightersRemaining,
        shieldsRemaining,
        destroyed,
        fled,
        isInitiator,
      }
    })

    // Keep original relative order, but force initiator row to top.
    views.sort((a, b) => {
      if (a.isInitiator === b.isInitiator) return 0
      return a.isInitiator ? -1 : 1
    })

    return views
  }, [activeCombatSession?.participants, combatInitiator, latestCombatRound])

  return (
    <>
      <Card variant="stripes" size="xs" className="border-0 border-b combat-border">
        <CardContent>
          Active combat engaged. Here, we show:
          <ul className="list-disc list-inside">
            <li>Combat round number</li>
            <li>Combat deadline</li>
            <li>Initiator</li>
            <li>Round action table</li>
          </ul>
        </CardContent>
        <CardContent className="flex flex-col gap-ui-xs">
          <DottedTitle title="Participants" textColor="text-foreground" />
          <ul className="flex flex-col bg-card flex-1">
            {participantViews.map(
              ({ participant, fightersRemaining, shieldsRemaining, destroyed, fled }) => (
                <CombatParticipant
                  key={participant.id ?? `${participant.name}:${participant.ship.ship_name}`}
                  participant={participant}
                  fightersRemaining={fightersRemaining}
                  shieldsRemaining={shieldsRemaining}
                  initiator={combatInitiator}
                  destroyed={destroyed}
                  fled={fled}
                />
              )
            )}
          </ul>
          <DottedTitle title="Round Actions" textColor="text-foreground" />
          <CombatRoundTablePanel
            onRowClick={(round) => {
              setSelectedRound(round)
              setActiveSubPanel("combat-round")
            }}
          />
        </CardContent>
      </Card>
      <RHSSubPanel>
        <CombatRoundSummaryPanel round={selectedRound ?? latestCombatRound ?? null} />
      </RHSSubPanel>
    </>
  )
}
