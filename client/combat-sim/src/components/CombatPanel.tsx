import { CastleTurret, Coin, Crosshair, Robot, Shield, ShieldWarning } from "@phosphor-icons/react"
import { useEffect, useRef, useState } from "react"

import type { CombatEngine } from "../engine/engine"
import {
  characterId,
  combatId as combatIdBrand,
  type CombatEncounterState,
  type CombatantAction,
  type RoundActionState,
  type World,
} from "../engine/types"

interface Props {
  engine: CombatEngine
  world: World
}

export function CombatPanel({ engine, world }: Props) {
  // Show every combat (including ended ones) so the final state remains
  // visible after a round ends — useful during presentations and post-mortem.
  // Order: active first (by sector), then ended (most-recent update first).
  const encounters = Array.from(world.activeCombats.values())
  if (encounters.length === 0) return null
  const active = encounters.filter((c) => !c.ended)
  const ended = encounters
    .filter((c) => c.ended)
    .sort((a, b) => b.last_updated - a.last_updated)
  const ordered = [...active, ...ended]

  return (
    <div className="border-b border-neutral-800 bg-neutral-950/60 px-4 py-3">
      <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-wider text-neutral-500">
        <span>
          Combat · {active.length} active
          {ended.length > 0 ? ` · ${ended.length} ended` : ""}
        </span>
      </div>
      <div className="space-y-3">
        {ordered.map((encounter) => (
          <EncounterCard key={encounter.combat_id} engine={engine} encounter={encounter} />
        ))}
      </div>
    </div>
  )
}

function EncounterCard({
  engine,
  encounter,
}: {
  engine: CombatEngine
  encounter: CombatEncounterState
}) {
  const participants = Object.values(encounter.participants)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(id)
  }, [])

  const remainingMs = encounter.deadline != null ? encounter.deadline - now : null
  const expired = remainingMs != null && remainingMs <= 0
  const isEnded = encounter.ended

  return (
    <div
      className={`rounded border p-2 ${
        isEnded
          ? "border-neutral-800 bg-neutral-950/60 opacity-90"
          : "border-neutral-800 bg-neutral-900/50"
      }`}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-neutral-500">
        <span>
          <span className="text-neutral-400">{encounter.combat_id}</span> · sector{" "}
          {encounter.sector_id} · round {encounter.round}
        </span>
        {isEnded && (
          <span
            className="inline-flex items-center gap-1 rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-neutral-300"
            title={`Combat ended${encounter.end_state ? ` — ${encounter.end_state}` : ""}`}
          >
            ended{encounter.end_state ? ` · ${encounter.end_state}` : ""}
          </span>
        )}
        {!isEnded && (
          <span className="ml-auto">
            deadline:{" "}
            {remainingMs == null ? (
              "—"
            ) : expired ? (
              <span className="text-amber-400">expired (tick to resolve)</span>
            ) : (
              <span className="text-neutral-300">{(remainingMs / 1000).toFixed(1)}s</span>
            )}
          </span>
        )}
        {!isEnded && (
          <>
            <button
              type="button"
              onClick={() => engine.tick(Date.now())}
              className="rounded bg-neutral-800 px-2 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-700"
            >
              Tick now
            </button>
            <button
              type="button"
              onClick={() => {
                if (
                  !window.confirm(
                    "Force-end this combat? No more damage will be applied; the engine emits a final combat.ended so you can summarize. Harness-only — not in production.",
                  )
                )
                  return
                const result = engine.forceEndCombat(
                  combatIdBrand(encounter.combat_id),
                )
                if (!result.ok) alert(result.reason)
              }}
              className="rounded bg-rose-900/40 px-2 py-0.5 text-[11px] text-rose-200 hover:bg-rose-900/60"
              title="Hard-terminate this combat (debug only)"
            >
              Force end
            </button>
          </>
        )}
      </div>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {participants.map((p) =>
          p.combatant_type === "garrison" ? (
            <GarrisonCard
              key={p.combatant_id}
              encounter={encounter}
              participant={p}
            />
          ) : (
            <ParticipantDock
              key={p.combatant_id}
              engine={engine}
              encounter={encounter}
              participantId={p.combatant_id}
            />
          ),
        )}
      </div>
    </div>
  )
}

function GarrisonCard({
  encounter,
  participant,
}: {
  encounter: CombatEncounterState
  participant: CombatEncounterState["participants"][string]
}) {
  const metadata = (participant.metadata ?? {}) as Record<string, unknown>
  const mode = String(metadata.mode ?? "offensive")
  const dead = participant.fighters <= 0
  const ownerName =
    (typeof metadata.owner_name === "string" ? metadata.owner_name : null) ??
    participant.owner_character_id ??
    null
  const tollAmount =
    typeof metadata.toll_amount === "number" ? metadata.toll_amount : 0

  // Toll payment state for this combat (lives on encounter.context.toll_registry).
  const registry = (encounter.context as Record<string, unknown> | undefined)
    ?.toll_registry as
    | Record<string, { paid?: boolean; paid_round?: number | null; toll_balance?: number }>
    | undefined
  const tollEntry = registry?.[participant.combatant_id]
  const tollPaidThisRound =
    mode === "toll" && tollEntry?.paid === true && tollEntry?.paid_round === encounter.round

  // Show the garrison's last-round action + result so the user can see what
  // the autonomous garrison actually did — otherwise the card just says
  // "auto-controlled" and you have to dig into the event log to reconstruct.
  const lastAction = encounter.ui_last_actions[participant.combatant_id]

  const fighterDelta = useRoundDelta(participant.fighters, encounter.round)
  const destroyedShake = useTransitionAnim(dead, 650)
  // Toll paid THIS round triggers a one-shot flash so the transition is
  // perceptually distinct from a long-ago payment.
  const tollFlash = useTransitionAnim(tollPaidThisRound, 1400)

  return (
    <div
      className={`rounded border p-2 text-xs transition ${
        dead
          ? "border-rose-900/60 bg-neutral-950/60 opacity-70"
          : "border-sky-900/60 bg-sky-950/30"
      } ${destroyedShake ? "anim-destroyed" : ""}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <CastleTurret
          weight="fill"
          className={`h-3.5 w-3.5 ${dead ? "text-rose-400" : "text-sky-300"}`}
        />
        <span className="font-semibold text-neutral-100">{participant.name}</span>
        <span
          className={`inline-flex items-center gap-0.5 rounded px-1 text-[9px] uppercase tracking-wider ${
            mode === "toll"
              ? "bg-amber-950/60 text-amber-300"
              : mode === "offensive"
                ? "bg-rose-950/60 text-rose-300"
                : "bg-sky-950/60 text-sky-300"
          }`}
        >
          {mode === "toll" ? (
            <Coin weight="fill" className="h-2.5 w-2.5" />
          ) : mode === "offensive" ? (
            <Crosshair weight="bold" className="h-2.5 w-2.5" />
          ) : (
            <Shield weight="fill" className="h-2.5 w-2.5" />
          )}
          {mode}
          {mode === "toll" ? ` · ${tollAmount}c` : ""}
        </span>
        {mode === "toll" && (
          <span
            className={`inline-flex items-center gap-0.5 rounded border px-1 text-[9px] uppercase tracking-wider transition ${
              tollPaidThisRound
                ? "border-emerald-500 bg-emerald-900/60 text-emerald-100"
                : tollEntry?.paid
                  ? "border-amber-700 bg-amber-950/50 text-amber-300"
                  : "border-neutral-700 bg-neutral-900 text-neutral-400"
            } ${tollFlash ? "anim-toll-flash" : ""}`}
            title={
              tollPaidThisRound
                ? "Toll paid this round — standdown eligible if everyone else braces."
                : tollEntry?.paid
                  ? "Toll was paid in an earlier round; standdown window has closed until re-paid."
                  : "Toll not yet paid."
            }
          >
            <Coin weight="fill" className="h-2.5 w-2.5" />
            {tollPaidThisRound
              ? "paid · current"
              : tollEntry?.paid
                ? `paid · r${tollEntry.paid_round}`
                : "unpaid"}
          </span>
        )}
      </div>
      <div className="mt-1.5 flex items-center gap-3">
        <StatBar
          icon={<Crosshair weight="bold" className="h-2.5 w-2.5 text-amber-400" />}
          label="F"
          value={participant.fighters}
          max={participant.max_fighters}
          delta={fighterDelta}
          tone="amber"
        />
        <div className="flex min-w-0 flex-col items-end gap-0.5 text-[10px] text-neutral-500">
          {ownerName && (
            <span className="truncate">
              owner <span className="text-neutral-300">{ownerName}</span>
            </span>
          )}
          {dead ? (
            <span className="text-rose-400">destroyed</span>
          ) : lastAction ? (
            <span className="truncate">
              last:{" "}
              <span className="text-neutral-300">
                {formatGarrisonAction(lastAction)}
              </span>
            </span>
          ) : (
            <span className="inline-flex items-center gap-0.5 text-sky-300">
              <Robot weight="fill" className="h-2.5 w-2.5" />
              auto-controlled
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

function formatGarrisonAction(action: RoundActionState): string {
  const base = action.action ?? "brace"
  if (base === "attack") {
    return `attack${action.commit ? ` (${action.commit})` : ""}`
  }
  return base
}

function ParticipantDock({
  engine,
  encounter,
  participantId,
}: {
  engine: CombatEngine
  encounter: CombatEncounterState
  participantId: string
}) {
  const participant = encounter.participants[participantId]
  const opponents = Object.values(encounter.participants).filter(
    (p) => p.combatant_id !== participantId,
  )
  const [target, setTarget] = useState<string>(opponents[0]?.combatant_id ?? "")
  const [commit, setCommit] = useState<number>(
    Math.max(1, Math.floor((participant?.fighters ?? 0) / 2)),
  )
  const [destination, setDestination] = useState<number>(encounter.sector_id - 1)

  // Any toll-mode garrison in this combat with an unpaid entry → this
  // participant can submit `pay` against it.
  const tollRegistry = (encounter.context as Record<string, unknown> | undefined)
    ?.toll_registry as Record<string, { toll_amount?: number; paid?: boolean }> | undefined
  const unpaidTollGarrison = Object.values(encounter.participants).find((p) => {
    if (p.combatant_type !== "garrison") return false
    const mode = (p.metadata as Record<string, unknown> | undefined)?.mode
    if (mode !== "toll") return false
    const entry = tollRegistry?.[p.combatant_id]
    return !entry || !entry.paid
  })
  const tollAmount =
    (unpaidTollGarrison?.metadata as Record<string, unknown> | undefined)?.toll_amount ?? 0

  if (!participant) return null
  const submitted = encounter.pending_actions[participantId]
  // Fall back to the round-just-resolved buffer so a ship whose tool call
  // triggered the final round resolution still shows its chosen action —
  // otherwise the sync emit chain wipes `pending_actions` before React
  // paints, and the badge appears "stuck on awaiting".
  const lastAction = encounter.ui_last_actions[participantId]
  const dead = participant.fighters <= 0
  const fled = Boolean(participant.has_fled)
  const fledTo = participant.fled_to_sector ?? null
  const inactive = dead || fled

  const fighterDelta = useRoundDelta(participant.fighters, encounter.round)
  const shieldDelta = useRoundDelta(participant.shields, encounter.round)
  const destroyedShake = useTransitionAnim(dead, 650)

  const submit = (action: CombatantAction) => {
    const actor = characterId(participantId)
    const cid = combatIdBrand(encounter.combat_id)
    let result
    if (action === "attack") {
      result = engine.submitAction(actor, cid, { action: "attack", target_id: target, commit })
    } else if (action === "brace") {
      result = engine.submitAction(actor, cid, { action: "brace" })
    } else if (action === "flee") {
      result = engine.submitAction(actor, cid, { action: "flee", destination_sector: destination })
    } else {
      result = engine.submitAction(actor, cid, {
        action: "pay",
        target_id: unpaidTollGarrison?.combatant_id ?? null,
      })
    }
    if (!result.ok) alert(result.reason)
  }

  return (
    <div
      className={`rounded border p-2 text-xs transition ${
        dead
          ? "border-rose-900/60 bg-neutral-950/60 opacity-70"
          : fled
            ? "border-amber-900/60 bg-amber-950/30 opacity-70"
            : "border-neutral-800 bg-neutral-900"
      } ${destroyedShake ? "anim-destroyed" : ""}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-neutral-100">{participant.name}</span>
        <span className="truncate text-[10px] text-neutral-500">
          {participant.combatant_id} · {participant.ship_type}
        </span>
        {fled && !dead && (
          <span className="inline-flex items-center gap-0.5 rounded border border-amber-700 bg-amber-900/40 px-1 text-[9px] uppercase tracking-wider text-amber-200">
            <ShieldWarning weight="fill" className="h-2.5 w-2.5" />
            fled{fledTo != null ? ` → ${fledTo}` : ""}
          </span>
        )}
      </div>
      <div className="mt-1.5 flex items-center gap-3">
        <StatBar
          icon={<Crosshair weight="bold" className="h-2.5 w-2.5 text-amber-400" />}
          label="F"
          value={participant.fighters}
          max={participant.max_fighters}
          delta={fighterDelta}
          tone="amber"
        />
        <StatBar
          icon={<Shield weight="fill" className="h-2.5 w-2.5 text-sky-400" />}
          label="S"
          value={participant.shields}
          max={participant.max_shields}
          delta={shieldDelta}
          tone="sky"
        />
      </div>
      <div className="mt-1 text-[10px] text-neutral-500">
        {dead ? (
          <span className="text-rose-400">destroyed</span>
        ) : fled ? (
          <span className="text-amber-300">
            fled{fledTo != null ? ` → sector ${fledTo}` : ""}
          </span>
        ) : submitted ? (
          <span className="text-emerald-300">
            submitted: {formatAction(submitted, encounter)}
          </span>
        ) : lastAction ? (
          <span>
            resolved:{" "}
            <span className="text-neutral-300">
              {formatAction(lastAction, encounter)}
            </span>
            {lastAction.timed_out ? " (timeout)" : ""}
          </span>
        ) : (
          <span className="anim-blink text-amber-400">awaiting</span>
        )}
      </div>
      {!inactive && !submitted && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="rounded bg-neutral-800 px-1 py-0.5 text-[11px]"
          >
            {opponents.map((o) => (
              <option key={o.combatant_id} value={o.combatant_id}>
                {o.name}
              </option>
            ))}
          </select>
          <input
            type="number"
            min={1}
            max={participant.fighters}
            value={commit}
            onChange={(e) => setCommit(Number(e.target.value))}
            className="w-14 rounded bg-neutral-800 px-1 py-0.5 text-[11px]"
          />
          <button
            type="button"
            onClick={() => submit("attack")}
            className="rounded bg-red-900/40 px-2 py-0.5 text-[11px] text-red-200 hover:bg-red-900/60"
          >
            Attack
          </button>
          <button
            type="button"
            onClick={() => submit("brace")}
            className="rounded bg-blue-900/40 px-2 py-0.5 text-[11px] text-blue-200 hover:bg-blue-900/60"
          >
            Brace
          </button>
          <input
            type="number"
            value={destination}
            onChange={(e) => setDestination(Number(e.target.value))}
            className="w-14 rounded bg-neutral-800 px-1 py-0.5 text-[11px]"
          />
          <button
            type="button"
            onClick={() => submit("flee")}
            className="rounded bg-amber-900/40 px-2 py-0.5 text-[11px] text-amber-200 hover:bg-amber-900/60"
          >
            Flee
          </button>
          {unpaidTollGarrison && (
            <button
              type="button"
              onClick={() => submit("pay")}
              className="rounded bg-sky-900/50 px-2 py-0.5 text-[11px] text-sky-100 hover:bg-sky-900/70"
              title={`Pay ${String(tollAmount)}c to ${unpaidTollGarrison.name}`}
            >
              Pay ({String(tollAmount)}c)
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Render a RoundActionState as a compact one-liner suitable for the
 * submitted/resolved badge. Includes target name, commit size, or destination
 * sector where relevant — stops the user from having to hover to see what
 * the agent actually picked.
 */
function formatAction(
  action: RoundActionState,
  encounter: CombatEncounterState,
): string {
  const base = action.action ?? "brace"
  if (base === "attack") {
    const targetName =
      (action.target_id &&
        encounter.participants[action.target_id]?.name) ||
      (action.target_id ? `${action.target_id.slice(0, 8)}…` : "?")
    return `attack → ${targetName}${action.commit ? ` (${action.commit})` : ""}`
  }
  if (base === "flee") {
    return action.destination_sector != null
      ? `flee → sector ${action.destination_sector}`
      : "flee"
  }
  if (base === "pay") {
    const targetName =
      (action.target_id &&
        encounter.participants[action.target_id]?.name) ||
      "toll"
    return `pay → ${targetName}`
  }
  return base
}

// ---- Visual helpers ---------------------------------------------------------

const BAR_TONE: Record<string, { fill: string; dim: string }> = {
  amber: { fill: "bg-amber-400", dim: "bg-amber-400/40" },
  sky: { fill: "bg-sky-400", dim: "bg-sky-400/40" },
  rose: { fill: "bg-rose-400", dim: "bg-rose-400/40" },
}

/**
 * Thin progress bar + numeric value, optionally rendering a per-round delta
 * that floats up (increase) or down (decrease) and fades out. The delta is
 * captured on encounter.round change and auto-clears after the animation.
 */
function StatBar({
  icon,
  label,
  value,
  max,
  delta,
  tone,
}: {
  icon?: React.ReactNode
  label: string
  value: number
  max: number
  delta: number | null
  tone: "amber" | "sky" | "rose"
}) {
  const pct = max > 0 ? Math.max(0, Math.min(1, value / max)) * 100 : 0
  const barColor = BAR_TONE[tone].fill
  return (
    <div className="relative flex-1 min-w-0">
      <div className="flex items-baseline justify-between gap-1.5">
        <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-neutral-500">
          {icon}
          {label}
        </span>
        <span className="tabular-nums text-[11px] text-neutral-200">
          {value}
          <span className="text-neutral-600">/{max}</span>
        </span>
      </div>
      <div className="mt-0.5 h-[3px] w-full overflow-hidden rounded-full bg-neutral-800">
        <div
          className={`h-full rounded-full transition-[width] duration-700 ease-out ${barColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {delta != null && delta !== 0 && <FlyAway delta={delta} tone={tone} />}
    </div>
  )
}

function FlyAway({
  delta,
  tone,
}: {
  delta: number
  tone: "amber" | "sky" | "rose"
}) {
  const negative = delta < 0
  const colorClass = negative
    ? "text-rose-300"
    : tone === "sky"
      ? "text-sky-100"
      : "text-emerald-100"
  // Inline text-shadow gives a glow halo that reads against any tile tint.
  // drop-shadow alone wasn't strong enough on the lighter sky/emerald backgrounds.
  const glow = negative
    ? "0 0 10px rgba(244,63,94,0.85), 0 1px 2px rgba(0,0,0,0.8)"
    : tone === "sky"
      ? "0 0 10px rgba(56,189,248,0.8), 0 1px 2px rgba(0,0,0,0.8)"
      : "0 0 10px rgba(52,211,153,0.8), 0 1px 2px rgba(0,0,0,0.8)"
  return (
    <span
      className={`pointer-events-none absolute right-1 top-0 z-10 select-none text-[14px] font-extrabold tabular-nums tracking-tight ${colorClass} ${
        negative ? "anim-fly-down" : "anim-fly-up"
      }`}
      aria-hidden="true"
      style={{ transform: "translate(-50%, 0)", textShadow: glow }}
    >
      {negative ? "" : "+"}
      {delta}
    </span>
  )
}

/**
 * Returns the delta between the current value and the value seen on the
 * previous round. Fires once per round-change, auto-clears after the
 * fly-away animation finishes so repeated renders don't keep refiring.
 */
function useRoundDelta(value: number, round: number): number | null {
  const lastRound = useRef(round)
  const lastValue = useRef(value)
  const [delta, setDelta] = useState<number | null>(null)

  useEffect(() => {
    if (round === lastRound.current) return
    const d = value - lastValue.current
    lastRound.current = round
    lastValue.current = value
    if (d !== 0) {
      setDelta(d)
      const t = window.setTimeout(() => setDelta(null), 2000)
      return () => window.clearTimeout(t)
    }
    setDelta(null)
    return undefined
  }, [round, value])

  return delta
}

/**
 * True for a brief window immediately after the predicate transitions from
 * false → true. Used to trigger one-shot animations (destroyed shake, toll
 * paid flash) without re-firing on every render.
 */
function useTransitionAnim(active: boolean, ms: number): boolean {
  const wasActive = useRef(active)
  const [flashing, setFlashing] = useState(false)

  useEffect(() => {
    if (active && !wasActive.current) {
      setFlashing(true)
      const t = window.setTimeout(() => setFlashing(false), ms)
      wasActive.current = true
      return () => window.clearTimeout(t)
    }
    if (!active) {
      wasActive.current = false
      setFlashing(false)
    }
    return undefined
  }, [active, ms])

  return flashing
}

