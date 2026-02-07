export const getShieldColor = (shieldIntegrity: number) => {
  if (shieldIntegrity < 25) {
    return "text-destructive"
  }
  if (shieldIntegrity < 50) {
    return "text-warning"
  }
  return "text-success"
}

export const getRoundOutcome = (
  round: Pick<CombatRound, "round_result" | "result" | "end">
) => {
  const outcomeRaw = round.round_result ?? round.result ?? round.end
  return outcomeRaw ? String(outcomeRaw).replace(/_/g, " ") : "continued"
}

export const getRoundOutcomeTone = (outcome: string | null | undefined) => {
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

export const sumRecordValues = (values: Record<string, number> | undefined) =>
  Object.values(values ?? {}).reduce(
    (total, value) => total + (Number.isFinite(value) ? value : 0),
    0
  )

export const getRoundDestroyedCount = (round: CombatRound) =>
  Object.entries(round.fighters_remaining ?? {}).reduce(
    (count, [combatantId, fightersRemaining]) => {
      if (fightersRemaining > 0) return count
      const lossesThisRound =
        (round.offensive_losses?.[combatantId] ?? 0) + (round.defensive_losses?.[combatantId] ?? 0)
      return lossesThisRound > 0 ? count + 1 : count
    },
    0
  )

export const getRoundFledCount = (round: CombatRound) =>
  Object.values(round.flee_results ?? {}).filter(Boolean).length

export const getRoundPaidCount = (round: CombatRound) =>
  Object.values(round.actions ?? {}).filter((action) => action.action === "pay").length
