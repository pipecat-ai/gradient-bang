import {
  CastleTurret,
  Crosshair,
  MapPin,
  Rocket,
  Shield,
  UserCircle,
  XCircle,
} from "@phosphor-icons/react"
import { useState } from "react"

import type { ControllerConfig } from "../controllers/types"
import { useAppStore } from "../store/appStore"
import type { CombatEngine } from "../engine/engine"
import { SHIP_DEFINITIONS } from "../engine/ship_definitions"
import {
  corpId as corpIdBrand,
  type Character,
  type CharacterId,
  type EntityId,
  type World,
} from "../engine/types"
import { ControllerPicker } from "./ControllerPicker"

interface Props {
  engine: CombatEngine
  world: World
  onSetController: (id: string, config: ControllerConfig | null) => void
}

function characterInActiveCombat(world: World, charId: string): boolean {
  for (const encounter of world.activeCombats.values()) {
    if (encounter.ended) continue
    if (charId in encounter.participants) return true
  }
  return false
}

function entityInActiveCombat(world: World, id: string): boolean {
  for (const encounter of world.activeCombats.values()) {
    if (encounter.ended) continue
    if (id in encounter.participants) return true
  }
  return false
}

function findActiveCombatForEntity(
  world: World,
  id: string,
): { round: number; combat_id: string } | null {
  for (const encounter of world.activeCombats.values()) {
    if (encounter.ended) continue
    if (id in encounter.participants) {
      return { round: encounter.round, combat_id: encounter.combat_id }
    }
  }
  return null
}

export function EntityRoster({ engine, world, onSetController }: Props) {
  const selectedId = useAppStore((s) => s.selectedEntityId)
  const toggle = useAppStore((s) => s.toggleEntity)

  const characters = Array.from(world.characters.values())
  const corpShips = Array.from(world.ships.values()).filter((s) => s.ownerCorpId)
  const garrisons = Array.from(world.garrisons.values())
  const totalEntities = characters.length + corpShips.length + garrisons.length
  if (totalEntities === 0) return null

  const hasSelection = selectedId != null

  return (
    <div className="bg-neutral-950/60 px-3 py-2">
      <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-wider text-neutral-500">
        <span className="whitespace-nowrap">Entities · {totalEntities}</span>
        {selectedId ? (
          <div className="ml-auto flex min-w-0 items-center gap-1.5">
            <span className="inline-flex items-center gap-1 rounded border border-emerald-400/80 bg-emerald-950 px-1 text-[9px] font-bold uppercase tracking-wider text-emerald-200">
              <Crosshair weight="bold" className="h-2.5 w-2.5" />
              POV
            </span>
            <span
              className="max-w-[140px] truncate normal-case tracking-normal text-emerald-300"
              title={selectedId}
            >
              {selectedId}
            </span>
            <button
              type="button"
              onClick={() => toggle(selectedId)}
              className="inline-flex items-center rounded bg-neutral-800 p-0.5 text-neutral-300 hover:bg-neutral-700"
              aria-label="Clear POV"
              title="Clear POV"
            >
              <XCircle weight="fill" className="h-3 w-3" />
            </button>
          </div>
        ) : (
          <span
            className="ml-auto whitespace-nowrap normal-case tracking-normal text-neutral-600"
            title="Click any tile to view the event log from its perspective"
          >
            tap a tile for POV
          </span>
        )}
      </div>

      {characters.length > 0 && (
        <Section
          icon={<UserCircle weight="duotone" className="h-3.5 w-3.5 text-emerald-400" />}
          label="Characters"
          count={characters.length}
        >
          {characters.map((c) => (
            <CharacterTile
              key={c.id}
              character={c}
              world={world}
              engine={engine}
              selectedId={selectedId}
              hasSelection={hasSelection}
              toggle={toggle}
              onSetController={onSetController}
            />
          ))}
        </Section>
      )}
      {corpShips.length > 0 && (
        <Section
          icon={<Rocket weight="duotone" className="h-3.5 w-3.5 text-purple-400" />}
          label="Corp ships"
          count={corpShips.length}
        >
          {corpShips.map((s) => {
            const combatantId = s.id as unknown as EntityId
            const selected = selectedId === combatantId
            const corp = s.ownerCorpId ? world.corporations.get(s.ownerCorpId) : undefined
            const locked = entityInActiveCombat(world, s.id)
            return (
              <div key={s.id} className="flex flex-col gap-1">
                <button
                  type="button"
                  onClick={() => toggle(combatantId)}
                  className={tileClass({
                    selected,
                    hasSelection,
                    base: "border-purple-900/60 bg-purple-950/30 hover:border-purple-700",
                    active:
                      "border-purple-300 bg-purple-900/40 ring-2 ring-purple-400 shadow-lg shadow-purple-900/30",
                  })}
                >
                  <div className="flex items-baseline gap-1.5">
                    {selected && <PovDot tone="purple" />}
                    <span className="text-[13px] font-semibold text-neutral-100">
                      {s.name ?? s.id}
                    </span>
                    <span className="text-[10px] text-purple-400">
                      {corp?.name ?? s.ownerCorpId}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[10px] text-purple-300/80">
                    {SHIP_DEFINITIONS[s.type]?.display_name ?? s.type}
                  </div>
                  <StatLine
                    sector={s.sector}
                    fighters={s.fighters}
                    maxFighters={s.fighters}
                    shields={s.shields}
                    maxShields={s.maxShields}
                    id={s.id}
                  />
                </button>
                <div className="px-1">
                  <ControllerPicker
                    entityId={combatantId}
                    onSetController={onSetController}
                    disabled={locked}
                    displayLabel={s.name ?? s.id}
                  />
                </div>
              </div>
            )
          })}
        </Section>
      )}
      {garrisons.length > 0 && (
        <Section
          icon={<CastleTurret weight="duotone" className="h-3.5 w-3.5 text-sky-400" />}
          label="Garrisons"
          count={garrisons.length}
        >
          {garrisons.map((g) => {
            const combatantId = `garrison:${g.sector}:${g.ownerCharacterId}` as EntityId
            const selected = selectedId === combatantId
            const owner = world.characters.get(g.ownerCharacterId)
            // A garrison in combat has `combatantId in encounter.participants`.
            // Without this badge the only way to know a garrison just auto-
            // triggered (or was pulled into) a fight was to scan the event
            // log — easy to miss.
            const inCombatEncounter = findActiveCombatForEntity(world, combatantId)
            return (
              <button
                key={g.id}
                type="button"
                onClick={() => toggle(combatantId)}
                className={tileClass({
                  selected,
                  hasSelection,
                  base: "border-sky-900/60 bg-sky-950/30 hover:border-sky-700",
                  active: "border-sky-300 bg-sky-900/40 ring-2 ring-sky-400 shadow-lg shadow-sky-900/30",
                })}
              >
                <div className="flex items-baseline gap-1.5">
                  {selected && <PovDot tone="sky" />}
                  <span className="text-[13px] font-semibold text-neutral-100">
                    {owner?.name ?? g.ownerCharacterId}
                  </span>
                  <span
                    className={`rounded px-1 text-[10px] uppercase tracking-wider ${
                      g.mode === "toll"
                        ? "bg-amber-950/60 text-amber-300"
                        : g.mode === "offensive"
                          ? "bg-rose-950/60 text-rose-300"
                          : "bg-sky-950/60 text-sky-300"
                    }`}
                  >
                    {g.mode}
                    {g.mode === "toll" ? ` · ${g.tollAmount}c` : ""}
                  </span>
                  {inCombatEncounter && (
                    <span className="rounded border border-rose-800 bg-rose-900/40 px-1 text-[10px] uppercase tracking-wider text-rose-200">
                      combat · r{inCombatEncounter.round}
                    </span>
                  )}
                </div>
                <StatLine sector={g.sector} fighters={g.fighters} id={g.id} />
              </button>
            )
          })}
        </Section>
      )}
    </div>
  )
}

function Section({
  icon,
  label,
  count,
  children,
}: {
  icon?: React.ReactNode
  label: string
  count: number
  children: React.ReactNode
}) {
  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-neutral-500">
        {icon}
        <span>{label}</span>
        <span className="text-neutral-700">·</span>
        <span>{count}</span>
      </div>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  )
}

function StatLine({
  sector,
  fighters,
  maxFighters,
  shields,
  maxShields,
}: {
  sector: number
  fighters: number
  maxFighters?: number
  shields?: number
  maxShields?: number
  /** Internal id; kept for callers but hidden from the rendered tile — the
   *  card header already carries the human-readable name. */
  id: string
}) {
  return (
    <div className="mt-1.5 space-y-1">
      <div className="flex items-center gap-1">
        <span className="inline-flex items-center gap-0.5 rounded bg-neutral-800/80 px-1.5 py-0.5 text-[10px] text-neutral-400">
          <MapPin weight="fill" className="h-2.5 w-2.5 text-neutral-500" />
          <span className="tabular-nums text-neutral-200">{sector}</span>
        </span>
      </div>
      <MiniBar
        icon={<Crosshair weight="bold" className="h-2.5 w-2.5 text-amber-400" />}
        value={fighters}
        max={maxFighters ?? fighters}
        tone="amber"
      />
      {shields != null && (
        <MiniBar
          icon={<Shield weight="fill" className="h-2.5 w-2.5 text-sky-400" />}
          value={shields}
          max={maxShields ?? shields}
          tone="sky"
        />
      )}
    </div>
  )
}

function MiniBar({
  icon,
  value,
  max,
  tone,
}: {
  icon: React.ReactNode
  value: number
  max: number
  tone: "amber" | "sky"
}) {
  const pct = max > 0 ? Math.max(0, Math.min(1, value / max)) * 100 : 0
  const fill = tone === "amber" ? "bg-amber-400" : "bg-sky-400"
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-3">{icon}</span>
      <div className="h-[3px] flex-1 overflow-hidden rounded-full bg-neutral-800">
        <div
          className={`h-full rounded-full transition-[width] duration-500 ease-out ${fill}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="tabular-nums text-[10px] text-neutral-400">
        {value}
        <span className="text-neutral-600">/{max}</span>
      </span>
    </div>
  )
}

function CharacterTile({
  character,
  world,
  engine,
  selectedId,
  hasSelection,
  toggle,
  onSetController,
}: {
  character: Character
  world: World
  engine: CombatEngine
  selectedId: EntityId | null
  hasSelection: boolean
  toggle: (id: EntityId) => void
  onSetController: (id: string, config: ControllerConfig | null) => void
}) {
  const selected = selectedId === character.id
  const ship = world.ships.get(character.currentShipId)
  const corp = character.corpId ? world.corporations.get(character.corpId) : undefined
  const inCombat = characterInActiveCombat(world, character.id)
  const corps = Array.from(world.corporations.values())

  const [moveTarget, setMoveTarget] = useState<number>(character.currentSector === 42 ? 1 : 42)

  const handleMove = () => {
    const result = engine.moveCharacter(character.id as CharacterId, moveTarget)
    if (!result.ok) alert(result.reason)
  }

  const handleCorpChange = (value: string) => {
    const charId = character.id as CharacterId
    if (value === "") {
      const r = engine.removeCharacterFromCorp(charId)
      if (!r.ok) alert(r.reason)
    } else {
      try {
        engine.addCharacterToCorp(charId, corpIdBrand(value))
      } catch (err) {
        alert((err as Error).message)
      }
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => toggle(character.id)}
        className={tileClass({
          selected,
          hasSelection,
          base: "border-neutral-800 bg-neutral-900 hover:border-neutral-700",
          active:
            "border-emerald-300 bg-emerald-900/40 ring-2 ring-emerald-400 shadow-lg shadow-emerald-900/30",
        })}
      >
        <div className="flex items-baseline gap-1.5">
          {selected && <PovDot tone="emerald" />}
          <span className="text-[13px] font-semibold text-neutral-100">{character.name}</span>
          {corp && <span className="text-[10px] text-purple-400">{corp.name}</span>}
          {inCombat && (
            <span className="rounded border border-rose-800 bg-rose-900/40 px-1 text-[10px] uppercase tracking-wider text-rose-200">
              combat
            </span>
          )}
        </div>
        {ship && (
          <div className="mt-0.5 text-[10px] text-emerald-400/80">
            {SHIP_DEFINITIONS[ship.type]?.display_name ?? ship.type}
          </div>
        )}
        <StatLine
          sector={character.currentSector}
          fighters={ship?.fighters ?? 0}
          maxFighters={ship?.fighters}
          shields={ship?.shields}
          maxShields={ship?.maxShields}
          id={character.id}
        />
      </button>
      <div className="px-1">
        <ControllerPicker
          entityId={character.id}
          onSetController={onSetController}
          disabled={inCombat}
          displayLabel={character.name}
        />
      </div>
      <div className="flex flex-wrap items-center gap-1 px-1 text-[10px] text-neutral-500">
        {!inCombat ? (
          <>
            <span>move →</span>
            <input
              type="number"
              value={moveTarget}
              onChange={(e) => setMoveTarget(Number(e.target.value))}
              className="w-10 rounded bg-neutral-800 px-1 py-0.5 text-[11px] text-neutral-200"
            />
            <button
              type="button"
              onClick={handleMove}
              className="rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-300 hover:bg-neutral-700"
            >
              go
            </button>
          </>
        ) : (
          <span className="text-rose-400">locked · in combat</span>
        )}
        {corps.length > 0 && (
          <>
            <span className="text-neutral-700">·</span>
            <span>corp</span>
            <select
              value={character.corpId ?? ""}
              onChange={(e) => handleCorpChange(e.target.value)}
              className="rounded bg-neutral-800 px-1 py-0.5 text-[11px] text-neutral-200"
            >
              <option value="">—</option>
              {corps.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </>
        )}
      </div>
    </div>
  )
}

function tileClass({
  selected,
  hasSelection,
  base,
  active,
}: {
  selected: boolean
  hasSelection: boolean
  base: string
  active: string
}): string {
  const root =
    "group relative w-full rounded-md border px-2.5 py-2 text-left text-xs transition-all duration-200"
  if (selected) return `${root} ${active} translate-x-[1px]`
  const dim = hasSelection ? "opacity-55 hover:opacity-100 hover:-translate-y-px" : "hover:-translate-y-px hover:shadow-md hover:shadow-black/40"
  return `${root} ${base} text-neutral-300 ${dim}`
}

function PovDot({ tone }: { tone: "emerald" | "purple" | "sky" }) {
  const styles = {
    emerald: "border-emerald-300 bg-emerald-950 text-emerald-200",
    purple: "border-purple-300 bg-purple-950 text-purple-200",
    sky: "border-sky-300 bg-sky-950 text-sky-200",
  }
  return (
    <span
      className={`rounded border px-1 text-[9px] font-bold uppercase tracking-wider ${styles[tone]}`}
    >
      POV
    </span>
  )
}
