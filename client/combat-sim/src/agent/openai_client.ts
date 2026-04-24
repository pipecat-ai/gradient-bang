import OpenAI from "openai"
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions"

import type {
  AgentContext,
  AgentMessage,
  LLMClient,
  LLMResponse,
} from "./debug_agent"
import type { ToolSchema } from "./tools"

/**
 * A real LLM-backed client implementing the harness's `LLMClient` interface.
 * Calls OpenAI chat.completions.create with the accumulated context + tool
 * schemas and returns the first tool call as an `AgentToolCall`.
 *
 * This is the production counterpart to `MockLLMClient` — use one for unit
 * tests, the other for live scenarios (via the debug UI or API-key-gated
 * integration tests).
 *
 * Runs in Node (vitest) and in the browser (Vite dev server). In the browser
 * context it uses `dangerouslyAllowBrowser: true` because the harness is
 * local-only and never deployed.
 */
export interface OpenAIClientOpts {
  /** API key. Reads `OPENAI_API_KEY` env var by default (Node). */
  apiKey?: string
  /** Model name. Default: gpt-4.1. Override via env OPENAI_MODEL. */
  model?: string
  /** Per-call timeout in ms. Default: 20_000. */
  timeoutMs?: number
  /** Max output tokens. Default: 1024. */
  maxTokens?: number
  /** Allow running from a browser page. Default: true (harness is local-only). */
  allowBrowser?: boolean
}

export class OpenAILLMClient implements LLMClient {
  private readonly client: OpenAI
  readonly model: string
  readonly timeoutMs: number
  readonly maxTokens: number

  constructor(opts: OpenAIClientOpts = {}) {
    const apiKey =
      opts.apiKey ??
      getStoredApiKey() ??
      (typeof process !== "undefined" ? process.env.OPENAI_API_KEY : undefined) ??
      (typeof import.meta !== "undefined"
        ? ((import.meta as unknown as { env?: Record<string, string> }).env
            ?.VITE_OPENAI_API_KEY ?? undefined)
        : undefined)
    if (!apiKey) {
      throw new Error(
        "OpenAILLMClient: missing API key. Enter one via the in-app gate, set OPENAI_API_KEY/VITE_OPENAI_API_KEY, or pass opts.apiKey.",
      )
    }
    this.client = new OpenAI({
      apiKey,
      dangerouslyAllowBrowser: opts.allowBrowser ?? true,
    })
    this.model =
      opts.model ??
      (typeof process !== "undefined" ? process.env.OPENAI_MODEL : undefined) ??
      (typeof import.meta !== "undefined"
        ? (import.meta as unknown as { env?: Record<string, string> }).env
            ?.VITE_OPENAI_MODEL
        : undefined) ??
      "gpt-4.1"
    this.timeoutMs = opts.timeoutMs ?? 20_000
    this.maxTokens = opts.maxTokens ?? 1024
  }

  async complete(
    ctx: AgentContext,
    opts: { tools: ToolSchema[] },
  ): Promise<LLMResponse> {
    const messages = toOpenAIMessages(ctx)
    const tools = opts.tools.map(toOpenAITool)

    const response = await this.client.chat.completions.create(
      {
        model: this.model,
        messages,
        tools: tools.length > 0 ? tools : undefined,
        // `required` forces the model to call some tool on this turn —
        // prevents the common failure mode where the model replies with
        // plain text ("I'll brace this round.") instead of calling
        // combat_action. We only expose one tool, so required === that tool.
        tool_choice: tools.length > 0 ? "required" : undefined,
        parallel_tool_calls: tools.length > 0 ? false : undefined,
        max_completion_tokens: this.maxTokens,
      },
      { timeout: this.timeoutMs },
    )

    const choice = response.choices[0]
    if (!choice) return { toolCall: null, text: null }

    const finishReason =
      typeof choice.finish_reason === "string" ? choice.finish_reason : null
    const refusal =
      typeof (choice.message as { refusal?: string })?.refusal === "string"
        ? ((choice.message as { refusal?: string }).refusal ?? null)
        : null

    // Capture any plain-text content even when a tool is also called (some
    // models emit both). Surfaced in the trace so you can see WHY the model
    // chose the action.
    const text =
      typeof choice.message?.content === "string" && choice.message.content.trim()
        ? choice.message.content
        : null

    const toolCalls = choice.message?.tool_calls
    if (!toolCalls || toolCalls.length === 0) {
      return { toolCall: null, text, finishReason, refusal }
    }

    const first = toolCalls[0]
    if (first.type !== "function")
      return { toolCall: null, text, finishReason, refusal }

    let parsed: Record<string, unknown> = {}
    try {
      parsed = JSON.parse(first.function.arguments || "{}")
    } catch {
      // Hallucinated / malformed JSON — return the raw string as a single arg
      // so the commit step can reject it with a meaningful reason.
      parsed = { _raw_arguments: first.function.arguments }
    }
    return {
      toolCall: { name: first.function.name, arguments: parsed },
      text,
      finishReason,
      refusal,
    }
  }
}

/**
 * Convert a harness AgentContext to OpenAI's chat.completions message list.
 * Pairs each assistant tool_call with the next tool-role message by generating
 * a synthetic tool_call_id — the harness doesn't track real ids, but OpenAI
 * requires them to thread tool results back to the originating assistant turn.
 */
function toOpenAIMessages(ctx: AgentContext): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [
    { role: "system", content: ctx.system },
  ]
  let pendingCallId: string | null = null
  let callIdCounter = 0

  for (const m of ctx.messages) {
    if (m.role === "assistant" && m.tool_call) {
      callIdCounter += 1
      const id = `call_${callIdCounter}`
      pendingCallId = id
      // Preserve any plain-text reasoning the model emitted alongside the
      // tool call — empty content → null (OpenAI allows either, but null is
      // cleaner when there's no text).
      const textContent =
        typeof m.content === "string" && m.content.length > 0 ? m.content : null
      out.push({
        role: "assistant",
        content: textContent,
        tool_calls: [
          {
            id,
            type: "function",
            function: {
              name: m.tool_call.name,
              arguments: JSON.stringify(m.tool_call.arguments),
            },
          },
        ],
      })
      continue
    }
    if (m.role === "tool") {
      if (pendingCallId) {
        out.push({
          role: "tool",
          tool_call_id: pendingCallId,
          content: m.content,
        })
        pendingCallId = null
      } else {
        // Orphan tool message (no preceding assistant tool_call) — collapse to
        // a user message so the LLM still sees the continuity.
        out.push({ role: "user", content: `[tool result] ${m.content}` })
      }
      continue
    }
    // user / system / assistant without tool_call
    const asAgent = m as AgentMessage
    if (asAgent.role === "system") {
      out.push({ role: "system", content: m.content })
    } else if (asAgent.role === "assistant") {
      out.push({ role: "assistant", content: m.content })
    } else {
      out.push({ role: "user", content: m.content })
    }
  }
  return out
}

function toOpenAITool(t: ToolSchema): ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }
}

/**
 * Where the in-app gate stashes the user-entered OpenAI key. Local-only: the
 * harness never leaves this machine, so a plain localStorage entry is fine.
 */
const STORED_API_KEY = "combat_sim_openai_api_key"

/** Read the user-entered key from localStorage. Returns null in non-browser contexts. */
export function getStoredApiKey(): string | null {
  if (typeof localStorage === "undefined") return null
  const v = localStorage.getItem(STORED_API_KEY)
  return v && v.length > 0 ? v : null
}

/** Persist a user-entered key. Empty string clears it. */
export function setStoredApiKey(key: string): void {
  if (typeof localStorage === "undefined") return
  const trimmed = key.trim()
  if (trimmed.length === 0) localStorage.removeItem(STORED_API_KEY)
  else localStorage.setItem(STORED_API_KEY, trimmed)
}

export function clearStoredApiKey(): void {
  if (typeof localStorage === "undefined") return
  localStorage.removeItem(STORED_API_KEY)
}

/** True if a key is accessible — stored value wins, env vars are fallback. */
export function hasOpenAIKey(): boolean {
  if (getStoredApiKey()) return true
  const fromProcess =
    typeof process !== "undefined" && !!process.env.OPENAI_API_KEY
  const fromVite =
    typeof import.meta !== "undefined" &&
    !!(
      (import.meta as unknown as { env?: Record<string, string> }).env
        ?.VITE_OPENAI_API_KEY
    )
  return fromProcess || fromVite
}
