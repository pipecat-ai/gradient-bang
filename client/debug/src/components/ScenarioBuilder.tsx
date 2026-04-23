import { useMemo, useState } from "react"

import type { CombatEngine } from "../engine/engine"
import { SHIP_DEFINITIONS } from "../engine/ship_definitions"
import { useAppStore } from "../store/appStore"
import {
  characterId as characterIdBrand,
  type Character,
  type Garrison,
  type GarrisonMode,
  type ShipType,
  type World,
} from "../engine/types"

interface Props {
  engine: CombatEngine
  world: World
  onSetController: (id: string, config: import("../controllers/types").ControllerConfig | null) => void
}

const SAMPLE_NAMES = ["Alice", "Bob", "Probe", "Jonboy", "Milo", "Nyx", "Ren", "Zed"]
const CORP_NAMES = ["Alpha", "Beta", "Gamma", "Delta"]

// escape_pod is a post-combat conversion target, not a startable ship.
const SELECTABLE_SHIP_TYPES = (
  Object.keys(SHIP_DEFINITIONS) as ShipType[]
).filter((t) => t !== "escape_pod")

function ShipTypeSelect({
  value,
  onChange,
  disabled,
}: {
  value: ShipType
  onChange: (v: ShipType) => void
  disabled?: boolean
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as ShipType)}
      disabled={disabled}
      className="rounded bg-neutral-800 px-1 py-0.5 text-[11px] text-neutral-200 disabled:opacity-50"
    >
      {SELECTABLE_SHIP_TYPES.map((t) => {
        const def = SHIP_DEFINITIONS[t]
        return (
          <option key={t} value={t}>
            {def.display_name} · F{def.fighters} · S{def.shields}
          </option>
        )
      })}
    </select>
  )
}

export function ScenarioBuilder({ engine, world, onSetController }: Props) {
  const clearSelection = useAppStore((s) => s.selectEntity)
  const [charShipType, setCharShipType] = useState<ShipType>("sparrow_scout")
  const [corpShipType, setCorpShipType] = useState<ShipType>("sparrow_scout")
  const defaultLLMConfig = {
    kind: "llm" as const,
    model: "gpt-5-mini",
  }
  const charsInSector42 = Array.from(world.characters.values()).filter(
    (c) => c.currentSector === 42,
  )
  const allChars: Character[] = Array.from(world.characters.values())
  const corpShipsInSector42 = Array.from(world.ships.values()).filter(
    (s) => s.ownerCorpId && s.sector === 42 && s.fighters > 0,
  )
  const garrisonsInSector42 = Array.from(world.garrisons.values()).filter(
    (g) => g.sector === 42 && g.fighters > 0,
  )
  const combatActiveInSector42 = Array.from(world.activeCombats.values()).some(
    (c) => !c.ended && c.sector_id === 42,
  )
  const totalInSector42 =
    charsInSector42.length + corpShipsInSector42.length + garrisonsInSector42.length
  const corps = Array.from(world.corporations.values())

  return (
    <div className="flex flex-col gap-2 border-b border-neutral-800 bg-neutral-950 px-4 py-2">
      <div className="flex items-center gap-2">
        <ActionButton
          tone="danger"
          onClick={() => {
            engine.resetWorld()
            clearSelection(null)
          }}
        >
          Reset world
        </ActionButton>
        <Divider />
        <ShipTypeSelect value={charShipType} onChange={setCharShipType} />
        <ActionButton
          tone="neutral"
          onClick={() => {
            const name = `${SAMPLE_NAMES[Math.floor(Math.random() * SAMPLE_NAMES.length)]}-${Math.floor(
              Math.random() * 100,
            )}`
            const sector = combatActiveInSector42 ? 1 : 42
            const charId = engine.createCharacter({ name, sector, shipType: charShipType })
            // Default every new character to an LLM controller — the harness
            // is primarily for exercising LLM-driven combat flows.
            onSetController(charId, { ...defaultLLMConfig })
          }}
          title={
            combatActiveInSector42
              ? "Combat active in sector 42 — new char spawns in sector 1 (LLM controller set by default)"
              : `Create a ${SHIP_DEFINITIONS[charShipType].display_name} (LLM controller set by default)`
          }
        >
          + Character
        </ActionButton>
        <ActionButton
          tone="corp"
          disabled={allChars.length === 0}
          onClick={() => {
            const name = CORP_NAMES[corps.length % CORP_NAMES.length]
            const members = allChars.length > 0 ? [allChars[0].id] : []
            try {
              engine.createCorporation({ name, memberCharacterIds: members })
            } catch (err) {
              alert((err as Error).message)
            }
          }}
          title={
            allChars.length === 0 ? "Create a character first (becomes initial corp member)" : ""
          }
        >
          + Corp
        </ActionButton>
        <ShipTypeSelect
          value={corpShipType}
          onChange={setCorpShipType}
          disabled={corps.length === 0}
        />
        <ActionButton
          tone="corp"
          disabled={corps.length === 0}
          onClick={() => {
            const corp = corps[0]
            try {
              const shipId = engine.createCorpShip({
                ownerCorpId: corp.id,
                sector: 42,
                shipType: corpShipType,
              })
              // Corp ships have no human pilot — default them to LLM too.
              onSetController(shipId, { ...defaultLLMConfig })
            } catch (err) {
              alert((err as Error).message)
            }
          }}
          title={
            corps.length === 0
              ? "Create a corporation first"
              : `Adds a ${SHIP_DEFINITIONS[corpShipType].display_name} to ${corps[0]?.name}`
          }
        >
          + Corp ship
        </ActionButton>
        <Divider />
        <ActionButton
          tone="combat"
          disabled={
            charsInSector42.length === 0 || (!combatActiveInSector42 && totalInSector42 < 2)
          }
          onClick={() => {
            const activeCombat = Array.from(world.activeCombats.values()).find(
              (c) => !c.ended && c.sector_id === 42,
            )
            const initiator = activeCombat
              ? charsInSector42.find((c) => !(c.id in activeCombat.participants)) ??
                charsInSector42[0]
              : charsInSector42[0]
            try {
              engine.initiateCombat(initiator.id, 42)
            } catch (err) {
              alert((err as Error).message)
            }
          }}
          title={
            charsInSector42.length === 0
              ? "Need at least one character in sector 42 to initiate"
              : combatActiveInSector42
                ? "Joins the existing combat (adds initiator as participant)"
                : totalInSector42 < 2
                  ? "Need 2+ participants in sector 42"
                  : ""
          }
        >
          {combatActiveInSector42 ? "Join combat" : "Initiate combat"}
        </ActionButton>
        <span className="ml-auto text-[11px] text-neutral-500">
          <span className="text-neutral-400">sector 42</span>
          <span className="mx-1 text-neutral-700">·</span>
          <span className={charsInSector42.length > 0 ? "text-neutral-200" : undefined}>
            {charsInSector42.length} char{charsInSector42.length === 1 ? "" : "s"}
          </span>
          <span className="mx-1 text-neutral-700">·</span>
          <span className={corpShipsInSector42.length > 0 ? "text-purple-300" : undefined}>
            {corpShipsInSector42.length} corp ship{corpShipsInSector42.length === 1 ? "" : "s"}
          </span>
          <span className="mx-1 text-neutral-700">·</span>
          <span className={garrisonsInSector42.length > 0 ? "text-sky-300" : undefined}>
            {garrisonsInSector42.length} garrison{garrisonsInSector42.length === 1 ? "" : "s"}
          </span>
          <span className="mx-1 text-neutral-700">·</span>
          <span className={combatActiveInSector42 ? "text-emerald-300" : undefined}>
            {combatActiveInSector42 ? "in combat" : "peaceful"}
          </span>
        </span>
      </div>
      <DeployGarrisonControls
        engine={engine}
        allChars={allChars}
        garrisonInSector={garrisonsInSector42[0]}
      />
    </div>
  )
}

type ButtonTone = "neutral" | "danger" | "combat" | "corp" | "garrison"

function ActionButton({
  tone,
  onClick,
  disabled,
  title,
  children,
}: {
  tone: ButtonTone
  onClick: () => void
  disabled?: boolean
  title?: string
  children: React.ReactNode
}) {
  const tones: Record<ButtonTone, string> = {
    neutral: "bg-neutral-800 text-neutral-200 hover:bg-neutral-700",
    danger: "bg-rose-900/30 text-rose-200 hover:bg-rose-900/50",
    combat: "bg-emerald-900/40 text-emerald-200 hover:bg-emerald-900/60",
    corp: "bg-purple-900/40 text-purple-200 hover:bg-purple-900/60",
    garrison: "bg-sky-900/40 text-sky-200 hover:bg-sky-900/60",
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded px-3 py-1 text-xs transition ${tones[tone]} disabled:cursor-not-allowed disabled:opacity-40`}
    >
      {children}
    </button>
  )
}

function Divider() {
  return <span className="h-4 w-px bg-neutral-800" />
}

function DeployGarrisonControls({
  engine,
  allChars,
  garrisonInSector,
}: {
  engine: CombatEngine
  allChars: Character[]
  garrisonInSector: Garrison | undefined
}) {
  const [ownerId, setOwnerId] = useState<string>("")
  const [mode, setMode] = useState<GarrisonMode>("defensive")
  const [tollAmount, setTollAmount] = useState<number>(100)
  const [fighters, setFighters] = useState<number>(30)

  const effectiveOwnerId = useMemo(() => {
    if (ownerId && allChars.some((c) => c.id === ownerId)) return ownerId
    return allChars[0]?.id ?? ""
  }, [ownerId, allChars])

  const blocked = Boolean(garrisonInSector)
  const disabled = allChars.length === 0 || blocked

  return (
    <div className="flex flex-wrap items-center gap-2 rounded border border-sky-900/40 bg-sky-950/20 px-2 py-1">
      <span className="text-[10px] uppercase tracking-wider text-sky-300">Deploy garrison</span>
      <Field label="owner">
        <select
          value={effectiveOwnerId}
          onChange={(e) => setOwnerId(e.target.value)}
          disabled={allChars.length === 0}
          className="rounded bg-neutral-800 px-1 py-0.5 text-[11px] text-neutral-200 disabled:opacity-50"
        >
          {allChars.length === 0 ? (
            <option value="">(none)</option>
          ) : (
            allChars.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))
          )}
        </select>
      </Field>
      <Field label="mode">
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as GarrisonMode)}
          className="rounded bg-neutral-800 px-1 py-0.5 text-[11px] text-neutral-200"
        >
          <option value="defensive">defensive</option>
          <option value="offensive">offensive</option>
          <option value="toll">toll</option>
        </select>
      </Field>
      <Field label="fighters">
        <input
          type="number"
          min={1}
          value={fighters}
          onChange={(e) => setFighters(Number(e.target.value))}
          className="w-14 rounded bg-neutral-800 px-1 py-0.5 text-[11px] text-neutral-200"
        />
      </Field>
      {mode === "toll" && (
        <Field label="toll">
          <input
            type="number"
            min={0}
            value={tollAmount}
            onChange={(e) => setTollAmount(Number(e.target.value))}
            className="w-16 rounded bg-neutral-800 px-1 py-0.5 text-[11px] text-neutral-200"
          />
          <span className="text-[10px] text-neutral-500">c</span>
        </Field>
      )}
      <ActionButton
        tone="garrison"
        disabled={disabled || !effectiveOwnerId}
        onClick={() => {
          try {
            engine.deployGarrison({
              ownerCharacterId: characterIdBrand(effectiveOwnerId),
              sector: 42,
              fighters,
              mode,
              tollAmount: mode === "toll" ? tollAmount : 0,
            })
          } catch (err) {
            alert((err as Error).message)
          }
        }}
        title={
          blocked
            ? "Sector 42 already has a garrison — only one allowed per sector"
            : allChars.length === 0
              ? "Create a character first"
              : `Deploy in sector 42 for ${allChars.find((c) => c.id === effectiveOwnerId)?.name ?? effectiveOwnerId}`
        }
      >
        Deploy →
      </ActionButton>
      {blocked && garrisonInSector && (
        <span className="text-[10px] text-neutral-500">
          blocked · {garrisonInSector.mode} garrison with {garrisonInSector.fighters} fighters
        </span>
      )}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-1 text-[10px] text-neutral-500">
      {label}
      {children}
    </label>
  )
}
