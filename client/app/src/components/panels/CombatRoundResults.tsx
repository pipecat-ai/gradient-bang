import { DottedTitle } from "../DottedTitle"
import { Card, CardContent } from "../primitives/Card"

const CombatStatTile = ({
  label,
  value,
  help,
}: {
  label: string
  value: string | number
  help: string
}) => {
  return (
    <div className="combat-tile flex flex-col gap-1">
      <div className="text-xxs uppercase text-muted-foreground">{label}</div>
      <div className="text-sm uppercase font-bold text-foreground">{value}</div>
      <div className="text-xxs uppercase text-subtle-foreground">{help}</div>
    </div>
  )
}

export const CombatRoundResults = ({ round }: { round: CombatPersonalRoundResult }) => {
  const fleeOutcome =
    typeof round.fleeSuccess === "boolean" ?
      round.fleeSuccess ?
        "Success"
      : "Failed"
    : "None"
  const totalFighterLosses = round.offensiveLosses + round.defensiveLosses
  const netFighterSwing = round.hits - totalFighterLosses
  const incomingPressure = round.defensiveLosses + round.shieldLoss
  const combatState =
    round.fleeSuccess ? "Fled"
    : round.fightersRemaining === 0 ? "Destroyed"
    : "Engaged"
  const signedNetFighterSwing = `${netFighterSwing > 0 ? "+" : ""}${netFighterSwing}`

  return (
    <Card size="sm" className="border border-accent min-h-0">
      <CardContent className="flex flex-col gap-ui-sm">
        <div className="text-xxs uppercase text-subtle-foreground">Round {round.round}</div>

        <DottedTitle title="Fighter Attrition" textColor="text-foreground" />
        <CombatStatTile
          label="Successful Hits"
          value={round.hits}
          help="Hits your committed fighters landed on the target."
        />
        <CombatStatTile
          label="Offensive Fighter Losses"
          value={round.offensiveLosses}
          help="Your fighters lost while attacking (failed attack rolls)."
        />
        <CombatStatTile
          label="Defensive Fighter Losses"
          value={round.defensiveLosses}
          help="Your fighters destroyed by incoming enemy attacks."
        />
        <CombatStatTile
          label="Fighters Remaining"
          value={round.fightersRemaining ?? "—"}
          help="Your total fighters left after this round resolved."
        />
        <CombatStatTile
          label="Total Fighter Losses"
          value={totalFighterLosses}
          help="Combined offensive and defensive fighter losses this round."
        />

        <DottedTitle title="Shields" textColor="text-foreground" />
        <CombatStatTile
          label="Shield Loss"
          value={round.shieldLoss}
          help="Shield points stripped this round by incoming pressure."
        />
        <CombatStatTile
          label="Shields Remaining"
          value={round.shieldsRemaining ?? "—"}
          help="Shield points left after this round resolved."
        />
        <CombatStatTile
          label="Incoming Pressure"
          value={incomingPressure}
          help="Incoming damage pressure (defensive losses plus shield loss)."
        />

        <DottedTitle title="Derived" textColor="text-foreground" />
        <CombatStatTile
          label="Net Fighter Swing"
          value={signedNetFighterSwing}
          help="Hits landed minus your fighter losses this round."
        />
        <CombatStatTile
          label="Combat State"
          value={combatState}
          help="Your state after this round (engaged, fled, or destroyed)."
        />

        <DottedTitle title="Outcome" textColor="text-foreground" />
        <CombatStatTile
          label="Submitted Action"
          value={round.action}
          help="Action you submitted for this round."
        />
        <CombatStatTile
          label="Attack Target"
          value={round.target ?? "None"}
          help="Participant you targeted for attack this round."
        />
        <CombatStatTile
          label="Flee Attempt"
          value={fleeOutcome}
          help="Whether your flee attempt succeeded this round."
        />
        <CombatStatTile
          label="Round Outcome"
          value={round.outcome}
          help="Outcome string returned by combat resolution."
        />
      </CardContent>
    </Card>
  )
}
