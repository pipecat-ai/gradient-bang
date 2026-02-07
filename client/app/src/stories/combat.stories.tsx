import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import type { Story } from "@ladle/react"

import {
  COMBAT_COLLECT_STATUS_UPDATE_PAYLOAD_MOCK,
  COMBAT_ROUND_WAITING_PAYLOAD_MOCK,
  COMBAT_SECTOR_UPDATE_FULL_PAYLOAD_MOCK,
} from "@/mocks/combat.mock"
import useGameStore from "@/stores/game"

const DEFAULT_ROUND_DURATION_SECONDS = 15

const buildDeadlineIso = (seconds: number) =>
  new Date(Date.now() + Math.max(1, seconds) * 1000).toISOString()

const JsonCard = ({ title, value }: { title: string; value: unknown }) => {
  return (
    <section className="rounded-sm border border-border/70 bg-card/60 p-3 min-h-0">
      <h3 className="text-xs uppercase tracking-wider text-subtle-foreground mb-2">{title}</h3>
      <pre className="text-xs leading-relaxed overflow-auto max-h-[280px] whitespace-pre-wrap break-all">
        {JSON.stringify(value ?? null, null, 2)}
      </pre>
    </section>
  )
}

const Stat = ({ label, value }: { label: string; value: string | number | boolean | null }) => (
  <div className="rounded-sm border border-border/50 bg-background/50 px-2 py-1.5">
    <div className="text-[10px] uppercase tracking-wider text-subtle-foreground">{label}</div>
    <div className="text-xs font-medium break-all">{value === null ? "null" : String(value)}</div>
  </div>
)

const readParticipantValue = <T,>(
  data: Record<string, T> | undefined,
  participant: CombatParticipant
): T | undefined => {
  if (!data) return undefined
  const candidateKeys = [participant.id, participant.name].filter(Boolean) as string[]
  for (const key of candidateKeys) {
    if (key in data) return data[key]
  }
  return undefined
}

const ParticipantCard = ({
  participant,
  latestRound,
  isPlayer,
}: {
  participant: CombatParticipant
  latestRound: CombatRound | CombatEndedRound | null
  isPlayer: boolean
}) => {
  const hits = readParticipantValue(latestRound?.hits, participant)
  const offensiveLosses = readParticipantValue(latestRound?.offensive_losses, participant)
  const defensiveLosses = readParticipantValue(latestRound?.defensive_losses, participant)
  const shieldLoss = readParticipantValue(latestRound?.shield_loss, participant)
  const fightersRemaining = readParticipantValue(latestRound?.fighters_remaining, participant)
  const shieldsRemaining = readParticipantValue(latestRound?.shields_remaining, participant)
  const fleeResult = readParticipantValue(latestRound?.flee_results, participant)
  const action = readParticipantValue(latestRound?.actions, participant)

  return (
    <section className="rounded-sm border border-border/70 bg-card/70 p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold leading-tight">{participant.name}</h3>
          <div className="text-xs text-subtle-foreground">
            {participant.player_type} | {participant.ship.ship_name} ({participant.ship.ship_type})
          </div>
        </div>
        {isPlayer && (
          <span className="inline-flex rounded-sm border border-primary/40 bg-primary/15 px-2 py-1 text-[10px] uppercase tracking-wider text-primary">
            You
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Stat label="Participant ID" value={participant.id ?? "unknown"} />
        <Stat label="Created At" value={participant.created_at} />
        <Stat label="Shield Integrity" value={participant.ship.shield_integrity} />
        <Stat label="Snapshot Shield Damage" value={participant.ship.shield_damage ?? 0} />
        <Stat label="Snapshot Fighter Loss" value={participant.ship.fighter_loss ?? 0} />
        <Stat label="Round" value={latestRound?.round ?? "-"} />
        <Stat label="Hits Dealt" value={hits ?? "-"} />
        <Stat label="Offensive Losses" value={offensiveLosses ?? "-"} />
        <Stat label="Defensive Losses" value={defensiveLosses ?? "-"} />
        <Stat label="Shield Loss" value={shieldLoss ?? "-"} />
        <Stat label="Fighters Remaining" value={fightersRemaining ?? "-"} />
        <Stat label="Shields Remaining" value={shieldsRemaining ?? "-"} />
        <Stat label="Flee Result" value={typeof fleeResult === "boolean" ? fleeResult : "-"} />
        <Stat label="Action" value={action?.action ?? "-"} />
        <Stat label="Commit" value={action?.commit ?? "-"} />
        <Stat label="Timed Out" value={action?.timed_out ?? "-"} />
        <Stat label="Target" value={action?.target ?? action?.target_id ?? "-"} />
        <Stat label="Destination Sector" value={action?.destination_sector ?? "-"} />
      </div>
    </section>
  )
}

const roundProfileForAction = (action: CombatActionType) => {
  switch (action) {
    case "attack":
      return { myHits: 8, myOffLosses: 3, myDefLosses: 4, myShieldLoss: 3, enemyHits: 5 }
    case "brace":
      return { myHits: 1, myOffLosses: 1, myDefLosses: 2, myShieldLoss: 1, enemyHits: 3 }
    case "flee":
      return { myHits: 0, myOffLosses: 0, myDefLosses: 1, myShieldLoss: 0, enemyHits: 1 }
    case "pay":
      return { myHits: 0, myOffLosses: 0, myDefLosses: 0, myShieldLoss: 0, enemyHits: 0 }
    default:
      return { myHits: 0, myOffLosses: 0, myDefLosses: 0, myShieldLoss: 0, enemyHits: 0 }
  }
}

const COMBAT_ACTIVITY_TYPES = new Set([
  "combat.session.started",
  "combat.action.accepted",
  "combat.round.resolved",
  "combat.session.ended",
  "ship.destroyed",
  "salvage.created",
  "salvage.collected",
  "garrison.deployed",
  "garrison.collected",
  "garrison.mode_changed",
  "garrison.character_moved",
  "error",
])

export const CombatFlowStory: Story = () => {
  const uiState = useGameStore((state) => state.uiState)
  const activeCombatSession = useGameStore((state) => state.activeCombatSession)
  const combatRounds = useGameStore((state) => state.combatRounds)
  const combatActionReceipts = useGameStore((state) => state.combatActionReceipts)
  const lastCombatEnded = useGameStore((state) => state.lastCombatEnded)
  const combatHistory = useGameStore((state) => state.combatHistory)
  const activityLog = useGameStore((state) => state.activity_log)
  const sector = useGameStore((state) => state.sector)
  const player = useGameStore((state) => state.player)
  const ship = useGameStore((state) => state.ship)

  const resetCombatState = useGameStore((state) => state.resetCombatState)
  const setUIState = useGameStore((state) => state.setUIState)
  const setPlayer = useGameStore((state) => state.setPlayer)
  const setShip = useGameStore((state) => state.setShip)
  const setSector = useGameStore((state) => state.setSector)
  const [roundDurationSeconds, setRoundDurationSeconds] = useState(
    DEFAULT_ROUND_DURATION_SECONDS
  )
  const [tickNow, setTickNow] = useState(Date.now())
  const timeoutHandledRef = useRef<string | null>(null)

  useEffect(() => {
    resetCombatState()
    setUIState("idle")
    setPlayer(COMBAT_COLLECT_STATUS_UPDATE_PAYLOAD_MOCK.player)
    setShip(COMBAT_COLLECT_STATUS_UPDATE_PAYLOAD_MOCK.ship)
    setSector(COMBAT_SECTOR_UPDATE_FULL_PAYLOAD_MOCK)
  }, [resetCombatState, setPlayer, setSector, setShip, setUIState])

  const latestRound =
    combatRounds.length > 0 ? combatRounds[combatRounds.length - 1]
    : (lastCombatEnded ?? null)
  const participants =
    activeCombatSession?.participants ??
    latestRound?.participants ??
    (lastCombatEnded?.participants ?? [])
  const currentCombatId =
    activeCombatSession?.combat_id ??
    lastCombatEnded?.combat_id ??
    latestRound?.combat_id ??
    null
  const timelineRounds = useMemo(() => {
    if (!currentCombatId) return []

    const roundMap = new Map<number, CombatRound | CombatEndedRound>()
    for (const round of combatRounds) {
      if (round.combat_id === currentCombatId) {
        roundMap.set(round.round, round)
      }
    }

    if (lastCombatEnded?.combat_id === currentCombatId) {
      roundMap.set(lastCombatEnded.round, lastCombatEnded)
    }

    return Array.from(roundMap.values()).sort((a, b) => a.round - b.round)
  }, [combatRounds, currentCombatId, lastCombatEnded])
  const combatActivity = useMemo(
    () =>
      activityLog
        .filter((entry) => COMBAT_ACTIVITY_TYPES.has(entry.type) || entry.type.startsWith("combat."))
        .slice(-100),
    [activityLog]
  )
  const activeRoundKey =
    activeCombatSession ? `${activeCombatSession.combat_id}:${activeCombatSession.round}` : null
  const remainingMs = useMemo(() => {
    if (!activeCombatSession?.deadline) return 0
    return Math.max(0, new Date(activeCombatSession.deadline).getTime() - tickNow)
  }, [activeCombatSession?.deadline, tickNow])
  const remainingSeconds = Math.ceil(remainingMs / 1000)

  const startMockCombat = useCallback(() => {
    const state = useGameStore.getState()
    const nowIso = new Date().toISOString()
    const seededSession: CombatSession = {
      ...COMBAT_ROUND_WAITING_PAYLOAD_MOCK,
      round: 1,
      current_time: nowIso,
      deadline: buildDeadlineIso(roundDurationSeconds),
    }

    timeoutHandledRef.current = null
    state.resetCombatState()
    state.setUIState("combat")
    state.setActiveCombatSession(seededSession)
    state.addActivityLogEntry({
      type: "combat.session.started",
      message: `Mock combat started in sector ${seededSession.sector.id}`,
    })
  }, [roundDurationSeconds])

  const submitMockAction = useCallback((action: CombatActionType) => {
    const state = useGameStore.getState()
    const session = state.activeCombatSession
    if (!session) return

    const playerId =
      state.player?.id ??
      session.participants.find((participant) => participant.id)?.id ??
      "player"
    const primaryTargetId =
      session.participants.find((participant) => participant.id && participant.id !== playerId)?.id ??
      null
    const commitBase = action === "attack" ? Math.max(10, Math.floor((state.ship?.fighters ?? 60) / 2)) : 0
    const roundReceiptCount = state.combatActionReceipts.filter(
      (receipt) => receipt.combat_id === session.combat_id && receipt.round === session.round
    ).length

    state.addCombatActionReceipt({
      combat_id: session.combat_id,
      round: session.round,
      action,
      commit: commitBase + roundReceiptCount,
      target_id: action === "attack" ? primaryTargetId : null,
    })

    state.addActivityLogEntry({
      type: "combat.action.accepted",
      message: `Mock action queued: [${action}] for round ${session.round}`,
    })
  }, [])

  const resolveMockRound = useCallback((timedOut = false) => {
    const state = useGameStore.getState()
    const session = state.activeCombatSession
    if (!session) return

    const playerId = state.player?.id ?? session.participants.find((participant) => participant.id)?.id
    const playerName =
      state.player?.name ??
      session.participants.find((participant) => participant.id === playerId)?.name ??
      "Player"
    const opponent = session.participants.find(
      (participant) => participant.id && participant.id !== playerId
    )
    const lastReceipt = [...state.combatActionReceipts]
      .reverse()
      .find((receipt) => receipt.combat_id === session.combat_id && receipt.round === session.round)
    const chosenAction: CombatActionType = lastReceipt?.action ?? "brace"
    const profile = roundProfileForAction(chosenAction)
    const previousRound = [...state.combatRounds]
      .reverse()
      .find((round) => round.combat_id === session.combat_id)

    const participantIds = session.participants
      .map((participant) => participant.id)
      .filter((id): id is string => Boolean(id))
    const ids = [...participantIds]
    if (playerId && !ids.includes(playerId)) ids.push(playerId)
    if (opponent?.id && !ids.includes(opponent.id)) ids.push(opponent.id)

    const hits: Record<string, number> = {}
    const offensive_losses: Record<string, number> = {}
    const defensive_losses: Record<string, number> = {}
    const shield_loss: Record<string, number> = {}
    const fighters_remaining: Record<string, number> = {}
    const shields_remaining: Record<string, number> = {}
    const flee_results: Record<string, boolean> = {}

    for (const id of ids) {
      const prevFighters = previousRound?.fighters_remaining[id] ?? 100
      const prevShields = previousRound?.shields_remaining[id] ?? 100
      hits[id] = 0
      offensive_losses[id] = 0
      defensive_losses[id] = 0
      shield_loss[id] = 0
      fighters_remaining[id] = prevFighters
      shields_remaining[id] = prevShields
      flee_results[id] = false
    }

    if (playerId) {
      hits[playerId] = profile.myHits
      offensive_losses[playerId] = profile.myOffLosses
      defensive_losses[playerId] = profile.myDefLosses
      shield_loss[playerId] = profile.myShieldLoss
      fighters_remaining[playerId] = Math.max(
        0,
        (fighters_remaining[playerId] ?? 100) - profile.myOffLosses - profile.myDefLosses
      )
      shields_remaining[playerId] = Math.max(
        0,
        (shields_remaining[playerId] ?? 100) - profile.myShieldLoss
      )
      flee_results[playerId] = chosenAction === "flee"
    }

    if (opponent?.id) {
      hits[opponent.id] = profile.enemyHits
      offensive_losses[opponent.id] = Math.max(1, Math.floor(profile.enemyHits / 2))
      defensive_losses[opponent.id] = Math.max(1, profile.myHits)
      shield_loss[opponent.id] = Math.max(0, Math.floor(profile.myHits / 2))
      fighters_remaining[opponent.id] = Math.max(
        0,
        (fighters_remaining[opponent.id] ?? 100) -
          offensive_losses[opponent.id] -
          defensive_losses[opponent.id]
      )
      shields_remaining[opponent.id] = Math.max(
        0,
        (shields_remaining[opponent.id] ?? 100) - shield_loss[opponent.id]
      )
    }

    let endResult: string | null = null
    if (chosenAction === "flee") {
      endResult = `${playerName}_fled`
    } else if (chosenAction === "pay" && session.garrison?.mode === "toll") {
      endResult = "toll_satisfied"
    } else if (session.round >= 3) {
      endResult = "victory"
    }

    const resolvedActions: Record<string, CombatAction> = {}
    resolvedActions[playerName] = {
      action: chosenAction,
      commit: lastReceipt?.commit ?? 0,
      timed_out: timedOut,
      submitted_at: new Date().toISOString(),
      target: lastReceipt?.target_id ?? null,
      target_id: lastReceipt?.target_id ?? null,
      destination_sector: chosenAction === "flee" ? session.sector.id + 1 : null,
    }
    if (opponent) {
      resolvedActions[opponent.name] = {
        action: "attack",
        commit: 20,
        timed_out: false,
        submitted_at: new Date().toISOString(),
        target: playerId ?? null,
        target_id: playerId ?? null,
        destination_sector: null,
      }
    }

    const resolvedRound: CombatRound = {
      combat_id: session.combat_id,
      sector: { id: session.sector.id },
      round: session.round,
      hits,
      offensive_losses,
      defensive_losses,
      shield_loss,
      fighters_remaining,
      shields_remaining,
      flee_results,
      actions: resolvedActions,
      participants: session.participants,
      garrison: session.garrison ?? null,
      deadline: session.deadline,
      end: endResult,
      result: endResult,
      round_result: endResult,
    }

    state.addCombatRound(resolvedRound)
    state.addActivityLogEntry({
      type: "combat.round.resolved",
      message: `Mock round ${session.round} resolved (${timedOut ? "timeout" : chosenAction})`,
    })

    if (endResult) {
      const endedRound: CombatEndedRound = {
        ...resolvedRound,
        salvage: [],
        logs: [
          {
            round_number: resolvedRound.round,
            actions: resolvedActions,
            hits,
            offensive_losses,
            defensive_losses,
            shield_loss,
            result: endResult,
            timestamp: new Date().toISOString(),
          },
        ],
      }

      state.addCombatHistory(endedRound)
      state.setLastCombatEnded(endedRound)
      state.endActiveCombatSession()
      state.setUIState("idle")
      state.addActivityLogEntry({
        type: "combat.session.ended",
        message: `Mock combat ended with result [${endResult}]`,
      })
      return
    }

    const updatedParticipants = session.participants.map((participant) => {
      const participantId = participant.id
      if (!participantId) return participant
      const nextFighters = defensive_losses[participantId] ?? participant.ship.fighter_loss ?? 0
      const nextShieldLoss = shield_loss[participantId] ?? participant.ship.shield_damage ?? 0
      return {
        ...participant,
        ship: {
          ...participant.ship,
          fighter_loss: nextFighters,
          shield_damage: nextShieldLoss,
        },
      }
    })

    state.updateActiveCombatSession({
      round: session.round + 1,
      current_time: new Date().toISOString(),
      deadline: buildDeadlineIso(roundDurationSeconds),
      participants: updatedParticipants,
      garrison: session.garrison ?? null,
    })
  }, [roundDurationSeconds])

  const resetMockCombat = useCallback(() => {
    const state = useGameStore.getState()
    timeoutHandledRef.current = null
    state.resetCombatState()
    state.setUIState("idle")
  }, [])

  const endMockCombatNow = useCallback(() => {
    const state = useGameStore.getState()
    const session = state.activeCombatSession
    if (!session) return
    state.endActiveCombatSession()
    state.setUIState("idle")
    state.addActivityLogEntry({
      type: "combat.session.ended",
      message: `Mock combat force-ended in round ${session.round}`,
    })
  }, [])

  const timerPercent = useMemo(() => {
    if (!activeCombatSession) return 0
    const totalMs = Math.max(1, roundDurationSeconds * 1000)
    return Math.max(0, Math.min(100, (remainingMs / totalMs) * 100))
  }, [activeCombatSession, roundDurationSeconds, remainingMs])

  useEffect(() => {
    if (!activeCombatSession) return
    const id = window.setInterval(() => setTickNow(Date.now()), 250)
    return () => window.clearInterval(id)
  }, [activeCombatSession?.combat_id, activeCombatSession?.round, activeCombatSession?.deadline])

  useEffect(() => {
    if (!activeCombatSession || !activeRoundKey) return
    if (remainingMs > 0) return
    if (timeoutHandledRef.current === activeRoundKey) return
    timeoutHandledRef.current = activeRoundKey
    resolveMockRound(true)
  }, [activeCombatSession, activeRoundKey, remainingMs, resolveMockRound])

  return (
    <div className="h-screen bg-background text-foreground p-4 overflow-auto">
      <header className="mb-4">
        <h2 className="text-lg font-medium">Combat Story</h2>
        <p className="text-sm text-subtle-foreground">
          Use the mock control panel (or Leva Combat controls) to step actions and rounds. Top card
          is your ship, then each combatant card shows round/action internals.
        </p>
      </header>

      <div className="mb-4 text-sm text-subtle-foreground border border-border/60 rounded-sm bg-card/40 p-3">
        uiState: <span className="text-foreground">{uiState}</span> | rounds:{" "}
        <span className="text-foreground">{combatRounds.length}</span> | receipts:{" "}
        <span className="text-foreground">{combatActionReceipts.length}</span> | history:{" "}
        <span className="text-foreground">{combatHistory.length}</span> | active combat:{" "}
        <span className="text-foreground">{activeCombatSession ? "yes" : "no"}</span>
      </div>

      <section className="rounded-sm border border-border/70 bg-card/70 p-3 mb-4">
        <div className="mb-3">
          <h3 className="text-sm font-semibold leading-tight">Mock Combat Controls</h3>
          <div className="text-xs text-subtle-foreground">
            Use this panel to simulate actions and rounds without server traffic.
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
          <Stat label="Combat ID" value={activeCombatSession?.combat_id ?? "none"} />
          <Stat label="Current Round" value={activeCombatSession?.round ?? "-"} />
          <Stat label="Round Timer" value={activeCombatSession ? `${remainingSeconds}s` : "inactive"} />
          <Stat label="Deadline" value={activeCombatSession?.deadline ?? "n/a"} />
        </div>

        <div className="mb-3">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-subtle-foreground">
            Round Countdown
          </div>
          <div className="h-2 rounded-sm border border-border/50 bg-background/40 overflow-hidden">
            <div
              className="h-full bg-primary/70 transition-[width] duration-200"
              style={{ width: `${timerPercent}%` }}
            />
          </div>
        </div>

        <div className="mb-3 flex items-center gap-2 text-xs">
          <label htmlFor="roundDuration" className="text-subtle-foreground uppercase tracking-wider">
            Round Duration (s)
          </label>
          <input
            id="roundDuration"
            type="number"
            min={3}
            max={120}
            step={1}
            value={roundDurationSeconds}
            onChange={(event) => {
              const next = Number(event.target.value)
              setRoundDurationSeconds(Number.isFinite(next) ? Math.max(3, Math.min(120, next)) : 15)
            }}
            className="w-20 rounded-sm border border-border bg-background px-2 py-1 text-foreground"
          />
        </div>

        <div className="mb-3 flex flex-wrap gap-2">
          <button
            className="rounded-sm border border-border bg-background/70 px-3 py-1 text-xs hover:bg-background"
            onClick={startMockCombat}
          >
            Start / Restart Combat
          </button>
          <button
            className="rounded-sm border border-border bg-background/70 px-3 py-1 text-xs hover:bg-background disabled:opacity-50"
            onClick={() => resolveMockRound(false)}
            disabled={!activeCombatSession}
          >
            Resolve Round Now
          </button>
          <button
            className="rounded-sm border border-border bg-background/70 px-3 py-1 text-xs hover:bg-background disabled:opacity-50"
            onClick={endMockCombatNow}
            disabled={!activeCombatSession}
          >
            End Combat
          </button>
          <button
            className="rounded-sm border border-border bg-background/70 px-3 py-1 text-xs hover:bg-background"
            onClick={resetMockCombat}
          >
            Reset Combat State
          </button>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            className="rounded-sm border border-border bg-background/70 px-3 py-1 text-xs hover:bg-background disabled:opacity-50"
            onClick={() => submitMockAction("attack")}
            disabled={!activeCombatSession}
          >
            Mock Attack
          </button>
          <button
            className="rounded-sm border border-border bg-background/70 px-3 py-1 text-xs hover:bg-background disabled:opacity-50"
            onClick={() => submitMockAction("brace")}
            disabled={!activeCombatSession}
          >
            Mock Brace
          </button>
          <button
            className="rounded-sm border border-border bg-background/70 px-3 py-1 text-xs hover:bg-background disabled:opacity-50"
            onClick={() => submitMockAction("flee")}
            disabled={!activeCombatSession}
          >
            Mock Flee
          </button>
          <button
            className="rounded-sm border border-border bg-background/70 px-3 py-1 text-xs hover:bg-background disabled:opacity-50"
            onClick={() => submitMockAction("pay")}
            disabled={!activeCombatSession}
          >
            Mock Pay
          </button>
        </div>

        <div className="mt-4 border-t border-border/50 pt-3 grid grid-cols-1 xl:grid-cols-2 gap-3">
          <div className="rounded-sm border border-border/60 bg-background/30 p-3">
            <h4 className="text-xs uppercase tracking-wider text-subtle-foreground mb-2">
              Round Summary Log
            </h4>
            {timelineRounds.length === 0 && (
              <div className="text-xs text-subtle-foreground">
                No rounds yet. Start combat and resolve rounds to build a timeline.
              </div>
            )}
            <div className="space-y-2 max-h-[380px] overflow-auto pr-1">
              {timelineRounds.map((round) => {
                const actionRows = Object.entries(round.actions ?? {})
                const metricKeys = Array.from(
                  new Set([
                    ...Object.keys(round.hits ?? {}),
                    ...Object.keys(round.offensive_losses ?? {}),
                    ...Object.keys(round.defensive_losses ?? {}),
                    ...Object.keys(round.shield_loss ?? {}),
                    ...Object.keys(round.fighters_remaining ?? {}),
                    ...Object.keys(round.shields_remaining ?? {}),
                    ...Object.keys(round.flee_results ?? {}),
                  ])
                )

                return (
                  <article
                    key={`${round.combat_id}:${round.round}`}
                    className="rounded-sm border border-border/50 bg-card/40 p-2"
                  >
                    <div className="mb-2 text-xs text-subtle-foreground">
                      <span className="text-foreground font-medium">Round {round.round}</span>
                      {" | "}result:{" "}
                      <span className="text-foreground">{round.round_result ?? round.result ?? "none"}</span>
                    </div>

                    <div className="mb-2">
                      <div className="text-[10px] uppercase tracking-wider text-subtle-foreground mb-1">
                        Who Did What
                      </div>
                      {actionRows.length === 0 && (
                        <div className="text-xs text-subtle-foreground">No explicit actions recorded.</div>
                      )}
                      <div className="space-y-1">
                        {actionRows.map(([actor, action]) => (
                          <div key={`${round.round}:action:${actor}`} className="text-xs">
                            <span className="text-foreground font-medium">{actor}</span>: {action.action}
                            {" | "}commit {action.commit}
                            {" | "}target {action.target ?? action.target_id ?? "none"}
                            {" | "}timeout {action.timed_out ? "yes" : "no"}
                          </div>
                        ))}
                      </div>
                    </div>

                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-subtle-foreground mb-1">
                        Damage / Outcome Snapshot
                      </div>
                      <div className="overflow-auto">
                        <table className="w-full text-xs border-collapse">
                          <thead>
                            <tr className="text-subtle-foreground">
                              <th className="text-left pr-2 pb-1">Who</th>
                              <th className="text-left pr-2 pb-1">Hits</th>
                              <th className="text-left pr-2 pb-1">Off Loss</th>
                              <th className="text-left pr-2 pb-1">Def Loss</th>
                              <th className="text-left pr-2 pb-1">Shield Loss</th>
                              <th className="text-left pr-2 pb-1">Fighters</th>
                              <th className="text-left pr-2 pb-1">Shields</th>
                              <th className="text-left pb-1">Flee</th>
                            </tr>
                          </thead>
                          <tbody>
                            {metricKeys.map((key) => {
                              const participantName =
                                round.participants.find((participant) => participant.id === key)?.name ??
                                (key.startsWith("garrison:") ? (round.garrison?.owner_name ?? key) : key)

                              return (
                                <tr key={`${round.round}:metric:${key}`} className="border-t border-border/30">
                                  <td className="pr-2 py-1 text-foreground">{participantName}</td>
                                  <td className="pr-2 py-1">{round.hits?.[key] ?? "-"}</td>
                                  <td className="pr-2 py-1">{round.offensive_losses?.[key] ?? "-"}</td>
                                  <td className="pr-2 py-1">{round.defensive_losses?.[key] ?? "-"}</td>
                                  <td className="pr-2 py-1">{round.shield_loss?.[key] ?? "-"}</td>
                                  <td className="pr-2 py-1">{round.fighters_remaining?.[key] ?? "-"}</td>
                                  <td className="pr-2 py-1">{round.shields_remaining?.[key] ?? "-"}</td>
                                  <td className="py-1">
                                    {typeof round.flee_results?.[key] === "boolean" ?
                                      (round.flee_results[key] ? "yes" : "no")
                                    : "-"}
                                  </td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </article>
                )
              })}
            </div>
          </div>

          <div className="rounded-sm border border-border/60 bg-background/30 p-3">
            <h4 className="text-xs uppercase tracking-wider text-subtle-foreground mb-2">
              Combat Activity Feed
            </h4>
            {combatActivity.length === 0 && (
              <div className="text-xs text-subtle-foreground">
                No combat activity yet.
              </div>
            )}
            <div className="space-y-1 max-h-[380px] overflow-auto pr-1">
              {combatActivity.map((entry, index) => (
                <div key={`${entry.type}:${entry.timestamp ?? index}:${index}`} className="rounded-sm border border-border/30 bg-card/30 px-2 py-1">
                  <div className="text-[10px] uppercase tracking-wider text-subtle-foreground">
                    {entry.type}
                    {entry.timestamp && (
                      <>
                        {" | "}
                        {new Date(entry.timestamp).toLocaleTimeString()}
                      </>
                    )}
                  </div>
                  <div className="text-xs text-foreground">{entry.message}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-sm border border-border/70 bg-card/70 p-3 mb-4">
        <div className="mb-3">
          <h3 className="text-sm font-semibold leading-tight">My Ship</h3>
          <div className="text-xs text-subtle-foreground">
            {player?.name ?? "Unknown"} | {ship?.ship_name ?? "Unknown Ship"} ({ship?.ship_type ?? "unknown"})
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <Stat label="Ship ID" value={ship?.ship_id ?? "unknown"} />
          <Stat label="Owner Type" value={ship?.owner_type ?? "unknown"} />
          <Stat label="Sector" value={ship?.sector ?? "-"} />
          <Stat label="Credits" value={ship?.credits ?? "-"} />
          <Stat label="Fighters" value={ship?.fighters ?? "-"} />
          <Stat label="Max Fighters" value={ship?.max_fighters ?? "-"} />
          <Stat label="Shields" value={ship?.shields ?? "-"} />
          <Stat label="Max Shields" value={ship?.max_shields ?? "-"} />
          <Stat label="Warp Power" value={ship?.warp_power ?? "-"} />
          <Stat label="Warp Capacity" value={ship?.warp_power_capacity ?? "-"} />
          <Stat label="Cargo Capacity" value={ship?.cargo_capacity ?? "-"} />
          <Stat label="Empty Holds" value={ship?.empty_holds ?? "-"} />
        </div>

        <div className="mt-3 text-xs text-subtle-foreground">Cargo</div>
        <pre className="text-xs leading-relaxed overflow-auto max-h-[160px] whitespace-pre-wrap break-all rounded-sm border border-border/50 bg-background/50 p-2">
          {JSON.stringify(ship?.cargo ?? {}, null, 2)}
        </pre>
      </section>

      <section className="mb-4">
        <h3 className="mb-2 text-sm font-semibold">Combatant Ships</h3>
        {participants.length === 0 && (
          <div className="rounded-sm border border-border/70 bg-card/60 p-3 text-sm text-subtle-foreground">
            No participants yet. Trigger `Start / Round Waiting` in Leva to seed combatants.
          </div>
        )}
        <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-3">
          {participants.map((participant) => (
            <ParticipantCard
              key={participant.id ?? participant.name}
              participant={participant}
              latestRound={latestRound}
              isPlayer={participant.id === player?.id}
            />
          ))}
        </div>
      </section>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <JsonCard title="Active Combat Session (Raw)" value={activeCombatSession} />
        <JsonCard title="Latest Round (Raw)" value={latestRound} />
        <JsonCard title="Combat Action Receipts (Raw)" value={combatActionReceipts} />
        <JsonCard title="Last Combat Ended (Raw)" value={lastCombatEnded} />
        <JsonCard title="Current Sector (Raw)" value={sector} />
        <JsonCard title="Activity Log (Recent 25)" value={activityLog.slice(-25)} />
      </div>
    </div>
  )
}

CombatFlowStory.meta = {
  useDevTools: true,
  useChatControls: false,
  disconnectedStory: true,
  enableMic: false,
  disableAudioOutput: true,
}
