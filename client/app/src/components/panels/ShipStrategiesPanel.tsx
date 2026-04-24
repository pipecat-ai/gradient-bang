import { useCallback, useEffect, useMemo, useState } from "react"

import { TrashIcon } from "@phosphor-icons/react"

import useGameStore from "@/stores/game"
import { cn } from "@/utils/tailwind"

import { DottedTitle } from "../DottedTitle"
import { PanelContentLoader } from "../PanelContentLoader"
import { Button } from "../primitives/Button"
import { Card, CardContent } from "../primitives/Card"
import { Divider } from "../primitives/Divider"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../primitives/Select"
import { Textarea } from "../primitives/Textarea"

const MAX_CUSTOM_PROMPT_CHARS = 1000

type Template = "balanced" | "offensive" | "defensive"

const TEMPLATES: ReadonlyArray<{ id: Template; label: string; blurb: string }> = [
  {
    id: "offensive",
    label: "Offensive",
    blurb: "Commit fighters aggressively. Default to ATTACK.",
  },
  {
    id: "balanced",
    label: "Balanced",
    blurb: "Read the situation each round and adapt.",
  },
  {
    id: "defensive",
    label: "Defensive",
    blurb: "BRACE by default. Attack only with clear advantage.",
  },
]

export const ShipStrategiesPanel = () => {
  const personalShip = useGameStore((s) => s.ship)
  const allShips = useGameStore((s) => s.ships?.data)
  const shipStrategies = useGameStore((s) => s.shipStrategies)
  const strategyUpdatedAt = useGameStore((s) => s.strategyUpdatedAt)
  const dispatchAction = useGameStore((s) => s.dispatchAction)

  // Options: owned ships (personal + corp). Fall back to the personal ship
  // alone until the full list arrives via get-my-ships.
  const shipOptions = useMemo(() => {
    const byId = new Map<string, { id: string; name: string; owner_type?: string }>()
    if (personalShip?.ship_id) {
      byId.set(personalShip.ship_id, {
        id: personalShip.ship_id,
        name: personalShip.ship_name ?? personalShip.ship_id,
        owner_type: personalShip.owner_type,
      })
    }
    for (const ship of allShips ?? []) {
      if (!ship?.ship_id) continue
      byId.set(ship.ship_id, {
        id: ship.ship_id,
        name: ship.ship_name ?? ship.ship_id,
        owner_type: ship.owner_type,
      })
    }
    return Array.from(byId.values())
  }, [personalShip, allShips])

  const [selectedShipId, setSelectedShipId] = useState<string | undefined>(personalShip?.ship_id)
  const [isLoading, setIsLoading] = useState(false)
  const [customPromptDraft, setCustomPromptDraft] = useState<string>("")

  // Default the selection to the personal ship once it's known (covers the
  // case where the panel mounts before `ship` is hydrated).
  useEffect(() => {
    if (!selectedShipId && personalShip?.ship_id) {
      setSelectedShipId(personalShip.ship_id)
    }
  }, [personalShip?.ship_id, selectedShipId])

  // Pull the full ship list so the selector can offer corp ships too. Parent
  // panels usually fetch this, but it's cheap and idempotent to guard here.
  useEffect(() => {
    if (!allShips) dispatchAction({ type: "get-my-ships" })
  }, [allShips, dispatchAction])

  const dispatchFetch = useCallback(
    (shipId: string) => {
      if (!shipId) return
      setIsLoading(true)
      dispatchAction({ type: "get-ship-strategy", payload: { ship_id: shipId } })
    },
    [dispatchAction]
  )

  // Auto-fetch whenever the selection changes (including the initial default).
  useEffect(() => {
    if (!selectedShipId) return
    dispatchFetch(selectedShipId)
  }, [selectedShipId, dispatchFetch])

  // Clear spinner when the store's per-ship update timestamp bumps. Watching
  // the timestamp (not the value) lets us detect same-value refreshes too.
  const selectedUpdatedAt = selectedShipId ? (strategyUpdatedAt[selectedShipId] ?? 0) : 0
  useEffect(() => {
    if (isLoading && selectedUpdatedAt > 0) setIsLoading(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedUpdatedAt])

  // Safety timeout so a dropped RTVI frame doesn't leave the spinner stuck.
  useEffect(() => {
    if (!isLoading) return
    const timer = window.setTimeout(() => setIsLoading(false), 5000)
    return () => window.clearTimeout(timer)
  }, [isLoading])

  const strategy = selectedShipId ? shipStrategies[selectedShipId] : undefined
  const activeTemplate: Template | undefined = strategy?.template
  const savedCustomPrompt = strategy?.custom_prompt ?? ""

  // Sync the textarea draft to the saved value when the selected ship changes
  // or when a fresh fetch/save lands. Keyed on selectedUpdatedAt so same-value
  // refreshes still re-seed the draft.
  useEffect(() => {
    setCustomPromptDraft(savedCustomPrompt)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedShipId, selectedUpdatedAt])

  const draftDiffers = customPromptDraft !== savedCustomPrompt

  const dispatchSet = useCallback(
    (template: Template, customPrompt: string | null) => {
      if (!selectedShipId || isLoading) return
      setIsLoading(true)
      dispatchAction({
        type: "set-ship-strategy",
        payload: {
          ship_id: selectedShipId,
          template,
          custom_prompt: customPrompt,
        },
      })
    },
    [selectedShipId, isLoading, dispatchAction]
  )

  const selectedShipName =
    selectedShipId ?
      (shipOptions.find((s) => s.id === selectedShipId)?.name ?? selectedShipId)
    : "Select ship"

  return (
    <Card size="sm" className="border-0 border-b">
      <CardContent className="flex flex-col gap-ui-sm">
        <DottedTitle title="Combat Strategy" />

        {shipOptions.length > 1 && (
          <Select
            value={selectedShipId ?? ""}
            onValueChange={setSelectedShipId}
            disabled={isLoading}
          >
            <SelectTrigger variant="secondary" className="w-full">
              <div className="flex flex-row gap-2 items-center justify-center">
                Ship:{" "}
                <SelectValue>
                  <span className="text-foreground">{selectedShipName}</span>
                </SelectValue>
              </div>
            </SelectTrigger>
            <SelectContent>
              {shipOptions.map(({ id, name }) => (
                <SelectItem key={id} value={id}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {/* 3-badge template selector — always visible, highlights active.
            Switching template carries the current textarea draft so unsaved
            prompt edits aren't lost. */}
        <div className="grid grid-cols-3 gap-1">
          {TEMPLATES.map(({ id, label, blurb }) => {
            const isActive = activeTemplate === id
            return (
              <Button
                key={id}
                variant="ui"
                size="ui"
                active={isActive}
                onClick={() => dispatchSet(id, customPromptDraft.trim() || null)}
                disabled={!selectedShipId || isLoading}
                title={blurb}
                className={cn(
                  "uppercase tracking-wider",
                  isActive && "border-accent bg-accent-background text-foreground font-semibold"
                )}
              >
                {label}
              </Button>
            )
          })}
        </div>

        <div className="flex flex-col gap-ui-xs">
          <span className="uppercase text-subtle text-xxs">Additional guidance</span>
          <Textarea
            value={customPromptDraft}
            onChange={(e) => setCustomPromptDraft(e.target.value.slice(0, MAX_CUSTOM_PROMPT_CHARS))}
            maxLength={MAX_CUSTOM_PROMPT_CHARS}
            placeholder="Optional commander guidance appended to the base doctrine."
            disabled={!selectedShipId || isLoading}
            rows={3}
            className="text-xxs md:text-xxs"
          />
          <div className="flex items-center justify-between text-xxs text-subtle">
            <span>
              {customPromptDraft.length}/{MAX_CUSTOM_PROMPT_CHARS}
            </span>
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={() => setCustomPromptDraft("")}
              disabled={!selectedShipId || isLoading || customPromptDraft.length === 0}
              title="Clear guidance"
              aria-label="Clear guidance"
              className="size-4 text-muted-foreground"
            >
              <TrashIcon className="size-3" />
            </Button>
          </div>
        </div>

        <Button
          size="ui"
          variant="ui"
          onClick={() =>
            dispatchSet(activeTemplate ?? "balanced", customPromptDraft.trim() || null)
          }
          disabled={!selectedShipId || isLoading || !draftDiffers}
        >
          Save guidance
        </Button>

        {isLoading && (
          <div className="flex items-center justify-center py-2">
            <PanelContentLoader />
          </div>
        )}

        <Divider color="secondary" />
      </CardContent>
    </Card>
  )
}
