import { DebugAgent } from "../agent/debug_agent"
import { OpenAILLMClient } from "../agent/openai_client"
import {
  buildCorporationInfoFromWorld,
  buildStatusFromWorld,
} from "../agent/status"
import type { InMemoryEmitter } from "../engine/emitter"
import type { CombatEngine } from "../engine/engine"
import type {
  CharacterId,
  CombatEvent,
  CorpId,
  ShipId,
} from "../engine/types"
import type { ControllerConfig, DecisionTrace } from "./types"

export interface ControllerManagerOpts {
  engine: CombatEngine
  emitter: InMemoryEmitter
  /** Called after every LLM decision with a full snapshot + result. */
  onTrace: (trace: DecisionTrace) => void
  /** Optional in-flight indicator — fires true on decide start, false on finish. */
  onInFlight?: (entityId: string, inFlight: boolean) => void
  /** Lookup current controller config for an entity (usually reads Zustand). */
  getController: (entityId: string) => ControllerConfig | undefined
}

/**
 * Owns per-entity LLM agents and drives them off the engine's event stream.
 * When combat.round_waiting fires, finds every participant whose controller
 * is "llm", defers to a microtask so the agent's own subscriber can finish
 * appending the event to its context, then calls `agent.decideAndCommit()`
 * and captures the full context + tool call + result as a DecisionTrace.
 */
export class ControllerManager {
  private readonly engine: CombatEngine
  private readonly emitter: InMemoryEmitter
  private readonly onTrace: (trace: DecisionTrace) => void
  private readonly onInFlight?: (entityId: string, inFlight: boolean) => void
  private readonly getController: (entityId: string) => ControllerConfig | undefined

  private agents = new Map<string, DebugAgent>()
  private unsubscribe: (() => void) | null = null
  private traceCounter = 0

  constructor(opts: ControllerManagerOpts) {
    this.engine = opts.engine
    this.emitter = opts.emitter
    this.onTrace = opts.onTrace
    this.onInFlight = opts.onInFlight
    this.getController = opts.getController
  }

  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.emitter.subscribe((event) => this.handleEvent(event))
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    for (const agent of this.agents.values()) agent.stop()
    this.agents.clear()
  }

  /** Tear down an agent when its controller is removed or switched to manual. */
  dropController(entityId: string): void {
    const agent = this.agents.get(entityId)
    if (!agent) return
    agent.stop()
    this.agents.delete(entityId)
  }

  private handleEvent(event: CombatEvent): void {
    // World reset nukes the engine's id counters (idSeq back to 0), so
    // agent contexts attached to the old char/combat ids are now stale and
    // their replays would be poisoned by `world.reset` + fresh events
    // sharing the same ids. Drop all agents so the next combat round
    // lazily recreates clean ones.
    if (event.type === "world.reset") {
      for (const agent of this.agents.values()) agent.stop()
      this.agents.clear()
      return
    }
    if (event.type !== "combat.round_waiting") return
    const payload = event.payload as Record<string, unknown> | undefined
    const participants = Array.isArray(payload?.participants)
      ? (payload.participants as Array<Record<string, unknown>>)
      : []
    const combatId = (event.combat_id as string | undefined) ?? null
    const encounter = combatId
      ? this.engine.getWorldSnapshot().activeCombats.get(combatId as never)
      : null
    for (const p of participants) {
      const id = typeof p.id === "string" ? p.id : null
      if (!id) continue
      // Skip destroyed participants. Production keeps them in the payload +
      // recipients — so its TaskAgent still gets invoked and burns tokens on
      // a guaranteed-reject action (engine.submitAction bounces any action
      // from a 0-fighter participant). The harness stays production-shaped
      // on event payloads but short-circuits agent invocation here — saves
      // API calls + keeps the event log uncluttered. If you want to mirror
      // production's "agent invoked for corpses" behaviour, delete this block.
      const liveParticipant = encounter?.participants[id]
      if (liveParticipant && (liveParticipant.fighters ?? 0) <= 0) continue
      const config = this.getController(id)
      if (config?.kind !== "llm") continue
      // Defer: let every synchronous listener (notably the participating
      // agent's own subscription) append this event to its context BEFORE
      // we invoke decide(). Otherwise the LLM sees a stale context.
      queueMicrotask(() => {
        this.runDecision(id, event, config).catch((err) => {
          console.error("ControllerManager.runDecision failed", err)
        })
      })
    }
  }

  private async runDecision(
    entityId: string,
    event: CombatEvent,
    config: ControllerConfig,
  ): Promise<void> {
    const agent = this.ensureAgent(entityId, config)
    if (!agent) return

    const started = Date.now()
    const combatId = event.combat_id ?? null
    const round =
      typeof (event.payload as Record<string, unknown> | undefined)?.round === "number"
        ? ((event.payload as Record<string, unknown>).round as number)
        : null
    this.traceCounter += 1
    const id = `trace-${started}-${this.traceCounter}`

    // Capture BEFORE decide() — this is the "what did the LLM see?" snapshot.
    const ctxBefore = agent.getContext()
    const beforeLen = ctxBefore.messages.length

    // Ref-counted: inFlight gets incremented here and decremented exactly
    // once in finally. Lets the "thinking" badge survive a second decision
    // queued for the same entity while the first is still awaiting the LLM.
    this.onInFlight?.(entityId, true)
    try {
      const outcome = await agent.decideAndCommit()
      // Everything pushed onto the agent's context after the ctxBefore
      // snapshot — tool call, tool result, action_accepted XML, and any
      // round_resolved / round_waiting(next) / combat.ended XML that landed
      // inside this same sync commit (when the last submit triggered
      // resolution). Exposes "what happened because of this decision" in
      // the same trace, without the user having to jump to the next round.
      const appended = agent.getContext().messages.slice(beforeLen)
      const trace = {
        id,
        characterId: entityId,
        combat_id: combatId,
        round,
        timestamp: started,
        systemPrompt: ctxBefore.system,
        messages: ctxBefore.messages,
        appendedMessages: appended,
        toolCall: outcome.call,
        text: outcome.text,
        actionResult: outcome.result,
        latencyMs: Date.now() - started,
        model: config.model ?? null,
      }
      this.onTrace(trace)
      this.emitAgentDecisionEvent(trace)
    } catch (err) {
      const appended = agent.getContext().messages.slice(beforeLen)
      const trace = {
        id,
        characterId: entityId,
        combat_id: combatId,
        round,
        timestamp: started,
        systemPrompt: ctxBefore.system,
        messages: ctxBefore.messages,
        appendedMessages: appended,
        toolCall: null,
        text: null,
        actionResult: null,
        latencyMs: Date.now() - started,
        model: config.model ?? null,
        error: err instanceof Error ? err.message : String(err),
      }
      this.onTrace(trace)
      this.emitAgentDecisionEvent(trace)
    } finally {
      this.onInFlight?.(entityId, false)
    }
  }

  private ensureAgent(
    entityId: string,
    config: ControllerConfig,
  ): DebugAgent | null {
    const existing = this.agents.get(entityId)
    if (existing) return existing

    const world = this.engine.getWorldSnapshot()
    let status
    try {
      status = buildStatusFromWorld(world, entityId as CharacterId)
    } catch {
      // Entity is neither a character nor a corp-ship pseudo — skip.
      return null
    }

    let corporation
    const char = world.characters.get(entityId as CharacterId)
    const pseudoShip = !char ? world.ships.get(entityId as unknown as ShipId) : undefined
    const effectiveCorp =
      char?.corpId ?? pseudoShip?.ownerCorpId ?? undefined
    if (effectiveCorp) {
      try {
        corporation = buildCorporationInfoFromWorld(world, effectiveCorp as CorpId)
      } catch {
        // Corp deleted between snapshot read and now — no-op.
      }
    }

    const agent = new DebugAgent({
      engine: this.engine,
      emitter: this.emitter,
      characterId: entityId,
      status,
      corporation,
      includeCombatStrategyFragment: true,
      strategy: config.strategy,
      customStrategy: config.customStrategy,
      llm: new OpenAILLMClient({ model: config.model }),
    })
    agent.start("You are in combat. Decide and submit an action for each round.")

    // Replay every event already in the emitter log so the agent's context
    // includes the combat.round_waiting (and anything earlier the character
    // was scoped to). Without this, a lazily-created agent has no concrete
    // combat_id or participants[] to copy into its tool call and will
    // hallucinate — e.g. combat_id="combat-0001", target_id="participant-1".
    agent.replayEvents(this.emitter.getLog())

    this.agents.set(entityId, agent)
    return agent
  }

  /**
   * Eagerly create an agent for an entity — called when a controller is set
   * to LLM from the UI. Ensures the agent's emitter subscription is in place
   * BEFORE any combat event fires, so no replay is needed in the common path.
   * Safe to call before the entity exists (returns silently if status can't
   * be built).
   */
  ensureAgentNow(entityId: string, config: ControllerConfig): void {
    if (config.kind !== "llm") return
    this.ensureAgent(entityId, config)
  }

  /**
   * Fire a synthetic `agent.decision` event into the emitter so the EventLog
   * can render it inline in its combat-group tree. Harness-only event —
   * `toAgentEventXml` filters it out, so agents' own contexts don't grow from
   * other agents' decisions.
   */
  private emitAgentDecisionEvent(trace: DecisionTrace): void {
    const args = (trace.toolCall?.arguments ?? {}) as Record<string, unknown>
    const actionArgs: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(args)) {
      if (k === "situation" || k === "reasoning") continue
      actionArgs[k] = v
    }
    const payload: Record<string, unknown> = {
      trace_id: trace.id,
      round: trace.round,
      action_name: trace.toolCall?.name ?? null,
      action_args: actionArgs,
      situation: typeof args.situation === "string" ? args.situation : null,
      reasoning: typeof args.reasoning === "string" ? args.reasoning : null,
      result: trace.actionResult,
      latency_ms: trace.latencyMs,
      model: trace.model,
      text: trace.text,
      error: trace.error ?? null,
    }
    this.emitter.emit({
      id: `agentev-${trace.id}`,
      type: "agent.decision",
      payload,
      recipients: [trace.characterId as never],
      actor: trace.characterId as never,
      combat_id: (trace.combat_id ?? undefined) as never,
      timestamp: trace.timestamp,
    })
  }
}
