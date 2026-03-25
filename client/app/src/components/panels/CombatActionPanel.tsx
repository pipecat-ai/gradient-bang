import { useCallback, useMemo, useState } from "react"

import { BlankSlateTile } from "@/components/BlankSlates"
import { CombatActionTimeline } from "@/components/CombatActionTimeline"
import { CombatRoundTimer } from "@/components/CombatRoundTimer"
import {
  CombatActionOptions,
  type CombatActionSubmission,
} from "@/components/panels/CombatActionOptions"
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

function validateAction(
  details: CombatActionSubmission,
  ctx: { canAttack: boolean; canBrace: boolean; canPayToll: boolean }
): string | null {
  if (details.action === "attack" && !ctx.canAttack) {
    return "Attack unavailable: no fighters remaining"
  }
  if (details.action === "brace" && !ctx.canBrace) {
    return "Brace unavailable: no shields remaining"
  }
  if (details.action === "attack") {
    if (!details.commit || details.commit <= 0) {
      return "Attack commit must be greater than 0"
    }
    if (!details.target_id) {
      return "No valid target available for attack"
    }
  }
  if (details.action === "pay" && !ctx.canPayToll) {
    return "Pay is unavailable for this round"
  }
  return null
}

// -- Component ---------------------------------------------------------------

export const CombatActionPanel = () => {
  const { dispatchAction } = useGameContext()

  const ship = useGameStore((state) => state.ship)
  const activeCombatSession = useGameStore((state) => state.activeCombatSession)
  const combatActionReceipts = useGameStore((state) => state.combatActionReceipts)

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
  //const committedAction = pendingReceipt?.action ?? null

  // -- Callbacks (stable references) --

  const handleSelectedAction = useCallback(
    (details: CombatActionSubmission) => {
      if (!activeCombatSession) return

      const validationError = validateAction(details, { canAttack, canBrace, canPayToll })

      if (validationError) {
        setError(validationError)
        return
      }

      setError(null)

      const payload: {
        combat_id: string
        action: string
        round: number
        commit?: number
        target_id?: string | null
        to_sector?: number | null
      } = {
        combat_id: activeCombatSession.combat_id,
        action: details.action,
        round: activeCombatSession.round,
      }

      if (details.action === "attack") {
        payload.commit = details.commit
        if (details.target_id) payload.target_id = details.target_id
      } else if (details.action === "flee") {
        const adjacentObj = useGameStore.getState().sector?.adjacent_sectors ?? {}
        const adjacentIds = Object.keys(adjacentObj).map(Number).filter(Number.isFinite)
        const toSector =
          adjacentIds.length > 0 ?
            adjacentIds[Math.floor(Math.random() * adjacentIds.length)]
          : null
        if (toSector != null) payload.to_sector = toSector
      }

      dispatchAction({ type: "combat-action", payload })
    },
    [activeCombatSession, canAttack, canBrace, canPayToll, dispatchAction]
  )

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
      <header className="flex flex-row items-center gap-ui-sm px-ui-xs pb-ui-xs">
        <CombatRoundTimer
          deadline={activeCombatSession.deadline}
          currentTime={activeCombatSession.current_time}
          combatId={activeCombatSession.combat_id}
          round={activeCombatSession.round}
          noTimer={!activeCombatSession.deadline}
        />
      </header>

      <section className="flex flex-col gap-ui-xs flex-1 px-ui-xs py-0">
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
          <div className="w-2 dashed-bg-vertical dashed-bg-white/50 mask-[linear-gradient(to_bottom,transparent,black_25%,black_75%,transparent)]" />
          <section className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
            <CombatRoundShieldResults round={latestPersonalResult} />
          </section>
        </div>
      </section>

      <section className="flex flex-col gap-ui-sm">
        <CombatActionOptions
          round={activeCombatSession.round}
          payTollAmount={payTollAmount ?? 0}
          pendingReceipt={pendingReceipt}
          attackTargets={attackTargets}
          maxAttackCommit={currentFighters}
          canAttack={canAttack}
          canBrace={canBrace}
          canPayToll={canPayToll}
          onSelectedAction={handleSelectedAction}
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
