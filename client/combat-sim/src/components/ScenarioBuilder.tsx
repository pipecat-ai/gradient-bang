import { faker } from "@faker-js/faker"
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
import { CorporationManager } from "./CorporationManager"

interface Props {
  engine: CombatEngine
  world: World
  onSetController: (id: string, config: import("../controllers/types").ControllerConfig | null) => void
}

// Pilot callsigns: "Valkyrie Ortiz", "Nomad Chen", etc. Pairs a sci-fi
// callsign with a surname for variety + flavour without getting too cute.
// Legacy SAMPLE_NAMES/CORP_NAMES arrays were replaced with Faker-generated
// names to give randomized scenarios more presentation-ready flavour.
function randomCharacterName(): string {
  const callsigns = [
    "Valkyrie", "Nomad", "Rogue", "Raven", "Phantom", "Viper", "Echo",
    "Cypher", "Apex", "Nyx", "Specter", "Havoc", "Saber", "Orbit",
    "Quasar", "Titan", "Vesper", "Halo", "Onyx", "Draco",
  ]
  const callsign = faker.helpers.arrayElement(callsigns)
  const surname = faker.person.lastName()
  return `${callsign} ${surname}`
}

function randomCorporationName(): string {
  return `${faker.company.name().split(/[,\s]+/)[0]} ${
    faker.helpers.arrayElement(["Syndicate", "Industries", "Consortium", "Mining", "Haulage", "Dynamics"])
  }`
}

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
  const [corpManagerOpen, setCorpManagerOpen] = useState(false)
  const defaultLLMConfig = {
    kind: "llm" as const,
    model: "gpt-4.1",
    strategy: "balanced" as const,
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
        <ActionButton
          tone="combat"
          onClick={() => {
            engine.resetWorld()
            clearSelection(null)
            generateRandomScenario(engine, onSetController, defaultLLMConfig)
          }}
          title="Reset + generate a random scenario (characters, corps, corp ships, maybe a garrison)"
        >
          🎲 Random scenario
        </ActionButton>
        <Divider />
        <ShipTypeSelect value={charShipType} onChange={setCharShipType} />
        <ActionButton
          tone="neutral"
          onClick={() => {
            const name = randomCharacterName()
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
            const name = randomCorporationName()
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
        <ActionButton
          tone="corp"
          onClick={() => setCorpManagerOpen(true)}
          title="Open the drag-and-drop corporation manager"
        >
          Manage corps
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
      <CorporationManager
        engine={engine}
        world={world}
        open={corpManagerOpen}
        onClose={() => setCorpManagerOpen(false)}
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

// ---- Random scenario generator ---------------------------------------------
// Bounds chosen so a single click produces something interesting-ish without
// overwhelming the UI. 2–4 characters, 0–2 corps, 0–3 corp ships, 0–1 garrison.
//
// All LLM-backed by default (uses the same `defaultLLMConfig` as the + Character
// button) so kicking off combat right after clicking Random is one click away.

const RANDOM_CHAR_SHIPS: ShipType[] = [
  "sparrow_scout",
  "kestrel_courier",
  "corsair_raider",
  "pike_frigate",
]
const RANDOM_CORP_SHIPS: ShipType[] = [
  "autonomous_probe",
  "autonomous_light_hauler",
  "sparrow_scout",
]
const RANDOM_GARRISON_MODES: GarrisonMode[] = [
  "defensive",
  "offensive",
  "toll",
]

const RANDOM_STRATEGIES: Array<"balanced" | "offensive" | "defensive"> = [
  "balanced",
  "offensive",
  "defensive",
]

function pick<T>(arr: readonly T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)]
}

function randInt(min: number, max: number, rng: () => number): number {
  return Math.floor(rng() * (max - min + 1)) + min
}

function generateRandomScenario(
  engine: CombatEngine,
  onSetController: (
    id: string,
    config: import("../controllers/types").ControllerConfig | null,
  ) => void,
  defaultLLMConfig: import("../controllers/types").ControllerConfig,
): void {
  const rng = Math.random

  // 2–4 player characters, all in sector 42 so they start entangled.
  // Each gets a random strategy so a single run exercises all three and
  // (with enough rerolls) every pairwise matchup.
  const charCount = randInt(2, 4, rng)
  const chars: string[] = []
  for (let i = 0; i < charCount; i++) {
    const name = randomCharacterName()
    const shipType = pick(RANDOM_CHAR_SHIPS, rng)
    const id = engine.createCharacter({ name, sector: 42, shipType })
    chars.push(id)
    onSetController(id, {
      ...defaultLLMConfig,
      strategy: pick(RANDOM_STRATEGIES, rng),
    })
  }

  // 0–2 corps. Each gets 0–2 random characters as members.
  const corpCount = randInt(0, 2, rng)
  const corpIds: string[] = []
  for (let i = 0; i < corpCount; i++) {
    const name = randomCorporationName()
    // Split available chars across corps so we don't double-assign.
    const takeCount = randInt(0, Math.min(2, chars.length), rng)
    const members = chars
      .slice()
      .sort(() => rng() - 0.5)
      .slice(0, takeCount)
      .map((id) => characterIdBrand(id))
    try {
      const cid = engine.createCorporation({
        name,
        memberCharacterIds: members,
      })
      corpIds.push(cid)
    } catch {
      // Duplicate name etc. — ignore; one fewer corp is fine.
    }
  }

  // 0–3 corp ships, spread across the corps we just made. If no corps
  // exist, skip corp ships (they require an owner).
  if (corpIds.length > 0) {
    const shipCount = randInt(0, 3, rng)
    for (let i = 0; i < shipCount; i++) {
      const ownerCorpId = pick(corpIds, rng)
      const shipType = pick(RANDOM_CORP_SHIPS, rng)
      try {
        const sid = engine.createCorpShip({
          ownerCorpId: ownerCorpId as import("../engine/types").CorpId,
          sector: 42,
          shipType,
        })
        onSetController(sid, {
          ...defaultLLMConfig,
          strategy: pick(RANDOM_STRATEGIES, rng),
        })
      } catch {
        // e.g. dead corp; skip.
      }
    }
  }

  // 0–1 garrison. Any random char owns it, any random mode. Toll mode
  // gets a sensible toll amount.
  if (chars.length > 0 && rng() < 0.6) {
    const ownerId = pick(chars, rng)
    const mode = pick(RANDOM_GARRISON_MODES, rng)
    try {
      engine.deployGarrison({
        ownerCharacterId: characterIdBrand(ownerId),
        sector: 42,
        fighters: randInt(20, 80, rng),
        mode,
        tollAmount: mode === "toll" ? randInt(20, 100, rng) : 0,
      })
    } catch {
      // Sector might already have a garrison; skip.
    }
  }
}
