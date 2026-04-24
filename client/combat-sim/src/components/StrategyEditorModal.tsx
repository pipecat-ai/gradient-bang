import { X } from "@phosphor-icons/react"
import { useEffect, useState } from "react"

import { PROMPT_FRAGMENTS } from "../agent/prompts"
import type { ControllerConfig } from "../controllers/types"

const STRATEGIES = [
  { value: "balanced" as const, label: "Balanced", tone: "amber" },
  { value: "offensive" as const, label: "Offensive", tone: "rose" },
  { value: "defensive" as const, label: "Defensive", tone: "sky" },
]

const TONE_CLASSES: Record<string, { on: string; off: string }> = {
  amber: {
    on: "border-amber-400 bg-amber-900/60 text-amber-100",
    off: "border-neutral-700 bg-neutral-900 text-neutral-400 hover:border-amber-600 hover:text-amber-200",
  },
  rose: {
    on: "border-rose-400 bg-rose-900/60 text-rose-100",
    off: "border-neutral-700 bg-neutral-900 text-neutral-400 hover:border-rose-600 hover:text-rose-200",
  },
  sky: {
    on: "border-sky-400 bg-sky-900/60 text-sky-100",
    off: "border-neutral-700 bg-neutral-900 text-neutral-400 hover:border-sky-600 hover:text-sky-200",
  },
}

interface Props {
  open: boolean
  onClose: () => void
  /** Display label used in the header ("custom strategy for {name}"). */
  label: string
  config: ControllerConfig
  /** Called with the next config when the user saves. */
  onSave: (next: ControllerConfig) => void
}

/**
 * Inline strategy editor. Lets the operator replace the canonical strategy
 * fragment (offensive / defensive / balanced) with arbitrary text for one
 * specific LLM ship. The replacement is applied via `ControllerConfig.customStrategy`
 * and replayed the moment the agent rebuilds (see `App.handleSetController`).
 *
 * Shows the canonical fragment underneath so the operator can see what
 * they're replacing — and crib from it if they want.
 */
export function StrategyEditorModal({ open, onClose, label, config, onSave }: Props) {
  const [draft, setDraft] = useState(config.customStrategy ?? "")
  const [selectedStrategy, setSelectedStrategy] = useState<
    "offensive" | "defensive" | "balanced"
  >(config.strategy ?? "balanced")

  useEffect(() => {
    if (open) {
      setDraft(config.customStrategy ?? "")
      setSelectedStrategy(config.strategy ?? "balanced")
    }
  }, [open, config.customStrategy, config.strategy])

  if (!open) return null

  const canonicalText =
    selectedStrategy === "offensive"
      ? PROMPT_FRAGMENTS.offensiveStrategy
      : selectedStrategy === "defensive"
        ? PROMPT_FRAGMENTS.defensiveStrategy
        : PROMPT_FRAGMENTS.balancedStrategy

  const handleSave = () => {
    const trimmed = draft.trim()
    onSave({
      ...config,
      strategy: selectedStrategy,
      customStrategy: trimmed.length > 0 ? trimmed : undefined,
    })
    onClose()
  }

  const handleClear = () => {
    onSave({ ...config, strategy: selectedStrategy, customStrategy: undefined })
    setDraft("")
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-black/70 p-4 pt-12"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl rounded-lg border border-neutral-800 bg-neutral-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-2">
          <div>
            <h2 className="text-sm font-semibold tracking-wide text-neutral-100">
              Combat strategy — {label}
            </h2>
            <p className="text-[11px] text-neutral-500">
              Pick a canonical style or replace it with a custom prompt.
              Locked once combat starts; until then, saving rebuilds the
              agent with the new config.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded bg-neutral-800 p-1 text-neutral-300 hover:bg-neutral-700"
            aria-label="Close"
          >
            <X weight="bold" className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 px-4 py-3">
          <div>
            <label className="mb-1.5 block text-[11px] uppercase tracking-wider text-neutral-500">
              Canonical style
            </label>
            <div className="flex flex-wrap gap-1.5">
              {STRATEGIES.map((s) => {
                const active = selectedStrategy === s.value
                const cls = TONE_CLASSES[s.tone]
                return (
                  <button
                    key={s.value}
                    type="button"
                    onClick={() => setSelectedStrategy(s.value)}
                    className={`rounded border px-2.5 py-1 text-[11px] font-medium uppercase tracking-wider transition ${active ? cls.on : cls.off}`}
                  >
                    {s.label}
                  </button>
                )
              })}
            </div>
          </div>

          <div>
            <label className="mb-1 flex items-baseline gap-2 text-[11px] text-neutral-400">
              <span>Custom text (optional override)</span>
              <span className="text-[10px] text-neutral-600">
                will be wrapped as ## Combat style: CUSTOM
              </span>
            </label>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  handleSave()
                }
              }}
              placeholder='e.g. "ATTACK Bob every round with commit=30; if shields below 20% FLEE toward sector 41."'
              rows={8}
              className="w-full resize-y rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 font-mono text-[11px] text-neutral-200 placeholder:text-neutral-600"
            />
            <div className="mt-1 flex items-center gap-2">
              <button
                type="button"
                onClick={handleSave}
                className="rounded bg-emerald-900/40 px-3 py-1 text-xs text-emerald-200 hover:bg-emerald-900/60"
              >
                Save (⌘/Ctrl+Enter)
              </button>
              <button
                type="button"
                onClick={handleClear}
                disabled={!config.customStrategy}
                className="rounded bg-neutral-800 px-3 py-1 text-xs text-neutral-200 hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40"
                title="Revert to the canonical strategy fragment"
              >
                Clear override
              </button>
              <span className="ml-auto text-[10px] text-neutral-600">
                {draft.length.toLocaleString()} char
                {draft.length === 1 ? "" : "s"}
              </span>
            </div>
          </div>

          <details className="rounded border border-neutral-800 bg-neutral-900/50">
            <summary className="cursor-pointer px-2 py-1 text-[11px] text-neutral-400">
              canonical "{selectedStrategy}" fragment (for reference — what
              you're replacing)
            </summary>
            <pre className="whitespace-pre-wrap border-t border-neutral-800 px-2 py-1.5 font-mono text-[10px] leading-snug text-neutral-500">
              {canonicalText}
            </pre>
          </details>
        </div>
      </div>
    </div>
  )
}
