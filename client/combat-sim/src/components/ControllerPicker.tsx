import { Brain, PencilSimple, Robot, Sparkle, User } from "@phosphor-icons/react"
import { useState } from "react"

import type { ControllerConfig } from "../controllers/types"
import { useAppStore } from "../store/appStore"
import type { EntityId } from "../engine/types"
import { StrategyEditorModal } from "./StrategyEditorModal"

interface Props {
  entityId: EntityId
  onSetController: (id: string, config: ControllerConfig | null) => void
  /** True when the entity is a participant in an active combat — locks the config. */
  disabled?: boolean
  /** Display label shown in the strategy editor header. Defaults to entityId. */
  displayLabel?: string
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

export function ControllerPicker({
  entityId,
  onSetController,
  disabled,
  displayLabel,
}: Props) {
  const controller = useAppStore((s) => s.controllers[entityId])
  const inFlight = useAppStore((s) => (s.inFlight[entityId] ?? 0) > 0)
  const [editorOpen, setEditorOpen] = useState(false)

  const kind = controller?.kind ?? "manual"
  const model = controller?.model ?? "gpt-4.1"
  const strategy = controller?.strategy ?? "balanced"
  const hasCustomStrategy = Boolean(controller?.customStrategy?.trim())

  const setKind = (v: "manual" | "llm") => {
    if (v === "manual") onSetController(entityId, null)
    else
      onSetController(entityId, {
        kind: "llm",
        model,
        strategy: controller?.strategy ?? "balanced",
        customStrategy: controller?.customStrategy,
      })
  }

  const setModel = (v: string) => {
    onSetController(entityId, {
      kind: "llm",
      model: v,
      strategy: controller?.strategy ?? "balanced",
      customStrategy: controller?.customStrategy,
    })
  }

  // Visual: when a custom override is set, show a distinct fuchsia pill;
  // otherwise show the canonical strategy name. In-flight LLM calls pulse
  // the pill amber so the user can see which ship is "thinking" this round.
  const pillLabel = inFlight
    ? "thinking"
    : hasCustomStrategy
      ? `custom`
      : strategy
  const pillClasses = inFlight
    ? "animate-pulse border-amber-400 bg-amber-900/60 text-amber-100"
    : hasCustomStrategy
      ? "border-fuchsia-500 bg-fuchsia-900/50 text-fuchsia-100 hover:border-fuchsia-300 hover:bg-fuchsia-900/70"
      : strategy === "offensive"
        ? "border-rose-700 bg-rose-950/50 text-rose-200 hover:border-rose-400 hover:bg-rose-900/40"
        : strategy === "defensive"
          ? "border-sky-700 bg-sky-950/50 text-sky-200 hover:border-sky-400 hover:bg-sky-900/40"
          : "border-amber-700 bg-amber-950/50 text-amber-200 hover:border-amber-400 hover:bg-amber-900/40"

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-neutral-500">
      {/* Kind toggle: Manual ↔ LLM */}
      <button
        type="button"
        onClick={() => setKind(kind === "manual" ? "llm" : "manual")}
        disabled={disabled}
        title={
          disabled
            ? "Controller locked — entity is in active combat"
            : kind === "llm"
              ? "Switch to manual control (clears LLM config)"
              : "Promote to LLM-driven control"
        }
        className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider transition disabled:cursor-not-allowed disabled:opacity-50 ${
          kind === "llm"
            ? "border-emerald-600 bg-emerald-950/50 text-emerald-200 hover:border-emerald-400"
            : "border-neutral-700 bg-neutral-900 text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
        }`}
      >
        {kind === "llm" ? (
          <Robot weight="fill" className="h-3 w-3" />
        ) : (
          <User weight="fill" className="h-3 w-3" />
        )}
        {kind === "llm" ? "LLM" : "Manual"}
      </button>

      {kind === "llm" && (
        <>
          {/* Model: inline dropdown, unobtrusive */}
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={disabled}
            title="OpenAI model"
            className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-200 disabled:opacity-50"
          >
            {OPENAI_MODELS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>

          {/* Merged strategy + AI pill. One clickable control, visually
              obvious it's editable (border highlights on hover + pencil
              icon on the right), opens the strategy editor modal. */}
          <button
            type="button"
            onClick={() => setEditorOpen(true)}
            disabled={disabled}
            title={
              disabled
                ? "Strategy locked — entity is in active combat"
                : hasCustomStrategy
                  ? "Click to edit the custom strategy override"
                  : "Click to pick a strategy or write a custom override"
            }
            className={`group inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider transition disabled:cursor-not-allowed disabled:opacity-60 ${pillClasses}`}
          >
            {inFlight ? (
              <Sparkle
                weight="fill"
                className="h-3 w-3 animate-[spin_1.6s_linear_infinite]"
              />
            ) : hasCustomStrategy ? (
              <Sparkle weight="fill" className="h-3 w-3" />
            ) : (
              <Brain weight="fill" className="h-3 w-3" />
            )}
            <span>{pillLabel}</span>
            {!disabled && !inFlight && (
              <PencilSimple
                weight="bold"
                className="h-2.5 w-2.5 opacity-60 transition group-hover:opacity-100"
              />
            )}
          </button>

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

      {controller?.kind === "llm" && (
        <StrategyEditorModal
          open={editorOpen}
          onClose={() => setEditorOpen(false)}
          label={displayLabel ?? entityId}
          config={controller}
          onSave={(next) => onSetController(entityId, next)}
        />
      )}
    </div>
  )
}
