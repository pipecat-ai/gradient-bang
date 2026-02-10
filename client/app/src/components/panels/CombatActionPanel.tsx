import { useEffect, useMemo, useRef, useState } from "react"

import { useStarfieldEvent } from "@gradient-bang/starfield"

import { BlankSlateTile } from "@/components/BlankSlates"
import { Card, CardContent } from "@/components/primitives/Card"
import { useGameContext } from "@/hooks/useGameContext"
import useAudioStore from "@/stores/audio"
import useGameStore from "@/stores/game"
import { getRoundOutcome } from "@/utils/combat"
import { getShipLogoImage } from "@/utils/images"

import { CombatRoundTimer } from "../CombatRoundTimer"
import { CombatActionOptions } from "./CombatActionOptions"
import { CombatRoundFighterResults, CombatRoundShieldResults } from "./CombatRoundResults"

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

export const CombatActionPanel = () => {
  const { sendUserTextInput } = useGameContext()

  const playerId = useGameStore((state) => state.player?.id ?? null)
  const playerName = useGameStore((state) => state.player?.name ?? null)
  const ship = useGameStore((state) => state.ship)
  const activeCombatSession = useGameStore((state) => state.activeCombatSession)
  const combatRounds = useGameStore((state) => state.combatRounds)
  const combatActionReceipts = useGameStore((state) => state.combatActionReceipts)
  const lastCombatEnded = useGameStore((state) => state.lastCombatEnded)
  const [attackCommit, setAttackCommit] = useState<string>("1")
  const [selectedTargetKey, setSelectedTargetKey] = useState<string>("")

  const [error, setError] = useState<string | null>(null)
  const lastDamageNoticeRoundRef = useRef<string | null>(null)

  const { animateImpact } = useStarfieldEvent()

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

  const personalRoundResults = useMemo<CombatPersonalRoundResult[]>(() => {
    const results: CombatPersonalRoundResult[] = []

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
      if (round.garrison?.id) {
        participantNameById.set(
          round.garrison.id,
          round.garrison.name ?? `${round.garrison.owner_name} Garrison`
        )
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

    useGameStore.getState().setTookDamageThisRound(true)
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

  const attackTargets = useMemo<CombatAttackTargetOption[]>(() => {
    const participantTargets = (activeCombatSession?.participants ?? [])
      .filter((participant) => {
        const isPlayerById = Boolean(playerId && participant.id === playerId)
        const isPlayerByName = Boolean(playerName && participant.name === playerName)
        return !isPlayerById && !isPlayerByName
      })
      .map((participant, index) => ({
        key: participant.id ?? participant.name ?? `target-${index}`,
        id: participant.id ?? null,
        name: participant.name ?? null,
      }))

    const garrison = activeCombatSession?.garrison
    if (!garrison) {
      return participantTargets
    }

    const garrisonName = garrison.name ?? `${garrison.owner_name} Garrison`
    const garrisonKey = garrison.id ?? garrison.name ?? `garrison:${garrison.owner_name}`

    return [
      ...participantTargets,
      {
        key: garrisonKey,
        id: garrison.id ?? null,
        name: garrisonName,
      },
    ]
  }, [activeCombatSession?.participants, activeCombatSession?.garrison, playerId, playerName])

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
  const activeGarrison = activeCombatSession?.garrison ?? null
  const canPayToll = Boolean(activeGarrison && activeGarrison.mode === "toll")
  const payTollAmount = canPayToll ? (activeGarrison?.toll_amount ?? null) : null

  const handleSubmitAction = (selectedAction: CombatActionType) => {
    console.debug(
      "%c[GAME COMBAT] Submitting action",
      "color: red; font-weight: bold",
      selectedAction
    )
    if (!activeCombatSession) return
    setError(null)

    if (selectedAction === "attack" && !canAttack) {
      setError("Attack unavailable: no fighters remaining")
      console.debug(
        "%c[GAME COMBAT] Attack unavailable: no fighters remaining",
        "color: red; font-weight: bold"
      )
      return
    }
    if (selectedAction === "brace" && !canBrace) {
      setError("Brace unavailable: no shields remaining")
      console.debug(
        "%c[GAME COMBAT] Brace unavailable: no shields remaining",
        "color: red; font-weight: bold"
      )
      return
    }
    const commit = attackCommit ? Number.parseInt(attackCommit, 10) : 0
    if (selectedAction === "attack" && (!Number.isFinite(commit) || commit <= 0)) {
      console.debug(
        "%c[GAME COMBAT] Attack commit must be greater than 0",
        "color: red; font-weight: bold"
      )
      setError("Attack commit must be greater than 0")
      return
    }
    if (selectedAction === "attack" && !selectedAttackTarget) {
      console.debug(
        "%c[GAME COMBAT] No valid target available for attack",
        "color: red; font-weight: bold"
      )
      setError("No valid target available for attack")
      return
    }
    if (selectedAction === "pay" && !canPayToll) {
      console.debug(
        "%c[GAME COMBAT] Pay is unavailable for this round",
        "color: red; font-weight: bold"
      )
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
    <div className="relative z-10 h-full flex flex-col justify-between">
      <section className="flex flex-col gap-ui-xs flex-1 p-ui-xs">
        <div className="relative flex-1 flex pt-11 h-full min-h-0 gap-ui-xxs">
          <div className="animate-in zoom-in-50 fade-in-0 duration-1000 origin-center bg-background absolute z-10 left-1/2 -translate-x-1/2 top-0 bracket -bracket-offset-4 text-center p-ui-sm flex flex-col gap-ui-xs items-center justify-center">
            <img src={getShipLogoImage(ship.ship_type)} alt={ship.ship_name} className="size-12" />
            <div className="flex flex-col gap-ui-xs px-2">
              <span className="text-xs uppercase text-subtle-foreground">
                {ship.ship_type?.replace(/_/g, " ")}
              </span>
            </div>
          </div>

          <section className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
            <CombatRoundFighterResults round={latestPersonalResult} />
          </section>
          <div className="w-3 dashed-bg-vertical dashed-bg-white/50" />
          <section className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
            <CombatRoundShieldResults round={latestPersonalResult} />
          </section>
        </div>
      </section>

      <section className="flex flex-col gap-ui-sm mt-ui-sm">
        <CombatActionOptions
          round={activeCombatSession.round}
          attackCommit={attackCommit}
          selectedTargetKey={selectedTargetKey}
          payTollAmount={payTollAmount ?? 0}
          pendingReceipt={pendingReceipt ?? null}
          attackTargets={attackTargets}
          selectedAttackTarget={selectedAttackTarget}
          maxAttackCommit={currentFighters}
          canAttack={canAttack}
          canBrace={canBrace}
          canPayToll={canPayToll}
          onAttackCommit={(commit) => {
            console.debug("%c[GAME COMBAT] Attack commit", "color: red; font-weight: bold", commit)
            setAttackCommit(commit)
          }}
          onSelectedTargetKey={(key) => setSelectedTargetKey(key)}
          onSelectedAction={(action) => {
            console.debug(
              "%c[GAME COMBAT] Selected action",
              "color: red; font-weight: bold",
              action
            )
            handleSubmitAction(action)
          }}
          onPayToll={() => handleSubmitAction("pay")}
          receipt={pendingReceipt ?? null}
          error={error}
        />
      </section>
      <header className="flex flex-row items-center gap-ui-sm px-ui-xs pb-ui-xs">
        <CombatRoundTimer
          deadline={activeCombatSession.deadline}
          currentTime={activeCombatSession.current_time}
          combatId={activeCombatSession.combat_id}
          round={activeCombatSession.round}
          noTimer={!activeCombatSession.deadline}
        />
      </header>
    </div>
  )
}
