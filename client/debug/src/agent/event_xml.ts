import type { CombatEvent } from "../engine/types"

// Ports the combat-event summary functions from
// `src/gradientbang/pipecat_server/subagents/event_relay.py` (_summarize_* +
// the XML envelope at relay line 1184):
//   <event name="{event_name}" combat_id="{combat_id}">{summary}</event>
//
// A `null` return means the event is NOT appended to this character's LLM
// context (production's AppendRule.NEVER / non-participant PARTICIPANT).

const ID_PREFIX_LEN = 8

function shortId(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.slice(0, ID_PREFIX_LEN)
}

function isPlayerParticipant(payload: unknown, characterId: string): boolean {
  if (!payload || typeof payload !== "object") return false
  const participants = (payload as Record<string, unknown>).participants
  if (!Array.isArray(participants)) return false
  return participants.some(
    (p) => p && typeof p === "object" && (p as Record<string, unknown>).id === characterId,
  )
}

function combatContext(payload: Record<string, unknown>, isPlayer: boolean): string {
  const combatId = payload.combat_id
  const round = payload.round
  const details: string[] = []
  if (typeof round === "number") details.push(`round ${round}`)
  if (typeof combatId === "string" && combatId.trim()) details.push(`combat_id ${combatId}`)
  const suffix = details.length ? ` (${details.join(", ")})` : ""
  return isPlayer
    ? `Combat state: you are currently in active combat.${suffix}`
    : `Combat state: this combat event is not your fight.${suffix}`
}

function summarizeCombatWaiting(event: CombatEvent, characterId: string): string {
  const payload = (event.payload ?? {}) as Record<string, unknown>
  const isPlayer = isPlayerParticipant(payload, characterId)
  let ctx = combatContext(payload, isPlayer)
  const deadline = payload.deadline
  if (typeof deadline === "string" && deadline.trim()) {
    ctx += ` deadline ${deadline.trim()}`
  }

  // Harness enhancement over production's terse summary: inline the
  // participants list and garrison block so the LLM has concrete `id` values
  // to copy into `target_id`, without needing a follow-up tool call. Without
  // this, the LLM had to either hallucinate or always pick brace.
  const participants = Array.isArray(payload.participants) ? payload.participants : []
  if (participants.length > 0) {
    ctx += "\nParticipants:"
    for (const p of participants) {
      const pp = p as Record<string, unknown>
      const id = typeof pp.id === "string" ? pp.id : "?"
      const name = typeof pp.name === "string" ? pp.name : id
      const ship = pp.ship as Record<string, unknown> | undefined
      const shipType =
        typeof ship?.ship_type === "string" ? ship.ship_type : "unknown"
      const shieldInt = ship?.shield_integrity
      const shieldStr =
        typeof shieldInt === "number" ? `, shields ${Math.round(shieldInt)}%` : ""
      const marker = id === characterId ? " (you)" : ""
      ctx += `\n  - ${name}${marker}: id=${id}, ${shipType}${shieldStr}`
    }
  }
  const garrison = payload.garrison as Record<string, unknown> | null | undefined
  if (garrison && typeof garrison === "object") {
    const gid = typeof garrison.id === "string" ? garrison.id : "?"
    const gName =
      typeof garrison.name === "string"
        ? garrison.name
        : typeof garrison.owner_name === "string"
          ? garrison.owner_name
          : "Garrison"
    const mode = String(garrison.mode ?? "")
    const fighters = garrison.fighters
    const tollAmt = garrison.toll_amount
    const tollStr = mode === "toll" ? `, toll ${tollAmt}c` : ""
    ctx += `\nGarrison: ${gName} id=${gid}, ${fighters} fighters, mode=${mode}${tollStr}`
  }

  if (isPlayer) ctx += "\nSubmit a combat action now."
  return ctx
}

function summarizeCombatRound(event: CombatEvent, characterId: string): string {
  const payload = (event.payload ?? {}) as Record<string, unknown>
  const isPlayer = isPlayerParticipant(payload, characterId)
  const ctx = combatContext(payload, isPlayer)
  const result = (payload.result ?? payload.end ?? "in_progress") as string
  let ownFighterLoss = 0
  let ownShieldDamage = 0
  if (isPlayer && Array.isArray(payload.participants)) {
    for (const p of payload.participants as Array<Record<string, unknown>>) {
      if (p.id === characterId) {
        const ship = p.ship as Record<string, unknown> | undefined
        if (ship) {
          const fl = ship.fighter_loss
          const sd = ship.shield_damage
          if (typeof fl === "number") ownFighterLoss = Math.max(0, Math.floor(fl))
          if (typeof sd === "number") ownShieldDamage = Math.max(0, sd)
        }
        break
      }
    }
  }
  const fighterPart = ownFighterLoss > 0 ? `fighters lost ${ownFighterLoss}` : "no fighter losses"
  const shieldPart =
    ownShieldDamage > 0 ? `shield damage ${ownShieldDamage.toFixed(1)}%` : "no shield damage"
  return `${ctx}\nRound resolved: ${result}; ${fighterPart}, ${shieldPart}.`
}

function summarizeCombatAction(event: CombatEvent): string {
  const payload = (event.payload ?? {}) as Record<string, unknown>
  const round = typeof payload.round === "number" ? String(payload.round) : "?"
  const actionNested = (payload.action ?? {}) as Record<string, unknown>
  const action =
    (typeof actionNested.action === "string" ? actionNested.action : null) ??
    (typeof payload.action === "string" ? payload.action : "unknown")
  const commitRaw = actionNested.commit ?? payload.commit
  const commit =
    typeof commitRaw === "number" && Math.floor(commitRaw) > 0
      ? ` commit ${Math.floor(commitRaw)}`
      : ""
  const targetRaw = actionNested.target_id ?? payload.target_id
  const targetStr =
    typeof targetRaw === "string" && targetRaw.trim()
      ? `, target ${shortId(targetRaw) ?? targetRaw}`
      : ""
  return `Action accepted for round ${round}: ${String(action).toLowerCase()}${commit}${targetStr}.`
}

function summarizeCombatEnded(event: CombatEvent, characterId: string): string {
  return isPlayerParticipant(event.payload, characterId)
    ? "Combat state: your combat has ended."
    : "Combat state: observed combat ended."
}

/**
 * Wraps a summary string in the production XML envelope.
 * Mirrors event_relay.py line 1184.
 */
function wrapXml(event: CombatEvent, summary: string): string {
  const attrs: string[] = [`name="${event.type}"`]
  const combatId = event.combat_id ?? (event.payload as Record<string, unknown> | undefined)?.combat_id
  if (typeof combatId === "string" && combatId.trim()) {
    attrs.push(`combat_id="${combatId.trim()}"`)
  }
  return `<event ${attrs.join(" ")}>\n${summary}\n</event>`
}

/**
 * Build the XML string for an event from this character's POV, or return
 * null if the event should NOT be appended to the character's LLM context.
 *
 * Mirrors the PARTICIPANT/ALWAYS/NEVER AppendRule logic plus the
 * participant-existence check. For the harness we also filter by recipient:
 * if the character isn't in `event.recipients`, the server wouldn't have
 * delivered this event at all.
 */
export function toAgentEventXml(event: CombatEvent, characterId: string): string | null {
  // Filter 1: server-side recipient check — the relay can only act on events
  // delivered to this character. Our engine records recipients, so we mimic.
  if (!event.recipients.includes(characterId as never)) return null

  // Filter 2: AppendRule per event type. Non-combat events fall through with
  // a default PARTICIPANT-ish treatment (shown only if this character sees them).
  switch (event.type) {
    case "combat.round_waiting": {
      // AppendRule.PARTICIPANT — only append when the character is in participants[].
      if (!isPlayerParticipant(event.payload, characterId)) return null
      return wrapXml(event, summarizeCombatWaiting(event, characterId))
    }
    case "combat.round_resolved": {
      if (!isPlayerParticipant(event.payload, characterId)) return null
      return wrapXml(event, summarizeCombatRound(event, characterId))
    }
    case "combat.ended": {
      if (!isPlayerParticipant(event.payload, characterId)) return null
      return wrapXml(event, summarizeCombatEnded(event, characterId))
    }
    case "combat.action_accepted": {
      // Only the submitter's own action_accepted makes it into context.
      if (event.actor !== characterId) return null
      return wrapXml(event, summarizeCombatAction(event))
    }
    default:
      // Non-combat events are out of scope for this harness module.
      return null
  }
}
