import type { InMemoryEmitter } from "../engine/emitter"
import type { CombatEngine } from "../engine/engine"
import {
  type ActionResult,
  type CharacterId,
  type CombatEvent,
  type CombatId,
  type SubmitAction,
} from "../engine/types"
import { toAgentEventXml, type AgentViewerContext } from "./event_xml"
import { buildTaskAgentSystemPrompt, type StrategyKind } from "./prompts"
import type {
  CorporationInfoSnapshot,
  StatusSnapshot,
} from "./status"
import { COMBAT_STRATEGY_TOOLS, type ToolSchema } from "./tools"

/**
 * A message in the agent's LLM context.
 */
export interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool"
  content: string
  /** Raw event that produced this message (for test assertions). */
  event?: CombatEvent
  /** Parsed tool call when the LLM's assistant turn returned one. */
  tool_call?: AgentToolCall
}

export interface AgentToolCall {
  name: string
  arguments: Record<string, unknown>
}

export interface AgentContext {
  system: string
  messages: AgentMessage[]
}

export interface LLMResponse {
  toolCall: AgentToolCall | null
  /** Any plain-text reply from the model (when it didn't call a tool). */
  text: string | null
  /**
   * OpenAI-style finish_reason when available — "stop", "length",
   * "tool_calls", "content_filter". Surfaces the "model reasoned until it
   * ran out of tokens" case (length) which otherwise looks identical to
   * an empty response.
   */
  finishReason?: string | null
  /** Model refusal text (OpenAI 2024+ structured refusal), if any. */
  refusal?: string | null
}

export interface LLMClient {
  complete(
    ctx: AgentContext,
    opts: { tools: ToolSchema[] },
  ): Promise<LLMResponse>
}

export class MockLLMClient implements LLMClient {
  private queue: LLMResponse[]
  /** Captured context + tools from the most recent complete() call. */
  lastContext: AgentContext | null = null
  lastTools: ToolSchema[] = []
  /** Every tool call the mock has returned, in order. */
  callHistory: AgentToolCall[] = []

  constructor(items: Array<AgentToolCall | LLMResponse> = []) {
    this.queue = items.map((it) =>
      "toolCall" in it ? (it as LLMResponse) : { toolCall: it as AgentToolCall, text: null },
    )
  }

  async complete(
    ctx: AgentContext,
    opts: { tools: ToolSchema[] },
  ): Promise<LLMResponse> {
    this.lastContext = {
      system: ctx.system,
      messages: [...ctx.messages],
    }
    this.lastTools = opts.tools
    const next = this.queue.shift() ?? { toolCall: null, text: null }
    if (next.toolCall) this.callHistory.push(next.toolCall)
    return next
  }

  /** Enqueue an additional tool call or full response (for mid-test adjustment). */
  enqueue(item: AgentToolCall | LLMResponse): void {
    this.queue.push(
      "toolCall" in item ? (item as LLMResponse) : { toolCall: item as AgentToolCall, text: null },
    )
  }
}

export interface DebugAgentOpts {
  engine: CombatEngine
  emitter: InMemoryEmitter
  characterId: string
  llm?: LLMClient
  /** Defaults to true. */
  includeCombatFragment?: boolean
  /** Adds the harness-only `combat_strategy.md` fragment. Default false. */
  includeCombatStrategyFragment?: boolean
  /** Harness-only style override snippet appended after combat_strategy.md. */
  strategy?: StrategyKind
  /**
   * Free-form text that replaces the canonical `strategy` fragment when
   * set. Takes precedence over `strategy` in the prompt assembly.
   */
  customStrategy?: string
  /** Tool set handed to the LLM. Default: COMBAT_STRATEGY_TOOLS. */
  tools?: ToolSchema[]
  /** my_status snapshot injected into the agent's initial context. */
  status?: StatusSnapshot
  /** corporation_info snapshot injected into the agent's initial context. */
  corporation?: CorporationInfoSnapshot
}

/**
 * Test-harness TaskAgent analogue. Builds production-shaped prompt + context,
 * subscribes to engine events, and (optionally) calls an LLM to pick a
 * `combat_action` each round.
 */
export class DebugAgent {
  readonly characterId: string
  readonly systemPrompt: string
  readonly tools: ToolSchema[]

  private readonly engine: CombatEngine
  private readonly emitter: InMemoryEmitter
  private readonly llm?: LLMClient
  private readonly status?: StatusSnapshot
  private readonly corporation?: CorporationInfoSnapshot
  private readonly viewer: AgentViewerContext

  private messages: AgentMessage[] = []
  private unsubscribe: (() => void) | null = null

  // When true, the agent's handleEvent subscription appends into this buffer
  // instead of `messages`. Used during commitAction so the tool-result message
  // can be pushed IMMEDIATELY after the assistant(tool_call) — otherwise
  // synchronous events emitted by engine.submitAction (combat.action_accepted,
  // combat.round_resolved, combat.round_waiting) sneak in between, and OpenAI
  // rejects the sequence with "tool_call_ids did not have response messages".
  private bufferEvents = false
  private eventBuffer: CombatEvent[] = []

  constructor(opts: DebugAgentOpts) {
    this.engine = opts.engine
    this.emitter = opts.emitter
    this.characterId = opts.characterId
    this.llm = opts.llm
    this.status = opts.status
    this.corporation = opts.corporation
    this.tools = opts.tools ?? COMBAT_STRATEGY_TOOLS
    this.systemPrompt = buildTaskAgentSystemPrompt({
      includeCombatFragment: opts.includeCombatFragment ?? true,
      includeCombatStrategyFragment: opts.includeCombatStrategyFragment ?? false,
      strategy: opts.strategy,
      customStrategy: opts.customStrategy,
    })
    // Derive the viewer context once — drives corp-mate detection in the
    // event XML filter so the agent sees combat events involving its own
    // corp ships even when it isn't personally a participant.
    this.viewer = {
      characterId: opts.characterId,
      corpId:
        opts.status?.corporation?.corp_id ??
        opts.corporation?.corp_id ??
        null,
    }
  }

  start(taskDescription: string): void {
    if (this.unsubscribe) throw new Error("DebugAgent already started")

    // Initial user turn: task description + injected status/corp snapshots,
    // mirroring how TaskAgent seeds its LLM with `my_status` output.
    const parts: string[] = [`Task: ${taskDescription}`]
    if (this.status) {
      parts.push(`<my_status>\n${JSON.stringify(this.status, null, 2)}\n</my_status>`)
    }
    if (this.corporation) {
      parts.push(
        `<corporation_info>\n${JSON.stringify(this.corporation, null, 2)}\n</corporation_info>`,
      )
    }
    this.messages.push({ role: "user", content: parts.join("\n\n") })

    this.unsubscribe = this.emitter.subscribe((event) => this.handleEvent(event))
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  getContext(): AgentContext {
    return { system: this.systemPrompt, messages: [...this.messages] }
  }

  getXmlEvents(): string[] {
    return this.messages
      .filter((m) => m.role === "user" && m.content.startsWith("<event "))
      .map((m) => m.content)
  }

  messagesFor(eventType: string): AgentMessage[] {
    return this.messages.filter((m) => m.event?.type === eventType)
  }

  /**
   * Ask the configured LLM for a decision given the current context + tool
   * set. Records the returned tool call + any plain-text reply as an
   * assistant message. Does NOT auto-commit — callers use `commitAction()`
   * or `decideAndCommit()` to submit to the engine.
   */
  async decide(): Promise<LLMResponse> {
    if (!this.llm) {
      throw new Error(
        "DebugAgent.decide(): no LLMClient configured. Pass one via opts.llm.",
      )
    }
    const ctx = this.getContext()
    const response = await this.llm.complete(ctx, { tools: this.tools })
    if (response.toolCall || response.text) {
      // Store the LLM's plain-text reply as-is in `content` (empty string when
      // only a tool call was returned). The tool call lives on the separate
      // `tool_call` field — `toOpenAIMessages` wires it into OpenAI's
      // `tool_calls[]` array. Keeping them separated means we don't lose
      // either signal when reconstructing the context for the next turn.
      this.messages.push({
        role: "assistant",
        content: response.text ?? "",
        tool_call: response.toolCall ?? undefined,
      })
    }
    return response
  }

  /**
   * Submit a `combat_action` tool call into the engine as this agent's
   * character. Validates the call shape and returns the engine's ActionResult.
   * Appends a `tool` message recording the result for LLM context.
   */
  commitAction(call: AgentToolCall): ActionResult {
    if (call.name !== "combat_action") {
      const err: ActionResult = {
        ok: false,
        reason: `Unsupported tool: ${call.name}`,
      }
      this.recordToolResult(call, err)
      return err
    }
    const args = call.arguments

    // Explicit combat_id validation — surfaces a clear rejection the LLM can
    // learn from in its next turn (via the tool-result message in context).
    const combatIdValue = args.combat_id
    if (typeof combatIdValue !== "string" || !combatIdValue.trim()) {
      const err: ActionResult = {
        ok: false,
        reason: `combat_action requires combat_id to exactly match the combat_id attribute of the most recent combat.round_waiting event (got ${JSON.stringify(combatIdValue)}).`,
      }
      this.recordToolResult(call, err)
      return err
    }
    const combatId = combatIdValue as CombatId
    const action = args.action as string
    let input: SubmitAction
    switch (action) {
      case "attack":
        input = {
          action: "attack",
          target_id: String(args.target_id ?? ""),
          commit: Number(args.commit ?? 0),
        }
        break
      case "brace":
        input = { action: "brace" }
        break
      case "flee":
        input = {
          action: "flee",
          destination_sector:
            typeof args.to_sector === "number" ? args.to_sector : null,
        }
        break
      case "pay":
        input = {
          action: "pay",
          target_id:
            typeof args.target_id === "string" ? args.target_id : null,
        }
        break
      default: {
        const err: ActionResult = { ok: false, reason: `Unknown action: ${action}` }
        this.recordToolResult(call, err)
        return err
      }
    }
    // Buffer any events emitted synchronously by engine.submitAction
    // (action_accepted, round_resolved, the next round_waiting, combat.ended)
    // so the tool message lands IMMEDIATELY after the assistant(tool_call)
    // in this agent's context. Without this, OpenAI 400s the next decide()
    // with "tool_call_ids did not have response messages" because a `user`
    // message ends up between the pair.
    this.bufferEvents = true
    let result: ActionResult
    try {
      result = this.engine.submitAction(this.characterId as CharacterId, combatId, input)
    } finally {
      this.bufferEvents = false
    }
    this.recordToolResult(call, result)

    // Now flush the buffered events so the LLM sees them on its next turn,
    // in the same order they fired — just after the tool pair instead of
    // inside it.
    const buffered = this.eventBuffer
    this.eventBuffer = []
    for (const ev of buffered) {
      this.handleEvent(ev)
    }

    return result
  }

  /**
   * Combined convenience: decide then commit if a combat_action was returned.
   *
   * Retries up to `MAX_ATTEMPTS - 1` additional times when the engine
   * REJECTS the action (e.g. paying against a non-toll garrison, attacking
   * a destroyed target). The rejection lands in the agent's context as a
   * tool-result message; the next decide() call sees the error and can
   * pick a different action. Without the retry the round stalls — the
   * ControllerManager only re-invokes agents on `combat.round_waiting`,
   * which doesn't fire until all active participants submit successfully.
   */
  async decideAndCommit(): Promise<{
    call: AgentToolCall | null
    text: string | null
    result: ActionResult | null
  }> {
    const MAX_ATTEMPTS = 3
    let last: {
      call: AgentToolCall | null
      text: string | null
      result: ActionResult | null
    } = { call: null, text: null, result: null }
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const response = await this.decide()
      if (!response.toolCall || response.toolCall.name !== "combat_action") {
        return {
          call: response.toolCall,
          text: response.text,
          result: null,
        }
      }
      const result = this.commitAction(response.toolCall)
      last = { call: response.toolCall, text: response.text, result }
      if (result.ok) return last
      // Rejected. The tool-result message is already in context; loop and
      // let the model try again.
    }
    return last
  }

  /**
   * Replay past events from the emitter log into this agent's context.
   * Used when the agent is created AFTER events it should have seen have
   * already fired — typically when ControllerManager lazily creates an
   * agent in response to the combat.round_waiting that triggered the
   * round. Without replay, the agent's context has only its initial task
   * + status blob, with no knowledge of the active combat's real
   * combat_id / participants / sector — and the LLM hallucinates values.
   */
  replayEvents(events: readonly CombatEvent[]): void {
    for (const event of events) {
      this.handleEvent(event)
    }
  }

  // ---- Internal ----

  private handleEvent(event: CombatEvent): void {
    if (this.bufferEvents) {
      this.eventBuffer.push(event)
      return
    }
    const xml = toAgentEventXml(event, this.viewer)
    if (xml == null) return
    this.messages.push({ role: "user", content: xml, event })
  }

  private recordToolResult(call: AgentToolCall, result: ActionResult): void {
    this.messages.push({
      role: "tool",
      content: `${call.name} → ${JSON.stringify(result)}`,
    })
  }
}
