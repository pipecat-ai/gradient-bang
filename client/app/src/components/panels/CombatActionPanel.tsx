import { useEffect, useMemo, useRef, useState } from "react"

import { useStarfieldEvent } from "@gradient-bang/starfield"

import { BlankSlateTile } from "@/components/BlankSlates"
import { DottedTitle } from "@/components/DottedTitle"
import { PlayerFightersBadge, PlayerShieldsBadge } from "@/components/PlayerShipBadges"
import { Button } from "@/components/primitives/Button"
import { Card, CardContent } from "@/components/primitives/Card"
import { Input } from "@/components/primitives/Input"
import { Progress } from "@/components/primitives/Progress"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/primitives/Select"
import { useGameContext } from "@/hooks/useGameContext"
import useAudioStore from "@/stores/audio"
import useGameStore from "@/stores/game"
import { getRoundOutcome, getRoundOutcomeTone } from "@/utils/combat"
import { formatCurrency } from "@/utils/formatting"
import { cn } from "@/utils/tailwind"

const DEFAULT_ROUND_MS = 15_000

const readCombatValue = <T,>(
  values: Record<string, T> | undefined,
  keys: (string | null | undefined)[]
): T | undefined => {
  if (!values) return undefined
  for (const key of keys) {
    if (!key) continue
    if (key in values) return values[key]
  }
  return undefined
}

type PersonalRoundResult = {
  round: number
  action: string
  outcome: string
  target: string | null
  hits: number
  offensiveLosses: number
  defensiveLosses: number
  shieldLoss: number
  fightersRemaining: number | null
  shieldsRemaining: number | null
  fleeSuccess: boolean | null
}

type AttackTargetOption = {
  key: string
  id: string | null
  name: string | null
}

export const CombatActionPanel = () => {
  const { sendUserTextInput } = useGameContext()

  const playerId = useGameStore((state) => state.player?.id ?? null)
  const playerName = useGameStore((state) => state.player?.name ?? null)
  const ship = useGameStore((state) => state.ship)
  const activeCombatSession = useGameStore((state) => state.activeCombatSession)
  const combatRounds = useGameStore((state) => state.combatRounds)
  const combatActionReceipts = useGameStore((state) => state.combatActionReceipts)
  const lastCombatEnded = useGameStore((state) => state.lastCombatEnded)
  const [selectedAction, setSelectedAction] = useState<CombatActionType>("brace")
  const [attackCommit, setAttackCommit] = useState("10")
  const [selectedTargetKey, setSelectedTargetKey] = useState<string>("")
  const [tickNow, setTickNow] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const lastDamageNoticeRoundRef = useRef<string | null>(null)

  const { animateImpact } = useStarfieldEvent()

  useEffect(() => {
    if (!activeCombatSession?.deadline) return
    const timerId = window.setInterval(() => setTickNow(Date.now()), 250)
    return () => window.clearInterval(timerId)
  }, [activeCombatSession?.combat_id, activeCombatSession?.round, activeCombatSession?.deadline])

  const combatId = activeCombatSession?.combat_id ?? lastCombatEnded?.combat_id ?? null

  const timelineRounds = useMemo<(CombatRound | CombatEndedRound)[]>(() => {
    if (!combatId) return []

    const roundMap = new Map<number, CombatRound | CombatEndedRound>()

    for (const round of combatRounds) {
      if (round.combat_id === combatId) {
        roundMap.set(round.round, round)
      }
    }

    if (lastCombatEnded?.combat_id === combatId) {
      roundMap.set(lastCombatEnded.round, lastCombatEnded)
    }

    return Array.from(roundMap.values()).sort((a, b) => b.round - a.round)
  }, [combatId, combatRounds, lastCombatEnded])

  const personalRoundResults = useMemo<PersonalRoundResult[]>(() => {
    const results: PersonalRoundResult[] = []

    for (const round of timelineRounds) {
      const participant = round.participants?.find(
        (entry) => (playerId && entry.id === playerId) || (playerName && entry.name === playerName)
      )

      const action =
        (participant?.name ? round.actions?.[participant.name] : undefined) ??
        (participant?.id ? round.actions?.[participant.id] : undefined) ??
        (playerId ? round.actions?.[playerId] : undefined) ??
        (playerName ? round.actions?.[playerName] : undefined)

      if (!action) continue

      const keyCandidates = [participant?.id, participant?.name, playerId, playerName]
      const participantNameById = new Map<string, string>()
      for (const entry of round.participants ?? []) {
        if (entry.id) {
          participantNameById.set(entry.id, entry.name)
        }
      }
      const targetFromId =
        action.target_id ? (participantNameById.get(action.target_id) ?? action.target_id) : null
      const targetFromRaw =
        action.target ? (participantNameById.get(action.target) ?? action.target) : null

      const hits = readCombatValue(round.hits, keyCandidates) ?? 0
      const offensiveLosses = readCombatValue(round.offensive_losses, keyCandidates) ?? 0
      const defensiveLosses = readCombatValue(round.defensive_losses, keyCandidates) ?? 0
      const shieldLoss = readCombatValue(round.shield_loss, keyCandidates) ?? 0
      const fightersRemaining = readCombatValue(round.fighters_remaining, keyCandidates) ?? null
      const shieldsRemaining = readCombatValue(round.shields_remaining, keyCandidates) ?? null
      const fleeSuccess = readCombatValue(round.flee_results, keyCandidates) ?? null

      results.push({
        round: round.round,
        action: action.action.toUpperCase(),
        outcome: getRoundOutcome(round),
        target: targetFromId ?? targetFromRaw ?? null,
        hits,
        offensiveLosses,
        defensiveLosses,
        shieldLoss,
        fightersRemaining,
        shieldsRemaining,
        fleeSuccess,
      })
    }

    return results
  }, [playerId, playerName, timelineRounds])

  const latestPersonalResult = personalRoundResults[0]

  // Damage received effect
  useEffect(() => {
    if (!combatId || !latestPersonalResult || !activeCombatSession) return

    const roundKey = `${combatId}:${latestPersonalResult.round}`
    if (lastDamageNoticeRoundRef.current === roundKey) return

    lastDamageNoticeRoundRef.current = roundKey

    const damageTaken =
      latestPersonalResult.offensiveLosses +
      latestPersonalResult.defensiveLosses +
      latestPersonalResult.shieldLoss

    if (damageTaken <= 0) return

    // Damage received this round: play impact animation and sound
    animateImpact(0.015, 200, 1000, 100, 2000)
    const impactSounds = ["impact1", "impact2", "impact3", "impact4"] as const
    useAudioStore
      .getState()
      .playSound(impactSounds[Math.floor(Math.random() * impactSounds.length)], { volume: 1 })
  }, [combatId, latestPersonalResult, animateImpact, activeCombatSession])

  const pendingReceipt = useMemo(() => {
    if (!activeCombatSession) return null
    return [...combatActionReceipts]
      .reverse()
      .find(
        (receipt) =>
          receipt.combat_id === activeCombatSession.combat_id &&
          receipt.round === activeCombatSession.round
      )
  }, [activeCombatSession, combatActionReceipts])

  const deadlineMs = activeCombatSession?.deadline ? Date.parse(activeCombatSession.deadline) : NaN
  const currentMs =
    activeCombatSession?.current_time ? Date.parse(activeCombatSession.current_time) : NaN
  const totalMs =
    Number.isFinite(deadlineMs) && Number.isFinite(currentMs) && deadlineMs > currentMs ?
      deadlineMs - currentMs
    : DEFAULT_ROUND_MS
  const remainingMs = Number.isFinite(deadlineMs) ? Math.max(0, deadlineMs - tickNow) : 0
  const timerPercent =
    activeCombatSession ? Math.max(0, Math.min(100, (remainingMs / totalMs) * 100)) : 0
  const timerColor =
    timerPercent > 66 ? ("success" as const)
    : timerPercent > 33 ? ("warning" as const)
    : ("destructive" as const)

  const attackTargets = useMemo<AttackTargetOption[]>(
    () =>
      (activeCombatSession?.participants ?? [])
        .filter((participant) => {
          const isPlayerById = Boolean(playerId && participant.id === playerId)
          const isPlayerByName = Boolean(playerName && participant.name === playerName)
          return !isPlayerById && !isPlayerByName
        })
        .map((participant, index) => ({
          key: participant.id ?? participant.name ?? `target-${index}`,
          id: participant.id ?? null,
          name: participant.name ?? null,
        })),
    [activeCombatSession?.participants, playerId, playerName]
  )

  const selectedAttackTarget =
    attackTargets.find((target) => target.key === selectedTargetKey) ?? attackTargets[0] ?? null
  const currentFighters =
    typeof latestPersonalResult?.fightersRemaining === "number" ?
      latestPersonalResult.fightersRemaining
    : typeof ship.fighters === "number" ? ship.fighters
    : 0
  const currentShields =
    typeof latestPersonalResult?.shieldsRemaining === "number" ?
      latestPersonalResult.shieldsRemaining
    : typeof ship.shields === "number" ? ship.shields
    : 0
  const canAttack = currentFighters > 0
  const canBrace = currentShields > 0
  const canPayToll = Boolean(activeCombatSession?.garrison)
  const payTollAmount = activeCombatSession?.garrison?.toll_amount ?? null

  const handleSubmitAction = () => {
    if (!activeCombatSession) return
    setError(null)

    if (selectedAction === "attack" && !canAttack) {
      setError("Attack unavailable: no fighters remaining")
      return
    }
    if (selectedAction === "brace" && !canBrace) {
      setError("Brace unavailable: no shields remaining")
      return
    }
    if (selectedAction === "pay" && !canPayToll) {
      setError("Pay is unavailable for this round")
      return
    }

    const commit = Number.parseInt(attackCommit, 10)
    if (selectedAction === "attack" && (!Number.isFinite(commit) || commit <= 0)) {
      setError("Attack commit must be greater than 0")
      return
    }
    if (selectedAction === "attack" && !selectedAttackTarget) {
      setError("No valid target available for attack")
      return
    }
    if (selectedAction === "pay" && !canPayToll) {
      setError("Pay is unavailable for this round")
      return
    }

    const selectedTargetId = selectedAttackTarget?.id ?? selectedAttackTarget?.name ?? null

    const prompt =
      selectedAction === "attack" ?
        `In combat ${activeCombatSession.combat_id}, round ${activeCombatSession.round}, submit action attack with commit ${commit}${selectedTargetId ? ` targeting ${selectedTargetId}` : ""}.`
      : `In combat ${activeCombatSession.combat_id}, round ${activeCombatSession.round}, submit action ${selectedAction}.`

    sendUserTextInput(prompt)
  }

  if (!activeCombatSession) {
    return (
      <Card size="sm" className="h-full relative z-10">
        <CardContent className="h-full flex items-center justify-center">
          <BlankSlateTile text="Combat action panel is active once a combat session starts" />
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="relative z-10 h-full flex flex-col gap-ui-sm">
      <Card size="xs" className="border border-accent">
        <CardContent className="flex items-center justify-between gap-ui-sm">
          <div className="text-xxs uppercase text-subtle-foreground">
            Combat | round {activeCombatSession.round}
          </div>
          <div className="text-xxs uppercase text-foreground">
            {activeCombatSession.deadline ? `${Math.ceil(remainingMs / 1000)}s` : "No deadline"}
          </div>
        </CardContent>
        <CardContent>
          <Progress value={timerPercent} color={timerColor} className="h-2" />
        </CardContent>
      </Card>

      <section className="grid grid-cols-1 xl:grid-cols-2 gap-ui-sm min-h-0 flex-1">
        <Card size="sm" className="border border-accent min-h-0">
          <CardContent className="flex flex-col gap-ui-sm">
            <DottedTitle title="Your Ship Status" textColor="text-foreground" />
            <div className="text-xs uppercase text-subtle-foreground">
              {ship.ship_name}, {ship.ship_type?.replace(/_/g, " ")}
            </div>
            <div className="flex flex-row gap-ui-xs">
              <PlayerShieldsBadge className="flex-1" />
              <PlayerFightersBadge className="flex-1" />
            </div>
            <div className="grid grid-cols-3 gap-ui-xs text-xxs uppercase">
              <div className="p-ui-xs border border-accent bg-subtle-background text-center">
                <div className="text-muted-foreground">Round Fighters</div>
                <div className="text-foreground font-bold">
                  {typeof latestPersonalResult?.fightersRemaining === "number" ?
                    latestPersonalResult.fightersRemaining
                  : "—"}
                </div>
              </div>
              <div className="p-ui-xs border border-accent bg-subtle-background text-center">
                <div className="text-muted-foreground">Round Shields</div>
                <div className="text-foreground font-bold">
                  {typeof latestPersonalResult?.shieldsRemaining === "number" ?
                    latestPersonalResult.shieldsRemaining
                  : "—"}
                </div>
              </div>
              <div className="p-ui-xs border border-accent bg-subtle-background text-center">
                <div className="text-muted-foreground">Flee</div>
                <div className="text-foreground font-bold">
                  {typeof latestPersonalResult?.fleeSuccess === "boolean" ?
                    latestPersonalResult.fleeSuccess ?
                      "Success"
                    : "Failed"
                  : "—"}
                </div>
              </div>
            </div>
          </CardContent>

          <CardContent className="flex flex-col gap-ui-sm border-t border-accent">
            <DottedTitle title="Choose Action" textColor="text-foreground" />
            <div className="grid grid-cols-2 gap-ui-xs">
              {(["brace", "attack", "flee", "pay"] as const).map((action) => (
                <Button
                  key={action}
                  variant={selectedAction === action ? "default" : "secondary"}
                  size="sm"
                  disabled={
                    (action === "attack" && !canAttack) ||
                    (action === "brace" && !canBrace) ||
                    (action === "pay" && !canPayToll)
                  }
                  onClick={() => {
                    setSelectedAction(action)
                    setError(null)
                  }}
                >
                  {action}
                </Button>
              ))}
            </div>

            {selectedAction === "attack" ?
              <div className="flex flex-col gap-ui-xs">
                <Select
                  value={selectedAttackTarget?.key ?? ""}
                  onValueChange={(value) => {
                    setSelectedTargetKey(value)
                    setError(null)
                  }}
                  disabled={attackTargets.length === 0}
                >
                  <SelectTrigger size="sm" className="w-full">
                    <SelectValue placeholder="Select a target" />
                  </SelectTrigger>
                  <SelectContent>
                    {attackTargets.map((target) => (
                      <SelectItem key={target.key} value={target.key}>
                        {target.name ?? target.id ?? "Unknown target"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  type="number"
                  min={1}
                  size="sm"
                  value={attackCommit}
                  onChange={(event) => {
                    setAttackCommit(event.target.value)
                    setError(null)
                  }}
                  placeholder="Commit"
                />
                <div className="text-xxs uppercase text-subtle-foreground">
                  Target:{" "}
                  {selectedAttackTarget ?
                    `${selectedAttackTarget.name ?? selectedAttackTarget.id ?? "Unknown"}${selectedAttackTarget.id ? ` (${selectedAttackTarget.id})` : ""}`
                  : "No target found"}
                </div>
              </div>
            : selectedAction === "pay" ?
              <div className="p-ui-xs border border-accent bg-subtle-background text-xxs uppercase text-subtle-foreground">
                Toll:{" "}
                <span className="text-foreground font-bold">
                  {typeof payTollAmount === "number" ?
                    `${formatCurrency(payTollAmount, "standard")} credits`
                  : "No toll available"}
                </span>
              </div>
            : null}

            {error ?
              <div className="text-xxs uppercase text-destructive">{error}</div>
            : null}

            <Button
              size="sm"
              onClick={handleSubmitAction}
              disabled={
                (selectedAction === "attack" &&
                  (!canAttack ||
                    Number.parseInt(attackCommit, 10) <= 0 ||
                    attackTargets.length === 0)) ||
                (selectedAction === "brace" && !canBrace) ||
                (selectedAction === "pay" && !canPayToll)
              }
            >
              Submit {selectedAction}
            </Button>

            <div className="text-xxs uppercase text-subtle-foreground">
              {pendingReceipt ?
                `Pending ack: ${pendingReceipt.action} (commit ${pendingReceipt.commit})`
              : "No pending action receipt for this round"}
            </div>
          </CardContent>
        </Card>

        <Card size="sm" className="border border-accent min-h-0">
          <CardContent className="flex flex-col gap-ui-sm h-full min-h-0">
            <DottedTitle title="Your Round Results" textColor="text-foreground" />
            {personalRoundResults.length === 0 ?
              <BlankSlateTile text="No personal round results yet" />
            : <ul className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-ui-xs">
                {personalRoundResults.map((result) => (
                  <li
                    key={`combat-round-${result.round}`}
                    className="p-ui-xs border border-accent bg-subtle-background flex flex-col gap-ui-xs"
                  >
                    <div className="flex items-center justify-between gap-ui-xs">
                      <span className="text-xs uppercase font-bold text-foreground">
                        Round {result.round}
                      </span>
                      <span className="text-xxs uppercase text-muted-foreground">
                        Action: {result.action}
                      </span>
                      <span
                        className={cn(
                          "text-xxs uppercase font-bold",
                          getRoundOutcomeTone(result.outcome)
                        )}
                      >
                        {result.outcome}
                      </span>
                    </div>
                    <div className="text-xxs uppercase text-subtle-foreground truncate">
                      Target: {result.target ?? "—"}
                    </div>
                    <div className="grid grid-cols-3 gap-ui-xs text-xxs uppercase">
                      <div className="border border-accent bg-card p-1 text-center">
                        <div className="text-muted-foreground">Hits on Target</div>
                        <div className="font-bold text-foreground">{result.hits}</div>
                      </div>
                      <div className="border border-accent bg-card p-1 text-center">
                        <div className="text-muted-foreground">Off Loss</div>
                        <div className="font-bold text-warning">{result.offensiveLosses}</div>
                      </div>
                      <div className="border border-accent bg-card p-1 text-center">
                        <div className="text-muted-foreground">Def Loss</div>
                        <div className="font-bold text-warning">{result.defensiveLosses}</div>
                      </div>
                      <div className="border border-accent bg-card p-1 text-center">
                        <div className="text-muted-foreground">Shield Loss</div>
                        <div className="font-bold text-destructive">{result.shieldLoss}</div>
                      </div>
                      <div className="border border-accent bg-card p-1 text-center">
                        <div className="text-muted-foreground">Fighters</div>
                        <div className="font-bold text-foreground">
                          {result.fightersRemaining ?? "—"}
                        </div>
                      </div>
                      <div className="border border-accent bg-card p-1 text-center">
                        <div className="text-muted-foreground">Shields</div>
                        <div className="font-bold text-foreground">
                          {result.shieldsRemaining ?? "—"}
                        </div>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            }
          </CardContent>
        </Card>
      </section>
    </div>
  )
}
