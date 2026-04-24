import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import type { AgentMessage } from "../agent/debug_agent"
import {
  OpenAILLMClient,
  hasOpenAIKey,
} from "../agent/openai_client"
import type { DecisionTrace } from "../controllers/types"
import type { CombatEvent, World } from "../engine/types"
import { useAppStore } from "../store/appStore"

interface Props {
  events: readonly CombatEvent[]
  world: World
  open: boolean
  onClose: () => void
}

// gpt-4.1 has a large context window + long-form prose quality without the
// reasoning-token trap of gpt-5 family models. (When a reasoning model is
// given only 4096 max_completion_tokens, it can spend them all on hidden
// reasoning and return empty content — which looks like "(model returned no
// text)" in this modal.) If you want to step up, override the dropdown.
const DEFAULT_SUMMARY_MODEL = "gpt-4.1"

interface Turn {
  role: "user" | "assistant"
  content: string
}

/**
 * Opens a read-only summary of everything that happened in combat so far —
 * built by handing a "bigger" OpenAI model a chronological digest of every
 * LLM decision + every round outcome. Does NOT touch agent state or the
 * event log; the summary + any follow-up conversation lives entirely in
 * this modal.
 */
export function SummarizeModal({ events, world, open, onClose }: Props) {
  const traces = useAppStore((s) => s.traces)
  const [turns, setTurns] = useState<Turn[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [elapsed, setElapsed] = useState<number | null>(null)
  const [model, setModel] = useState<string>(DEFAULT_SUMMARY_MODEL)
  const [pov, setPov] = useState<string | null>(null)
  const [draft, setDraft] = useState("")
  const bottomRef = useRef<HTMLDivElement>(null)

  const digest = useMemo(
    () => (open ? buildDigest(events, world, traces, pov) : null),
    [open, events, world, traces, pov],
  )

  // Dropdown options: every distinct recipient across the event log, labelled
  // via world. Recipients-only (not world iteration) ensures the list is
  // scoped to entities that actually have something to show.
  const povOptions = useMemo(() => {
    if (!open) return []
    const ids = new Set<string>()
    for (const ev of events) for (const r of ev.recipients) ids.add(r)
    const opts: Array<{ id: string; label: string }> = []
    for (const id of ids) {
      const char = world.characters.get(id as never)
      if (char) {
        opts.push({ id, label: char.name })
        continue
      }
      const ship = world.ships.get(id as never)
      if (ship) {
        opts.push({ id, label: `${ship.name ?? ship.type} (corp ship)` })
        continue
      }
      opts.push({ id, label: id.length > 24 ? `${id.slice(0, 24)}…` : id })
    }
    opts.sort((a, b) => a.label.localeCompare(b.label))
    return opts
  }, [open, events, world])

  const runCompletion = useCallback(
    async (messages: AgentMessage[]): Promise<string | null> => {
      if (!hasOpenAIKey()) {
        setError(
          "No OpenAI API key available. Reload the app to enter one via the gate, or set VITE_OPENAI_API_KEY in .env.",
        )
        return null
      }
      setLoading(true)
      setError(null)
      const started = Date.now()
      try {
        const client = new OpenAILLMClient({
          model,
          maxTokens: 16_384,
          timeoutMs: 180_000,
        })
        const result = await client.complete(
          { system: SUMMARY_SYSTEM_PROMPT, messages },
          { tools: [] },
        )
        setElapsed(Date.now() - started)
        if (result.text) return result.text
        const parts: string[] = []
        if (result.refusal) parts.push(`refusal: ${result.refusal}`)
        if (result.finishReason === "length")
          parts.push(
            "finish_reason=length — the model ran out of tokens (likely reasoning tokens on a gpt-5/o-family model). Increase maxTokens or switch to gpt-4.1.",
          )
        else if (result.finishReason === "content_filter")
          parts.push("finish_reason=content_filter — response was filtered.")
        else if (result.finishReason)
          parts.push(`finish_reason=${result.finishReason}`)
        if (parts.length === 0) parts.push("Model returned no text content.")
        setError(parts.join(" "))
        // eslint-disable-next-line no-console
        console.warn("SummarizeModal: empty text response", result)
        return null
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        setElapsed(Date.now() - started)
        return null
      } finally {
        setLoading(false)
      }
    },
    [model],
  )

  const runSummary = useCallback(async () => {
    if (!digest) return
    setTurns([])
    setError(null)
    const text = await runCompletion([{ role: "user", content: digest }])
    if (text != null) {
      setTurns([{ role: "assistant", content: text }])
    }
  }, [digest, runCompletion])

  const sendFollowUp = useCallback(async () => {
    const trimmed = draft.trim()
    if (!trimmed || !digest || loading) return
    // Build the full conversation: seed with the digest, then the prior
    // assistant turn(s), then all follow-up Qs/As, then the new question.
    const messages: AgentMessage[] = [{ role: "user", content: digest }]
    for (const t of turns) messages.push({ role: t.role, content: t.content })
    messages.push({ role: "user", content: trimmed })
    const userTurn: Turn = { role: "user", content: trimmed }
    setTurns((prev) => [...prev, userTurn])
    setDraft("")
    const reply = await runCompletion(messages)
    if (reply != null) {
      setTurns((prev) => [...prev, { role: "assistant", content: reply }])
    }
  }, [draft, digest, loading, runCompletion, turns])

  // Reset local state when the modal closes. Do NOT auto-run the summary —
  // the user clicks Summarize explicitly so they can pick a POV first.
  useEffect(() => {
    if (!open) {
      setTurns([])
      setError(null)
      setElapsed(null)
      setDraft("")
      setPov(null)
    }
  }, [open])

  // Changing POV invalidates any existing summary — clear turns so the
  // button flips back to "Summarize" and the user regenerates against the
  // new context.
  useEffect(() => {
    setTurns([])
    setError(null)
    setElapsed(null)
  }, [pov])

  // Auto-scroll the conversation to the bottom on new turns.
  useEffect(() => {
    if (!open) return
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }, [turns, loading, open])

  const handleCopySummary = useCallback(async () => {
    const last = [...turns].reverse().find((t) => t.role === "assistant")
    if (!last) return
    try {
      await navigator.clipboard.writeText(last.content)
    } catch {
      /* clipboard unavailable; user can select manually */
    }
  }, [turns])

  if (!open) return null

  const digestSize = digest?.length ?? 0
  const hasSummary = turns.some((t) => t.role === "assistant")

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-black/70 p-4 pt-12"
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl rounded-lg border border-neutral-800 bg-neutral-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-2">
          <div>
            <h2 className="text-sm font-semibold tracking-wide text-neutral-100">
              Combat summary
            </h2>
            <p className="text-[11px] text-neutral-500">
              Narrative analysis of every round so far. After the summary
              lands, ask follow-up questions to dig into specific rounds or
              agents.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded bg-neutral-800 px-2 py-1 text-sm text-neutral-300 hover:bg-neutral-700"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-neutral-800 px-4 py-2 text-[11px] text-neutral-500">
          <label className="flex items-center gap-1.5">
            <span>model</span>
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={loading}
              className="rounded bg-neutral-800 px-2 py-0.5 font-mono text-[11px] text-neutral-200 disabled:opacity-50"
            />
          </label>
          <label className="flex items-center gap-1.5">
            <span>POV</span>
            <select
              value={pov ?? ""}
              onChange={(e) => setPov(e.target.value === "" ? null : e.target.value)}
              disabled={loading}
              className="rounded bg-neutral-800 px-2 py-0.5 font-mono text-[11px] text-neutral-200 disabled:opacity-50"
            >
              <option value="">entire event log</option>
              {povOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <span>{traces.length} decisions</span>
          <span>{events.length} events</span>
          <span>
            digest {digestSize.toLocaleString()} char
            {digestSize === 1 ? "" : "s"}
          </span>
          {elapsed != null && (
            <span className="text-neutral-400">last {(elapsed / 1000).toFixed(1)}s</span>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => runSummary()}
              disabled={loading || !digest}
              className="rounded bg-emerald-900/40 px-3 py-1 text-xs text-emerald-200 hover:bg-emerald-900/60 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {loading && turns.length === 0
                ? "…summarizing"
                : hasSummary
                  ? "Regenerate"
                  : "Summarize"}
            </button>
            {hasSummary && (
              <button
                type="button"
                onClick={handleCopySummary}
                className="rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-200 hover:bg-neutral-700"
                title="Copy the latest summary"
              >
                Copy
              </button>
            )}
          </div>
        </div>

        <div className="max-h-[60vh] overflow-auto px-4 py-3">
          {error && (
            <div className="mb-2 rounded border border-rose-900/60 bg-rose-950/40 px-3 py-2 text-xs text-rose-200">
              {error}
            </div>
          )}
          {loading && turns.length === 0 && (
            <div className="text-xs text-neutral-500">
              Sending digest to {model}… this may take a while on a large
              session.
            </div>
          )}
          {turns.length > 0 && (
            <div className="space-y-3">
              {turns.map((t, i) => (
                <TurnBubble key={i} turn={t} />
              ))}
              {loading && turns[turns.length - 1]?.role === "user" && (
                <div className="text-[11px] italic text-neutral-500">
                  …thinking
                </div>
              )}
              <div ref={bottomRef} />
            </div>
          )}
          {!loading && turns.length === 0 && !error && (
            <div className="text-xs text-neutral-500">
              {events.length === 0 && traces.length === 0
                ? "No events or LLM decisions recorded yet. Play a round first."
                : `Ready. Click "Summarize" to generate a narrative${
                    pov
                      ? ` from ${
                          povOptions.find((o) => o.id === pov)?.label ??
                          "the selected entity"
                        }'s POV`
                      : " of the entire event log"
                  }.`}
            </div>
          )}
        </div>

        {hasSummary && (
          <div className="border-t border-neutral-800 px-4 py-2">
            <div className="flex items-end gap-2">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault()
                    sendFollowUp()
                  }
                }}
                placeholder="Ask a follow-up question… (⌘/Ctrl+Enter to send)"
                rows={2}
                disabled={loading}
                className="flex-1 resize-none rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-xs text-neutral-200 placeholder:text-neutral-600 disabled:opacity-50"
              />
              <button
                type="button"
                onClick={sendFollowUp}
                disabled={!draft.trim() || loading}
                className="rounded bg-emerald-900/40 px-3 py-1 text-xs text-emerald-200 hover:bg-emerald-900/60 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {loading && turns[turns.length - 1]?.role === "user"
                  ? "…"
                  : "Send"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function TurnBubble({ turn }: { turn: Turn }) {
  const isUser = turn.role === "user"
  return (
    <div
      className={`rounded border px-3 py-2 text-xs leading-relaxed ${
        isUser
          ? "border-cyan-900/60 bg-cyan-950/30 text-cyan-100"
          : "border-neutral-800 bg-neutral-900/50 text-neutral-200"
      }`}
    >
      <div
        className={`mb-1 text-[9px] uppercase tracking-wider ${
          isUser ? "text-cyan-400" : "text-neutral-500"
        }`}
      >
        {isUser ? "you" : "assistant"}
      </div>
      <div className="whitespace-pre-wrap">{turn.content}</div>
    </div>
  )
}

const SUMMARY_SYSTEM_PROMPT = `You are a combat analyst for the Gradient Bang combat sim. On the first user message you receive a chronological digest of a combat session: each encounter's participants, every AI agent's per-round decision (including the agent's own stated situation + reasoning), and the engine-computed round outcomes.

Your task on that first turn: write a concise, readable narrative summary that makes it easy for a developer to see WHAT HAPPENED and WHY.

Structure:
1. **Session overview** — one paragraph: how many encounters, where, who fought, how they ended.
2. **Per-encounter breakdown** — for each encounter:
   - One line with sector, participants (name + ship type), round count, final result.
   - Round-by-round narrative as a short bulleted list. For each round:
     - What each agent observed (quote the agent's \`situation\` if tersely worded)
     - What each agent decided and WHY (quote the \`reasoning\`)
     - What the engine resolved (hits, losses, shield damage, fighters remaining — only the numbers that actually moved)
3. **Agent retrospective** — one or two sentences per agent: did their reasoning hold up? Any notable patterns (consistent bracing, chased a bad target, underestimated opponent shields)?

After the initial summary, the user may ask follow-up questions about any round, agent, or decision. Answer them directly, grounded in the digest. If the question references a round or agent that isn't in the digest, say so. Keep answers tight — a few sentences is usually right — and quote from the digest when it helps.

When asked whether a specific viewer received an event (e.g. "did Bob see garrison.destroyed?"): consult the "Destruction events" block's \`recipients: […]\` line and the \`relay:\` line. Those are authoritative — \`append=yes\` means the event landed in that viewer's LLM context, \`run_llm=yes\` means inference was triggered on it. Do NOT infer receipt from the agent's situation text alone.

Style:
- Be specific. Use ship names, numbers, and the agents' own words where they're punchy.
- Call out contradictions between an agent's stated reasoning and the actual outcome.
- Don't invent data — only summarize what's in the digest.
- Plain markdown. No tables. Keep it tight.`

/** Build the input digest passed to the summary model. */
function buildDigest(
  events: readonly CombatEvent[],
  world: World,
  traces: DecisionTrace[],
  pov: string | null,
): string {
  // Map entity ids → display name. Characters live in world.characters;
  // corp-ship pseudo-characters live in world.ships (id === ship.id).
  const nameFor = (id: string | null | undefined): string => {
    if (!id) return "?"
    const char = world.characters.get(id as never)
    if (char) return `${char.name}`
    const ship = world.ships.get(id as never)
    if (ship) return `${ship.name ?? ship.type} (corp ship)`
    return id.slice(0, 8)
  }

  // When POV is set, narrow the digest to what that entity actually saw and
  // did: events where it was a recipient, decisions where it was the actor.
  // Participants of combats the POV wasn't involved in drop out entirely.
  const filteredEvents = pov
    ? events.filter((ev) => ev.recipients.includes(pov as never))
    : events
  const filteredTraces = pov
    ? traces.filter((t) => t.characterId === pov)
    : traces

  // Group events by combat_id. Preserve chronological order.
  type CombatGroup = {
    combat_id: string
    sector_id: number | null
    participants: Array<Record<string, unknown>>
    rounds: Map<number, { waiting?: CombatEvent; resolved?: CombatEvent }>
    ended: CombatEvent | null
    destroyed: CombatEvent[]
  }
  const groups = new Map<string, CombatGroup>()
  for (const ev of filteredEvents) {
    const cid = (ev.combat_id as string | undefined) ?? null
    if (!cid) continue
    if (!groups.has(cid)) {
      groups.set(cid, {
        combat_id: cid,
        sector_id: null,
        participants: [],
        rounds: new Map(),
        ended: null,
        destroyed: [],
      })
    }
    const g = groups.get(cid)!
    const payload = (ev.payload ?? {}) as Record<string, unknown>
    if (typeof payload.round === "number") {
      if (!g.rounds.has(payload.round)) {
        g.rounds.set(payload.round, {})
      }
      const r = g.rounds.get(payload.round)!
      if (ev.type === "combat.round_waiting") r.waiting = ev
      if (ev.type === "combat.round_resolved") r.resolved = ev
    }
    if (ev.type === "combat.round_waiting" && Array.isArray(payload.participants)) {
      g.participants = payload.participants as Array<Record<string, unknown>>
      if (typeof (ev.sector_id as unknown) === "number") g.sector_id = ev.sector_id as number
    }
    if (ev.type === "combat.ended") g.ended = ev
    if (ev.type === "ship.destroyed" || ev.type === "garrison.destroyed") {
      g.destroyed.push(ev)
    }
  }

  // Group traces by combat_id + round.
  const tracesByCombatRound = new Map<string, DecisionTrace[]>()
  for (const t of filteredTraces) {
    if (!t.combat_id || t.round == null) continue
    const key = `${t.combat_id}:${t.round}`
    if (!tracesByCombatRound.has(key)) tracesByCombatRound.set(key, [])
    tracesByCombatRound.get(key)!.push(t)
  }

  const out: string[] = []
  out.push(`# Combat digest`)
  out.push("")
  if (pov) {
    out.push(
      `**POV filter:** ${nameFor(pov)} [${pov}] — only events this entity received and decisions it made are included. Actions or observations by other agents are NOT in this digest.`,
    )
    out.push("")
  }
  out.push(
    `Sessions: ${groups.size} encounter(s), ${filteredTraces.length} LLM decision(s).`,
  )
  out.push("")

  const orderedGroups = Array.from(groups.values()).sort((a, b) => {
    const aFirst = firstEventTimestamp(a, filteredEvents) ?? 0
    const bFirst = firstEventTimestamp(b, filteredEvents) ?? 0
    return aFirst - bFirst
  })

  for (const g of orderedGroups) {
    const endedPayload = (g.ended?.payload ?? {}) as Record<string, unknown>
    const endState = endedPayload.end ?? endedPayload.result ?? "ongoing"
    out.push(
      `## Combat ${g.combat_id} — sector ${g.sector_id ?? "?"} — ${g.rounds.size} round(s) — ended: ${endState}`,
    )
    if (g.participants.length > 0) {
      out.push("Participants:")
      for (const p of g.participants) {
        const id = typeof p.id === "string" ? p.id : "?"
        const name = typeof p.name === "string" ? p.name : nameFor(id)
        const shipType =
          typeof p.ship === "object" && p.ship
            ? ((p.ship as Record<string, unknown>).ship_type as string | undefined)
            : undefined
        const corp = typeof p.corp_id === "string" ? p.corp_id : null
        out.push(
          `- ${name} [${id}]${shipType ? ` · ${shipType}` : ""}${corp ? ` · corp ${corp}` : ""}`,
        )
      }
    }
    out.push("")

    const roundNums = Array.from(g.rounds.keys()).sort((a, b) => a - b)
    for (const rn of roundNums) {
      const r = g.rounds.get(rn)!
      out.push(`### Round ${rn}`)
      const decisions = tracesByCombatRound.get(`${g.combat_id}:${rn}`) ?? []
      if (decisions.length === 0) {
        out.push("_no LLM decisions recorded this round (manual control or timeout)_")
      } else {
        for (const d of decisions) {
          const args = (d.toolCall?.arguments ?? {}) as Record<string, unknown>
          const situation = typeof args.situation === "string" ? args.situation : null
          const reasoning = typeof args.reasoning === "string" ? args.reasoning : null
          const action = typeof args.action === "string" ? args.action : d.toolCall?.name ?? "no-tool"
          const target = typeof args.target_id === "string" ? args.target_id : null
          const commit = typeof args.commit === "number" ? args.commit : null
          const toSector =
            typeof args.to_sector === "number" ? args.to_sector : null
          const result = d.actionResult
          const parts: string[] = []
          parts.push(`action=${action}`)
          if (target) parts.push(`target=${nameFor(target)}`)
          if (commit != null) parts.push(`commit=${commit}`)
          if (toSector != null) parts.push(`to_sector=${toSector}`)
          if (result) parts.push(`result=${result.ok ? "ok" : `reject(${result.reason ?? "?"})`}`)
          if (d.error) parts.push(`error=${d.error}`)
          out.push(`- **${nameFor(d.characterId)}** [${d.model ?? "?"}, ${d.latencyMs}ms] — ${parts.join(", ")}`)
          if (situation) out.push(`  situation: ${situation}`)
          if (reasoning) out.push(`  reasoning: ${reasoning}`)
          if (d.text && !d.toolCall) out.push(`  text-only reply: ${d.text}`)
        }
      }
      if (r.resolved) {
        const p = r.resolved.payload as Record<string, unknown>
        const hits = p.hits as Record<string, number> | undefined
        const offLoss = p.offensive_losses as Record<string, number> | undefined
        const defLoss = p.defensive_losses as Record<string, number> | undefined
        const shieldLoss = p.shield_loss as Record<string, number> | undefined
        const fightersRem = p.fighters_remaining as Record<string, number> | undefined
        const shieldsRem = p.shields_remaining as Record<string, number> | undefined
        const endState = p.end ?? p.result ?? "in_progress"
        const lines: string[] = [`outcome: ${endState}`]
        if (hits && hasNonZero(hits))
          lines.push(`  hits: ${summarizeMap(hits, nameFor)}`)
        if (offLoss && hasNonZero(offLoss))
          lines.push(`  offensive_losses: ${summarizeMap(offLoss, nameFor)}`)
        if (defLoss && hasNonZero(defLoss))
          lines.push(`  defensive_losses: ${summarizeMap(defLoss, nameFor)}`)
        if (shieldLoss && hasNonZero(shieldLoss))
          lines.push(`  shield_loss: ${summarizeMap(shieldLoss, nameFor)}`)
        if (fightersRem)
          lines.push(`  fighters_remaining: ${summarizeMap(fightersRem, nameFor)}`)
        if (shieldsRem)
          lines.push(`  shields_remaining: ${summarizeMap(shieldsRem, nameFor)}`)
        for (const line of lines) out.push(line)
      } else {
        out.push("_round not yet resolved_")
      }
      out.push("")
    }

    if (g.destroyed.length > 0) {
      out.push("### Destruction events")
      for (const ev of g.destroyed) {
        const p = ev.payload as Record<string, unknown>
        if (ev.type === "ship.destroyed") {
          const label = `${p.ship_name ?? p.ship_type ?? "?"} (${p.player_type ?? "?"})`
          const pilot = p.player_name ?? "unknown"
          out.push(
            `- ship.destroyed: ${label} [ship_id=${p.ship_id}] · pilot ${pilot}`,
          )
        } else {
          // garrison.destroyed
          const owner = p.owner_name ?? "unknown"
          const mode = p.mode ?? "?"
          out.push(
            `- garrison.destroyed: [garrison_id=${p.garrison_id}] · owner ${owner} · mode ${mode}`,
          )
        }
        // Recipient + relay-decision line so the summarizer can answer
        // "did X receive this event?" and "did X's agent wake up?"
        // authoritatively, rather than inferring from agent situation text.
        const recipients = ev.recipients.map((r) => nameFor(r)).join(", ")
        out.push(`  recipients: [${recipients}]`)
        if (ev.relay && ev.relay.length > 0) {
          const signals = ev.relay
            .map((d) => {
              const who = nameFor(d.viewer)
              const parts: string[] = []
              parts.push(`append=${d.append ? "yes" : "no"}`)
              parts.push(`run_llm=${d.run_llm ? "yes" : "no"}`)
              return `${who} (${parts.join(", ")})`
            })
            .join("; ")
          out.push(`  relay: ${signals}`)
        }
      }
      out.push("")
    }

    if (g.ended) {
      const p = g.ended.payload as Record<string, unknown>
      out.push(`Final state: ${p.end ?? p.result ?? "?"}`)
      out.push("")
    }
  }

  return out.join("\n")
}

function firstEventTimestamp(
  g: { combat_id: string },
  events: readonly CombatEvent[],
): number | null {
  for (const ev of events) {
    if (ev.combat_id === g.combat_id) return ev.timestamp
  }
  return null
}

function hasNonZero(m: Record<string, number>): boolean {
  for (const v of Object.values(m)) if (v && v !== 0) return true
  return false
}

function summarizeMap(
  m: Record<string, number>,
  nameFor: (id: string) => string,
): string {
  const parts: string[] = []
  for (const [id, v] of Object.entries(m)) {
    if (v == null || v === 0) continue
    const pretty = typeof v === "number" ? (Number.isInteger(v) ? v : v.toFixed(1)) : v
    parts.push(`${nameFor(id)}=${pretty}`)
  }
  return parts.join(", ") || "none"
}
