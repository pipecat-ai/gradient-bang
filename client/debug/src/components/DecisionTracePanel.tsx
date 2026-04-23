import { useMemo, useState } from "react"

import type { AgentMessage } from "../agent/debug_agent"
import type { DecisionTrace } from "../controllers/types"
import { useAppStore } from "../store/appStore"

export function DecisionTracePanel() {
  const selectedId = useAppStore((s) => s.selectedEntityId)
  const traces = useAppStore((s) => s.traces)
  const clearTraces = useAppStore((s) => s.clearTraces)

  const filtered = useMemo(
    () =>
      selectedId ? traces.filter((t) => t.characterId === selectedId) : traces,
    [traces, selectedId],
  )

  if (traces.length === 0) return null

  return (
    <div className="border-b border-neutral-800 bg-neutral-950/60 px-4 py-2">
      <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-wider text-neutral-500">
        <span>LLM decisions ({filtered.length})</span>
        {selectedId && (
          <>
            <span className="text-neutral-600">·</span>
            <span className="normal-case tracking-normal text-emerald-300">
              {selectedId}
            </span>
          </>
        )}
        <button
          type="button"
          onClick={() => clearTraces()}
          className="ml-auto rounded bg-neutral-800 px-2 py-0.5 text-[10px] normal-case tracking-normal text-neutral-300 hover:bg-neutral-700"
        >
          Clear traces
        </button>
      </div>
      {filtered.length === 0 ? (
        <p className="text-xs text-neutral-600">
          No traces for this POV yet.
        </p>
      ) : (
        <ol className="space-y-1">
          {[...filtered].reverse().map((t) => (
            <TraceRow key={t.id} trace={t} />
          ))}
        </ol>
      )}
    </div>
  )
}

function TraceRow({ trace }: { trace: DecisionTrace }) {
  const [expanded, setExpanded] = useState(false)
  const callSummary = trace.toolCall
    ? `${trace.toolCall.name}(${summarizeArgs(trace.toolCall.arguments)})`
    : trace.error
      ? `error: ${trace.error}`
      : trace.text
        ? `text: ${trace.text.slice(0, 80)}${trace.text.length > 80 ? "…" : ""}`
        : "no tool call"
  return (
    <li className="rounded border border-amber-900/40 bg-amber-950/20">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-baseline gap-2 px-2 py-1 text-left text-xs hover:bg-amber-950/40"
      >
        <span
          className={`inline-block w-3 text-[10px] text-neutral-500 transition ${
            expanded ? "rotate-90" : ""
          }`}
        >
          ▶
        </span>
        <span className="rounded border border-amber-700 bg-amber-950 px-1 text-[9px] uppercase tracking-wider text-amber-300">
          AI
        </span>
        <span className="font-semibold text-neutral-200">{trace.characterId}</span>
        {trace.round != null && (
          <span className="text-[11px] text-neutral-500">round {trace.round}</span>
        )}
        <span className="text-[11px] text-neutral-400">{callSummary}</span>
        <span className="ml-auto font-mono text-[10px] text-neutral-500">
          {trace.latencyMs}ms
        </span>
        <span className="font-mono text-[10px] text-neutral-600">
          {new Date(trace.timestamp).toLocaleTimeString()}
        </span>
      </button>
      {expanded && <TraceDetail trace={trace} />}
    </li>
  )
}

function TraceDetail({ trace }: { trace: DecisionTrace }) {
  return (
    <div className="space-y-1.5 border-t border-amber-900/40 px-2 py-1.5 text-[11px]">
      <div className="flex flex-wrap gap-3 text-neutral-500">
        {trace.model && (
          <span>
            model <span className="text-neutral-300">{trace.model}</span>
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
        {trace.error && <span className="text-rose-300">error: {trace.error}</span>}
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

      <details className="rounded border border-neutral-800 bg-neutral-950 p-1">
        <summary className="cursor-pointer text-neutral-400">
          messages ({trace.messages.length})
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
      <pre className="mt-0.5 whitespace-pre-wrap text-[10px] leading-snug text-neutral-300">
        {message.content}
      </pre>
    </div>
  )
}

function summarizeArgs(args: Record<string, unknown>): string {
  // Keep combat_id visible (shortened when long) — the user needs to see what
  // the LLM actually passed here, especially when the engine rejects with
  // "no such combat".
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
