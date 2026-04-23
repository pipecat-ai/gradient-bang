import type { ControllerConfig } from "../controllers/types"
import { useAppStore } from "../store/appStore"
import type { EntityId } from "../engine/types"

interface Props {
  entityId: EntityId
  onSetController: (id: string, config: ControllerConfig | null) => void
  /** True when the entity is a participant in an active combat — locks the config. */
  disabled?: boolean
}

/** Models exposed in the dropdown. Add here when new ones land. */
const OPENAI_MODELS = [
  "gpt-5-mini",
  "gpt-5",
  "gpt-4.1-mini",
  "gpt-4.1",
  "gpt-4o-mini",
  "gpt-4o",
] as const

/** none = balanced (no style override injected). */
const STRATEGIES = [
  { value: "none", label: "balanced" },
  { value: "offensive", label: "offensive" },
  { value: "defensive", label: "defensive" },
] as const

export function ControllerPicker({ entityId, onSetController, disabled }: Props) {
  const controller = useAppStore((s) => s.controllers[entityId])
  const inFlight = useAppStore((s) => s.inFlight[entityId])

  const kind = controller?.kind ?? "manual"
  const model = controller?.model ?? "gpt-5-mini"
  const strategy = controller?.strategy ?? "none"

  const setKind = (v: "manual" | "llm") => {
    if (v === "manual") onSetController(entityId, null)
    else onSetController(entityId, { kind: "llm", model, strategy: controller?.strategy })
  }

  const setModel = (v: string) => {
    onSetController(entityId, { kind: "llm", model: v, strategy: controller?.strategy })
  }

  const setStrategy = (v: string) => {
    const strat = v === "none" ? undefined : (v as "offensive" | "defensive")
    onSetController(entityId, { kind: "llm", model, strategy: strat })
  }

  return (
    <div className="flex flex-wrap items-center gap-1 text-[10px] text-neutral-500">
      <span>controller</span>
      <select
        value={kind}
        onChange={(e) => setKind(e.target.value as "manual" | "llm")}
        disabled={disabled}
        className="rounded bg-neutral-800 px-1 py-0.5 text-[11px] text-neutral-200 disabled:opacity-50"
      >
        <option value="manual">manual</option>
        <option value="llm">LLM</option>
      </select>
      {kind === "llm" && (
        <>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={disabled}
            title="OpenAI model"
            className="rounded bg-neutral-800 px-1 py-0.5 text-[11px] text-neutral-200 disabled:opacity-50"
          >
            {OPENAI_MODELS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <select
            value={strategy}
            onChange={(e) => setStrategy(e.target.value)}
            disabled={disabled}
            title={
              disabled
                ? "Strategy is locked during active combat"
                : "Decision-style override (prompt-level only)"
            }
            className="rounded bg-neutral-800 px-1 py-0.5 text-[11px] text-neutral-200 disabled:opacity-50"
          >
            {STRATEGIES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <span
            className={`rounded border px-1 text-[9px] uppercase tracking-wider ${
              inFlight
                ? "animate-pulse border-amber-400 bg-amber-900/50 text-amber-100"
                : "border-amber-700 bg-amber-950/50 text-amber-300"
            }`}
          >
            {inFlight ? "thinking" : "AI"}
          </span>
          {disabled && (
            <span
              title="Controller config locked while this entity is in active combat"
              className="rounded border border-neutral-700 bg-neutral-900 px-1 text-[9px] uppercase tracking-wider text-neutral-400"
            >
              locked
            </span>
          )}
        </>
      )}
    </div>
  )
}
