import { useMemo, useState } from "react"

import type { AgentMessage } from "../agent/debug_agent"
import type { DecisionTrace } from "../controllers/types"
import { useAppStore } from "../store/appStore"
import type { CombatEvent, EntityId, RelayDecision } from "../engine/types"
import { decisionFor } from "../relay/event_relay"

interface Props {
  events: readonly CombatEvent[]
}

type Direction = "sent" | "received"

interface RoundGroup {
  kind: "round"
  round: number
  events: CombatEvent[]
}

interface CombatGroup {
  kind: "combat"
  combat_id: string
  sector?: number
  events: CombatEvent[]
  rounds: RoundGroup[]
  tailEvents: CombatEvent[]
  latestTimestamp: number
  ended: boolean
  endState: string | null
}

interface StandaloneNode {
  kind: "standalone"
  event: CombatEvent
  timestamp: number
}

type RootNode = CombatGroup | StandaloneNode

export function EventLog({ events }: Props) {
  const selectedId = useAppStore((s) => s.selectedEntityId)

  const filteredEvents = useMemo(
    () => (selectedId ? events.filter((e) => eventConcerns(e, selectedId)) : events),
    [events, selectedId],
  )
  const tree = useMemo(() => groupEvents(filteredEvents), [filteredEvents])

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto px-4 py-2">
      <div className="mb-2 text-[11px] uppercase tracking-wider text-neutral-500">
        Event log ({filteredEvents.length}
        {selectedId ? (
          <>
            <span className="text-emerald-400"> filtered</span>
            <span className="text-neutral-600"> · {events.length} total</span>
          </>
        ) : null}
        ) · newest first
      </div>
      {tree.length === 0 ? (
        <p className="text-xs text-neutral-600">
          {events.length === 0
            ? "No events yet. Reset the world or create a character."
            : "No events match the selected entity filter yet."}
        </p>
      ) : (
        <ul className="space-y-1">
          {tree.map((node) =>
            node.kind === "combat" ? (
              <CombatGroupView key={node.combat_id} group={node} selectedId={selectedId} />
            ) : (
              <EventRow key={node.event.id} event={node.event} selectedId={selectedId} />
            ),
          )}
        </ul>
      )}
    </div>
  )
}

function groupEvents(events: readonly CombatEvent[]): RootNode[] {
  const combatsById = new Map<string, CombatGroup>()
  const standalone: StandaloneNode[] = []

  for (const e of events) {
    const cid = e.combat_id
    if (cid) {
      let group = combatsById.get(cid)
      if (!group) {
        group = {
          kind: "combat",
          combat_id: cid,
          sector: e.sector_id,
          events: [],
          rounds: [],
          tailEvents: [],
          latestTimestamp: 0,
          ended: false,
          endState: null,
        }
        combatsById.set(cid, group)
      }
      group.events.push(e)
      if (e.timestamp > group.latestTimestamp) group.latestTimestamp = e.timestamp
    } else {
      standalone.push({ kind: "standalone", event: e, timestamp: e.timestamp })
    }
  }

  for (const group of combatsById.values()) {
    const roundMap = new Map<number, CombatEvent[]>()
    for (const e of group.events) {
      const payload = e.payload as Record<string, unknown> | undefined
      const round = typeof payload?.round === "number" ? (payload.round as number) : null

      if (e.type === "combat.ended") {
        group.tailEvents.push(e)
        group.ended = true
        const end = payload?.end ?? payload?.result
        if (typeof end === "string") group.endState = end
        continue
      }

      if (round != null) {
        const list = roundMap.get(round) ?? []
        list.push(e)
        roundMap.set(round, list)
      } else {
        group.tailEvents.push(e)
      }
    }
    // Newest round first — matches the outer "newest first" ordering of
    // combat groups. Events INSIDE a round stay ascending (decisions in
    // order of when they fired) since that's a narrative sequence.
    group.rounds = [...roundMap.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([round, es]) => ({ kind: "round" as const, round, events: es }))
  }

  const root: RootNode[] = [...standalone, ...combatsById.values()]
  root.sort((a, b) => {
    const ta = a.kind === "standalone" ? a.timestamp : a.latestTimestamp
    const tb = b.kind === "standalone" ? b.timestamp : b.latestTimestamp
    return tb - ta
  })
  return root
}

function CombatGroupView({
  group,
  selectedId,
}: {
  group: CombatGroup
  selectedId: EntityId | null
}) {
  const [expanded, setExpanded] = useState(true)
  const roundCount = group.rounds.length
  const status = group.ended ? `ended: ${group.endState ?? "unknown"}` : "active"
  return (
    <li className="rounded border border-emerald-900/40 bg-emerald-950/20">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-baseline gap-2 px-2 py-1 text-left text-xs hover:bg-emerald-950/40"
      >
        <Chevron expanded={expanded} />
        <span className="font-semibold text-emerald-200">combat {group.combat_id}</span>
        <span className="text-[11px] text-neutral-500">
          {group.sector != null ? `sector ${group.sector} · ` : ""}
          {roundCount} round{roundCount === 1 ? "" : "s"} · {status}
        </span>
        <span className="ml-auto text-[11px] text-neutral-600">
          {new Date(group.latestTimestamp).toLocaleTimeString()}
        </span>
      </button>
      {expanded && (
        <ul className="ml-3 space-y-1 border-l border-emerald-900/40 pl-3 pb-2 pr-2">
          {group.ended && <CombatSummaryCard group={group} />}
          {group.rounds.map((round) => (
            <RoundGroupView key={round.round} round={round} selectedId={selectedId} />
          ))}
          {group.tailEvents.map((e) => (
            <EventRow key={e.id} event={e} selectedId={selectedId} />
          ))}
        </ul>
      )}
    </li>
  )
}

interface ShipEndState {
  id: string
  name: string
  ship_type: string
  ship_name: string | null
  /** 0–100 */
  shield_integrity: number | null
  /** 0–100; end-of-combat shield damage from the last resolved round */
  shield_damage: number | null
  fighter_loss: number | null
  corp_id: string | null
  destroyed: boolean
  fled: boolean
}

/**
 * Pulled-out summary of a combat's final state: per-ship outcome (survived,
 * fled, destroyed), final shields, fighter losses. Data comes from the
 * first `combat.ended` event in the group (all recipients share the same
 * `participants[]` snapshot — only the personalized `ship` block differs)
 * plus `ship.destroyed` events for the "destroyed" flag.
 */
function CombatSummaryCard({ group }: { group: CombatGroup }) {
  const summary = useMemo(() => summarizeGroup(group), [group])
  if (!summary) return null
  return (
    <li className="rounded border border-emerald-700/70 bg-emerald-950/40 px-3 py-2">
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="rounded border border-emerald-500 bg-emerald-900/60 px-1 text-[9px] uppercase tracking-wider text-emerald-100">
          ended
        </span>
        <span className="text-[11px] font-semibold text-emerald-100">
          {summary.endState}
        </span>
        <span className="text-[11px] text-neutral-400">
          · {summary.roundCount} round{summary.roundCount === 1 ? "" : "s"}
          {summary.durationMs != null
            ? ` · ${(summary.durationMs / 1000).toFixed(1)}s`
            : ""}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
        {summary.ships.map((s) => (
          <ShipEndCard key={s.id} ship={s} />
        ))}
      </div>
      {summary.ships.length === 0 && (
        <p className="text-[11px] text-neutral-500">No ship participants.</p>
      )}
    </li>
  )
}

function ShipEndCard({ ship }: { ship: ShipEndState }) {
  const outcome = ship.destroyed ? "destroyed" : ship.fled ? "fled" : "survived"
  const outcomeClass = ship.destroyed
    ? "border-rose-700 bg-rose-950/40 text-rose-200"
    : ship.fled
      ? "border-amber-700 bg-amber-950/40 text-amber-200"
      : "border-emerald-700 bg-emerald-950/40 text-emerald-200"
  return (
    <div
      className={`rounded border border-neutral-800 bg-neutral-900/50 px-2 py-1 text-[11px] ${
        ship.destroyed ? "opacity-70" : ""
      }`}
    >
      <div className="flex items-baseline gap-2">
        <span className="font-semibold text-neutral-100">{ship.name}</span>
        <span
          className={`rounded border px-1 text-[9px] uppercase tracking-wider ${outcomeClass}`}
        >
          {outcome}
        </span>
        <span className="font-mono text-[10px] text-neutral-500">
          {ship.ship_type}
          {ship.corp_id ? ` · corp ${ship.corp_id.slice(0, 8)}` : ""}
        </span>
      </div>
      <div className="mt-0.5 flex flex-wrap gap-3 text-[10px] text-neutral-400">
        <span>
          shields:{" "}
          <span className="text-neutral-200">
            {ship.shield_integrity != null
              ? `${Math.round(ship.shield_integrity)}%`
              : "—"}
          </span>
          {ship.shield_damage != null && ship.shield_damage > 0 && (
            <span className="text-rose-300">
              {" "}(−{Math.round(ship.shield_damage)}% final round)
            </span>
          )}
        </span>
        <span>
          fighters lost:{" "}
          <span className="text-neutral-200">
            {ship.fighter_loss != null ? ship.fighter_loss : "—"}
          </span>
        </span>
      </div>
    </div>
  )
}

function summarizeGroup(
  group: CombatGroup,
): {
  endState: string
  roundCount: number
  durationMs: number | null
  ships: ShipEndState[]
} | null {
  // Any combat.ended event works — all recipients share the participants[]
  // snapshot; only the top-level `ship` block is personalized.
  const endedEvent = group.tailEvents.find((e) => e.type === "combat.ended")
  if (!endedEvent) return null
  const payload = (endedEvent.payload ?? {}) as Record<string, unknown>
  const participants = Array.isArray(payload.participants)
    ? (payload.participants as Array<Record<string, unknown>>)
    : []

  const destroyedShipIds = new Set<string>()
  for (const e of group.events) {
    if (e.type !== "ship.destroyed") continue
    const p = (e.payload ?? {}) as Record<string, unknown>
    if (typeof p.ship_id === "string") destroyedShipIds.add(p.ship_id)
  }

  // Flee results from the final round (payload.flee_results is { [pid]: bool }).
  const fleeResults = (payload.flee_results ?? {}) as Record<string, boolean>

  const ships: ShipEndState[] = participants.map((p) => {
    const id = typeof p.id === "string" ? p.id : ""
    const ship = (p.ship ?? {}) as Record<string, unknown>
    const shipId = typeof p.ship_id === "string" ? p.ship_id : null
    const destroyed = !!(shipId && destroyedShipIds.has(shipId))
    const fled = !destroyed && !!fleeResults[id]
    return {
      id,
      name: typeof p.name === "string" ? p.name : id,
      ship_type: typeof ship.ship_type === "string" ? ship.ship_type : "unknown",
      ship_name:
        typeof ship.ship_name === "string" ? ship.ship_name : null,
      shield_integrity:
        typeof ship.shield_integrity === "number" ? ship.shield_integrity : null,
      shield_damage:
        typeof ship.shield_damage === "number" ? ship.shield_damage : null,
      fighter_loss:
        typeof ship.fighter_loss === "number" ? ship.fighter_loss : null,
      corp_id: typeof p.corp_id === "string" ? p.corp_id : null,
      destroyed,
      fled,
    }
  })

  const firstTs = group.events.reduce(
    (min, e) => (e.timestamp < min ? e.timestamp : min),
    Number.POSITIVE_INFINITY,
  )
  const lastTs = group.events.reduce(
    (max, e) => (e.timestamp > max ? e.timestamp : max),
    0,
  )
  const durationMs =
    Number.isFinite(firstTs) && lastTs > firstTs ? lastTs - firstTs : null

  return {
    endState:
      typeof payload.end === "string"
        ? (payload.end as string)
        : typeof payload.result === "string"
          ? (payload.result as string)
          : "unknown",
    roundCount: group.rounds.length,
    durationMs,
    ships,
  }
}

function RoundGroupView({
  round,
  selectedId,
}: {
  round: RoundGroup
  selectedId: EntityId | null
}) {
  const [expanded, setExpanded] = useState(true)
  // Order within a round: sort by event timestamp so LLM decisions, action
  // accepts, and round resolution interleave naturally.
  const sorted = useMemo(
    () => [...round.events].sort((a, b) => a.timestamp - b.timestamp),
    [round.events],
  )
  return (
    <li className="rounded border border-neutral-800 bg-neutral-900/40">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-baseline gap-2 px-2 py-0.5 text-left text-[11px] text-neutral-300 hover:bg-neutral-900/70"
      >
        <Chevron expanded={expanded} />
        <span className="font-semibold text-neutral-200">Round {round.round}</span>
        <span className="text-neutral-500">
          ({sorted.length} event{sorted.length === 1 ? "" : "s"})
        </span>
      </button>
      {expanded && (
        <ul className="ml-3 space-y-1 border-l border-neutral-800 pl-3 pb-2 pr-2">
          {sorted.map((e) => (
            <EventRow key={e.id} event={e} selectedId={selectedId} />
          ))}
        </ul>
      )}
    </li>
  )
}

function EventRow({
  event,
  selectedId,
}: {
  event: CombatEvent
  selectedId: EntityId | null
}) {
  // Special-case the harness-only agent.decision event so the LLM's
  // situation + reasoning + full context sit inline in the event log.
  if (event.type === "agent.decision") {
    return <AgentDecisionRow event={event} />
  }
  return <GenericEventRow event={event} selectedId={selectedId} />
}

function GenericEventRow({
  event,
  selectedId,
}: {
  event: CombatEvent
  selectedId: EntityId | null
}) {
  const [expanded, setExpanded] = useState(false)
  const direction = selectedId ? classifyDirection(event, selectedId) : null
  const typeColor = eventTypeColor(event.type)
  const relayDecision = selectedId ? decisionFor(event, selectedId) : null
  return (
    <li className="rounded border border-neutral-800 bg-neutral-900/60">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-baseline gap-2 px-2 py-1 text-left text-[12px] hover:bg-neutral-900/80"
      >
        <Chevron expanded={expanded} />
        {direction && <DirectionBadge direction={direction} />}
        {relayDecision && <RelayBadge decision={relayDecision} />}
        <span className={`font-semibold ${typeColor}`}>{event.type}</span>
        {event.actor && (
          <span className="text-[11px] text-neutral-500">
            · actor <span className="text-neutral-300">{event.actor}</span>
          </span>
        )}
        <span className="font-mono text-[10px] text-neutral-600">{event.id}</span>
        <span className="ml-auto font-mono text-[10px] text-neutral-600">
          {new Date(event.timestamp).toLocaleTimeString()}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-neutral-800 px-2 py-1">
          <pre className="whitespace-pre-wrap text-[11px] leading-snug text-neutral-400">
            {JSON.stringify(event.payload, null, 2)}
          </pre>
          {event.recipients.length > 0 && (
            <div className="mt-1 text-[11px] text-neutral-500">
              recipients:{" "}
              <span className="font-mono text-neutral-400">{event.recipients.join(", ")}</span>
            </div>
          )}
          {event.relay && event.relay.length > 0 && (
            <div className="mt-1 text-[11px] text-neutral-500">
              <div className="mb-0.5 uppercase tracking-wider text-[9px] text-neutral-600">
                relay decisions (per recipient)
              </div>
              <table className="w-full text-left text-[10px]">
                <tbody>
                  {event.relay.map((d) => (
                    <tr key={d.viewer} className="border-t border-neutral-800/50">
                      <td className="py-0.5 pr-2 font-mono text-neutral-400">
                        {d.viewer}
                      </td>
                      <td className="pr-2 text-neutral-500">{d.appendRule}</td>
                      <td className="pr-2 text-neutral-500">{d.inferenceRule}</td>
                      <td className="pr-2">
                        <span
                          className={
                            d.append ? "text-emerald-400" : "text-neutral-600"
                          }
                        >
                          append={d.append ? "yes" : "no"}
                        </span>
                      </td>
                      <td className="pr-2">
                        <span
                          className={
                            d.run_llm ? "text-amber-300" : "text-neutral-600"
                          }
                        >
                          run_llm={d.run_llm ? "yes" : "no"}
                        </span>
                      </td>
                      <td className="text-neutral-600">{d.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </li>
  )
}

/**
 * Per-event, per-viewer inline badge. Rendered only when a POV entity is
 * selected — shows at a glance whether this event woke that entity's LLM
 * (amber "LLM"), landed silently in context ("ctx"), or was dropped
 * entirely ("—"). Hover reveals the full AppendRule/InferenceRule reason.
 */
function RelayBadge({ decision }: { decision: RelayDecision }) {
  let label: string
  let styles: string
  if (decision.run_llm) {
    label = "LLM"
    styles = "border-amber-500 bg-amber-900/50 text-amber-100"
  } else if (decision.append) {
    label = "ctx"
    styles = "border-cyan-800 bg-cyan-950/40 text-cyan-300"
  } else {
    label = "—"
    styles = "border-neutral-800 bg-neutral-950 text-neutral-600"
  }
  const title =
    `${decision.appendRule} / ${decision.inferenceRule}\n` +
    decision.reason +
    (decision.run_llm
      ? "\nWOULD have triggered LLM inference from this ship's POV."
      : decision.append
        ? "\nAppended to LLM context silently; no inference."
        : "\nNot delivered to this viewer's context.")
  return (
    <span
      title={title}
      className={`rounded border px-1 text-[9px] uppercase tracking-wider ${styles}`}
    >
      {label}
    </span>
  )
}

// ---- Agent decision row -----------------------------------------------------

function AgentDecisionRow({ event }: { event: CombatEvent }) {
  const [expanded, setExpanded] = useState(false)
  const traces = useAppStore((s) => s.traces)
  const payload = (event.payload ?? {}) as Record<string, unknown>
  const traceId = typeof payload.trace_id === "string" ? payload.trace_id : null
  const trace = useMemo(
    () => (traceId ? traces.find((t) => t.id === traceId) : undefined),
    [traces, traceId],
  )

  const situation = typeof payload.situation === "string" ? payload.situation : null
  const reasoning = typeof payload.reasoning === "string" ? payload.reasoning : null
  const actionName = typeof payload.action_name === "string" ? payload.action_name : null
  const actionArgs = (payload.action_args ?? {}) as Record<string, unknown>
  const result = payload.result as { ok?: boolean; reason?: string } | null | undefined
  const latency = typeof payload.latency_ms === "number" ? payload.latency_ms : null
  const model = typeof payload.model === "string" ? payload.model : null
  const error = typeof payload.error === "string" ? payload.error : null
  const text = typeof payload.text === "string" ? payload.text : null

  // When no tool call was returned, surface a snippet of whatever the model
  // DID emit so the user can diagnose without expanding the trace.
  const noToolReply = !actionName && !error && text
    ? `no tool call — model replied: "${text.slice(0, 120)}${text.length > 120 ? "…" : ""}"`
    : null
  const callSummary = actionName
    ? `${actionName}(${summarizeActionArgs(actionArgs)})`
    : error
      ? `error: ${error}`
      : noToolReply ?? "no tool call (empty)"

  return (
    <li className="rounded border border-amber-900/40 bg-amber-950/20">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full flex-col gap-0.5 px-2 py-1 text-left text-xs hover:bg-amber-950/40"
      >
        <div className="flex items-baseline gap-2">
          <Chevron expanded={expanded} />
          <span className="rounded border border-amber-700 bg-amber-950 px-1 text-[9px] uppercase tracking-wider text-amber-300">
            AI
          </span>
          <span className="font-semibold text-neutral-200">{event.actor}</span>
          <span className="text-[11px] text-neutral-400">{callSummary}</span>
          {result && !result.ok && (
            <span className="text-[11px] text-rose-300">· {result.reason}</span>
          )}
          {latency != null && (
            <span className="ml-auto font-mono text-[10px] text-neutral-500">{latency}ms</span>
          )}
          <span className="font-mono text-[10px] text-neutral-600">
            {new Date(event.timestamp).toLocaleTimeString()}
          </span>
        </div>
        {situation && (
          <div className="ml-7 text-[11px] text-amber-200/70">
            <span className="text-neutral-500">situation: </span>
            <span className="italic">{situation}</span>
          </div>
        )}
        {reasoning && (
          <div className="ml-7 text-[11px] text-amber-200/90">
            <span className="text-neutral-500">reasoning: </span>
            <span className="italic">{reasoning}</span>
          </div>
        )}
      </button>
      {expanded && trace && <AgentTraceDetail trace={trace} model={model} />}
      {expanded && !trace && (
        <div className="border-t border-amber-900/40 px-2 py-1 text-[11px] text-neutral-500">
          (trace {traceId} not found — may have been cleared)
        </div>
      )}
    </li>
  )
}

function AgentTraceDetail({
  trace,
  model,
}: {
  trace: DecisionTrace
  model: string | null
}) {
  return (
    <div className="space-y-1.5 border-t border-amber-900/40 px-2 py-1.5 text-[11px]">
      <div className="flex flex-wrap gap-3 text-neutral-500">
        {model && (
          <span>
            model <span className="text-neutral-300">{model}</span>
          </span>
        )}
        {trace.combat_id && (
          <span>
            combat <span className="font-mono text-neutral-300">{trace.combat_id}</span>
          </span>
        )}
        {trace.actionResult && (
          <span>
            result{" "}
            <span
              className={trace.actionResult.ok ? "text-emerald-300" : "text-rose-300"}
            >
              {trace.actionResult.ok ? "OK" : (trace.actionResult.reason ?? "rejected")}
            </span>
          </span>
        )}
      </div>
      {trace.toolCall && (
        <details className="rounded border border-amber-900/40 bg-neutral-950 p-1">
          <summary className="cursor-pointer text-neutral-400">tool call</summary>
          <pre className="mt-1 whitespace-pre-wrap text-[10px] leading-snug text-neutral-400">
            {JSON.stringify(trace.toolCall, null, 2)}
          </pre>
        </details>
      )}
      {trace.text && (
        <details className="rounded border border-cyan-900/40 bg-neutral-950 p-1" open>
          <summary className="cursor-pointer text-neutral-400">
            llm text reply ({trace.text.length} chars)
          </summary>
          <pre className="mt-1 whitespace-pre-wrap text-[10px] leading-snug text-cyan-200">
            {trace.text}
          </pre>
        </details>
      )}
      <details className="rounded border border-neutral-800 bg-neutral-950 p-1">
        <summary className="cursor-pointer text-neutral-400">
          system prompt ({trace.systemPrompt.length.toLocaleString()} chars)
        </summary>
        <pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap text-[10px] leading-snug text-neutral-500">
          {trace.systemPrompt}
        </pre>
      </details>
      {trace.appendedMessages.length > 0 && (
        <details
          className="rounded border border-emerald-900/60 bg-neutral-950 p-1"
          open
        >
          <summary className="cursor-pointer text-emerald-300">
            after the decision ({trace.appendedMessages.length}) — tool result +
            events that fired because of / after this decision
          </summary>
          <div className="mt-1 space-y-1">
            {trace.appendedMessages.map((m, i) => (
              <MessageRow key={i} message={m} />
            ))}
          </div>
        </details>
      )}
      <details className="rounded border border-neutral-800 bg-neutral-950 p-1">
        <summary className="cursor-pointer text-neutral-400">
          messages seen by llm at decide time ({trace.messages.length})
        </summary>
        <div className="mt-1 space-y-1">
          {trace.messages.map((m, i) => (
            <MessageRow key={i} message={m} />
          ))}
        </div>
      </details>
    </div>
  )
}

function MessageRow({ message }: { message: AgentMessage }) {
  const styles: Record<AgentMessage["role"], string> = {
    system: "border-neutral-800 text-neutral-500",
    user: "border-cyan-900/50 text-cyan-300",
    assistant: "border-amber-900/50 text-amber-300",
    tool: "border-violet-900/50 text-violet-300",
  }
  return (
    <div className={`rounded border bg-neutral-900/60 p-1 ${styles[message.role]}`}>
      <div className="text-[9px] uppercase tracking-wider">{message.role}</div>
      {message.content && (
        <pre className="mt-0.5 whitespace-pre-wrap text-[10px] leading-snug text-neutral-300">
          {message.content}
        </pre>
      )}
      {message.tool_call && (
        <pre className="mt-0.5 whitespace-pre-wrap text-[10px] leading-snug text-amber-200">
          → {message.tool_call.name}({JSON.stringify(message.tool_call.arguments)})
        </pre>
      )}
    </div>
  )
}

function summarizeActionArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args).map(([k, v]) => {
    if (k === "combat_id") {
      if (typeof v !== "string") return `combat_id=${JSON.stringify(v)}`
      const short = v.length > 16 ? `${v.slice(0, 12)}…` : v
      return `combat_id="${short}"`
    }
    return `${k}=${JSON.stringify(v)}`
  })
  return entries.join(", ")
}

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <span
      className={`inline-block w-3 text-[10px] text-neutral-500 transition ${
        expanded ? "rotate-90" : ""
      }`}
    >
      ▶
    </span>
  )
}

function DirectionBadge({ direction }: { direction: Direction }) {
  const styles: Record<Direction, string> = {
    sent: "bg-sky-900/50 text-sky-200 border-sky-800",
    received: "bg-violet-900/40 text-violet-200 border-violet-800",
  }
  return (
    <span
      className={`rounded border px-1 py-0 text-[10px] uppercase tracking-wide ${styles[direction]}`}
    >
      {direction}
    </span>
  )
}

function eventTypeColor(type: string): string {
  if (type.startsWith("combat.")) return "text-emerald-300"
  if (type.startsWith("ship.")) return "text-rose-300"
  if (type.startsWith("salvage.")) return "text-amber-300"
  if (type.startsWith("garrison.")) return "text-sky-300"
  if (type.startsWith("corporation.")) return "text-purple-300"
  if (type.startsWith("character.")) return "text-cyan-300"
  if (type.startsWith("agent.")) return "text-orange-300"
  if (type.startsWith("world.")) return "text-neutral-400"
  return "text-neutral-300"
}

function eventConcerns(event: CombatEvent, id: EntityId): boolean {
  if (event.actor === id) return true
  return event.recipients.includes(id)
}

// Self-notifications (actor === selected AND recipients includes selected)
// are classified as "sent" — treat the self-receipt as implicit.
function classifyDirection(event: CombatEvent, id: EntityId): Direction | null {
  const isSender = event.actor === id
  const isReceiver = event.recipients.includes(id)
  if (isSender) return "sent"
  if (isReceiver) return "received"
  return null
}
