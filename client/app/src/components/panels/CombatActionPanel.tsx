import { useCallback, useMemo, useState } from "react"

import { BlankSlateTile } from "@/components/BlankSlates"
import { CombatActionTimeline } from "@/components/CombatActionTimeline"
import { CombatRoundTimer } from "@/components/CombatRoundTimer"
import { CombatActionOptions } from "@/components/panels/CombatActionOptions"
import {
  CombatRoundFighterResults,
  CombatRoundShieldResults,
} from "@/components/panels/CombatRoundResults"
import { Card, CardContent } from "@/components/primitives/Card"
import { useCombatDamageEffect } from "@/hooks/useCombatDamageEffect"
import { useCombatTargets } from "@/hooks/useCombatTargets"
import { useCombatTimeline } from "@/hooks/useCombatTimeline"
import { useGameContext } from "@/hooks/useGameContext"
import useGameStore from "@/stores/game"
import { getShipLogoImage } from "@/utils/images"

// -- Action validation -------------------------------------------------------

type ActionValidationContext = {
  canAttack: boolean
  canBrace: boolean
  canPayToll: boolean
  attackCommit: string
  selectedAttackTarget: CombatAttackTargetOption | null
}

function validateAction(action: CombatActionType, ctx: ActionValidationContext): string | null {
  if (action === "attack" && !ctx.canAttack) {
    return "Attack unavailable: no fighters remaining"
  }
  if (action === "brace" && !ctx.canBrace) {
    return "Brace unavailable: no shields remaining"
  }
  if (action === "attack") {
    const commit = ctx.attackCommit ? Number.parseInt(ctx.attackCommit, 10) : 0
    if (!Number.isFinite(commit) || commit <= 0) {
      return "Attack commit must be greater than 0"
    }
    if (!ctx.selectedAttackTarget) {
      return "No valid target available for attack"
    }
  }
  if (action === "pay" && !ctx.canPayToll) {
    return "Pay is unavailable for this round"
  }
  return null
}

// -- Component ---------------------------------------------------------------

export const CombatActionPanel = () => {
  const { sendUserTextInput } = useGameContext()

  const ship = useGameStore((state) => state.ship)
  const activeCombatSession = useGameStore((state) => state.activeCombatSession)
  const combatActionReceipts = useGameStore((state) => state.combatActionReceipts)

  const [attackCommit, setAttackCommit] = useState<string>("1")
  const [selectedTargetKey, setSelectedTargetKey] = useState<string>("")
  const [error, setError] = useState<string | null>(null)

  // -- Derived combat data (custom hooks) --

  const { combatId, latestPersonalResult } = useCombatTimeline()
  const attackTargets = useCombatTargets()

  useCombatDamageEffect(combatId, latestPersonalResult, Boolean(activeCombatSession))

  // -- Derived state --

  const pendingReceipt = useMemo(() => {
    if (!activeCombatSession) return null
    return (
      combatActionReceipts.findLast(
        (receipt) =>
          receipt.combat_id === activeCombatSession.combat_id &&
          receipt.round === activeCombatSession.round
      ) ?? null
    )
  }, [activeCombatSession, combatActionReceipts])

  const selectedAttackTarget =
    attackTargets.find((t) => t.key === selectedTargetKey) ?? attackTargets[0] ?? null

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
  const previousRoundAction = latestPersonalResult?.action ?? null
  const committedAction = pendingReceipt?.action ?? null

  console.log("[COMBAT] previousRoundAction", previousRoundAction)
  console.log("[COMBAT] committedAction", committedAction)

  // -- Callbacks (stable references) --

  const handleSubmitAction = useCallback(
    (selectedAction: CombatActionType) => {
      if (!activeCombatSession) return

      const validationError = validateAction(selectedAction, {
        canAttack,
        canBrace,
        canPayToll,
        attackCommit,
        selectedAttackTarget,
      })

      if (validationError) {
        setError(validationError)
        return
      }

      setError(null)

      const commit = attackCommit ? Number.parseInt(attackCommit, 10) : 0
      const selectedTargetId = selectedAttackTarget?.id ?? selectedAttackTarget?.name ?? null

      const prompt =
        selectedAction === "attack" ?
          `In combat ${activeCombatSession.combat_id}, round ${activeCombatSession.round}, submit action attack with commit ${commit}${selectedTargetId ? ` targeting ${selectedTargetId}` : ""}.`
        : `In combat ${activeCombatSession.combat_id}, round ${activeCombatSession.round}, submit action ${selectedAction}.`

      sendUserTextInput(prompt)
    },
    [
      activeCombatSession,
      attackCommit,
      canAttack,
      canBrace,
      canPayToll,
      selectedAttackTarget,
      sendUserTextInput,
    ]
  )

  const handleAttackCommit = useCallback((commit: string) => {
    setAttackCommit(commit)
  }, [])

  const handleSelectedTargetKey = useCallback((key: string) => {
    setSelectedTargetKey(key)
  }, [])

  const handleSelectedAction = useCallback(
    (action: CombatActionType) => {
      handleSubmitAction(action)
    },
    [handleSubmitAction]
  )

  const handlePayToll = useCallback(() => {
    handleSubmitAction("pay")
  }, [handleSubmitAction])

  // -- Render --

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
    <div className="relative h-full flex flex-col justify-between">
      <header className="flex flex-row items-center gap-ui-sm px-ui-xs pt-ui-xs">
        <CombatRoundTimer
          deadline={activeCombatSession.deadline}
          currentTime={activeCombatSession.current_time}
          combatId={activeCombatSession.combat_id}
          round={activeCombatSession.round}
          noTimer={!activeCombatSession.deadline}
        />
      </header>

      <section className="flex flex-col gap-ui-xs flex-1 p-ui-xs pb-0">
        <div className="relative flex-1 flex pt-11 h-full min-h-0 gap-ui-xxs">
          <div className="animate-in zoom-in-50 fade-in-0 duration-1000 origin-center bg-background absolute z-1 left-1/2 -translate-x-1/2 top-0 bracket -bracket-offset-4 text-center p-ui-sm flex flex-col gap-ui-xs items-center justify-center">
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
          <div className="w-2 dashed-bg-vertical dashed-bg-white/50" />
          <section className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
            <CombatRoundShieldResults round={latestPersonalResult} />
          </section>
        </div>
      </section>

      <section className="flex flex-col gap-ui-sm">
        <CombatActionOptions
          round={activeCombatSession.round}
          attackCommit={attackCommit}
          selectedTargetKey={selectedTargetKey}
          payTollAmount={payTollAmount ?? 0}
          pendingReceipt={pendingReceipt}
          attackTargets={attackTargets}
          selectedAttackTarget={selectedAttackTarget}
          maxAttackCommit={currentFighters}
          canAttack={canAttack}
          canBrace={canBrace}
          canPayToll={canPayToll}
          onAttackCommit={handleAttackCommit}
          onSelectedTargetKey={handleSelectedTargetKey}
          onSelectedAction={handleSelectedAction}
          onPayToll={handlePayToll}
          receipt={pendingReceipt}
          error={error}
        />
      </section>

      <section className="flex flex-col gap-ui-sm">
        <CombatActionTimeline
          round={latestPersonalResult?.round ?? null}
          action={previousRoundAction}
        />
      </section>
    </div>
  )
}
