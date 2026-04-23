import type { AgentMessage, AgentToolCall } from "../agent/debug_agent"
import type { StrategyKind } from "../agent/prompts"
import type { ActionResult } from "../engine/types"

export type ControllerKind = "manual" | "llm"

export interface ControllerConfig {
  kind: ControllerKind
  /** Model name for LLM controllers. Falls back to OPENAI_MODEL env. */
  model?: string
  /**
   * Harness-only decision-style override. Injected as a prompt snippet after
   * combat_strategy.md. Locked once combat is active (UI enforces).
   */
  strategy?: StrategyKind
}

/**
 * A complete record of what the LLM saw and what it chose, for a single
 * round decision. Captured pre-decide (context) + post-decide (tool call,
 * action result, latency). Stored in the app store; rendered in the
 * DecisionTracePanel.
 */
export interface DecisionTrace {
  id: string
  characterId: string
  combat_id: string | null
  round: number | null
  /** ms epoch when decide() started. */
  timestamp: number

  // Snapshot of the LLM context AT DECIDE TIME (before the tool call + result
  // were pushed onto the messages list). This is the "what did the LLM see?"
  // view the user wants.
  systemPrompt: string
  messages: AgentMessage[]

  // Decision
  toolCall: AgentToolCall | null
  /** Plain-text reply from the LLM (when it didn't call a tool, or accompanied the tool call). */
  text: string | null

  // Commit result (null if no combat_action was returned)
  actionResult: ActionResult | null

  latencyMs: number
  model: string | null
  error?: string
}
