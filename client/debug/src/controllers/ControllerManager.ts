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
    if (event.type !== "combat.round_waiting") return
    const payload = event.payload as Record<string, unknown> | undefined
    const participants = Array.isArray(payload?.participants)
      ? (payload.participants as Array<Record<string, unknown>>)
      : []
    for (const p of participants) {
      const id = typeof p.id === "string" ? p.id : null
      if (!id) continue
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
    this.onInFlight?.(entityId, true)
    // Capture BEFORE decide() — this is the "what did the LLM see?" snapshot.
    const ctxBefore = agent.getContext()
    this.traceCounter += 1
    const id = `trace-${started}-${this.traceCounter}`
    const combatId = event.combat_id ?? null
    const round =
      typeof (event.payload as Record<string, unknown> | undefined)?.round === "number"
        ? ((event.payload as Record<string, unknown>).round as number)
        : null

    try {
      const outcome = await agent.decideAndCommit()
      this.onTrace({
        id,
        characterId: entityId,
        combat_id: combatId,
        round,
        timestamp: started,
        systemPrompt: ctxBefore.system,
        messages: ctxBefore.messages,
        toolCall: outcome.call,
        text: outcome.text,
        actionResult: outcome.result,
        latencyMs: Date.now() - started,
        model: config.model ?? null,
      })
    } catch (err) {
      this.onTrace({
        id,
        characterId: entityId,
        combat_id: combatId,
        round,
        timestamp: started,
        systemPrompt: ctxBefore.system,
        messages: ctxBefore.messages,
        toolCall: null,
        text: null,
        actionResult: null,
        latencyMs: Date.now() - started,
        model: config.model ?? null,
        error: err instanceof Error ? err.message : String(err),
      })
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
      llm: new OpenAILLMClient({ model: config.model }),
    })
    agent.start("You are in combat. Decide and submit an action for each round.")
    this.agents.set(entityId, agent)
    return agent
  }
}
