import { useState } from "react"

import type { ControllerConfig } from "../controllers/types"
import { useAppStore } from "../store/appStore"
import type { CombatEngine } from "../engine/engine"
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
    <div className="border-b border-neutral-800 bg-neutral-950/60 px-4 py-2">
      <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-wider text-neutral-500">
        <span>Entities · {totalEntities}</span>
        {selectedId ? (
          <>
            <span className="text-neutral-600">·</span>
            <span className="rounded border border-emerald-300 bg-emerald-950 px-1 text-[9px] font-bold uppercase tracking-wider text-emerald-200">
              POV
            </span>
            <span className="normal-case tracking-normal text-emerald-300">{selectedId}</span>
            <button
              type="button"
              onClick={() => toggle(selectedId)}
              className="ml-auto rounded bg-neutral-800 px-2 py-0.5 text-[10px] normal-case tracking-normal text-neutral-300 hover:bg-neutral-700"
            >
              Clear
            </button>
          </>
        ) : (
          <span className="text-neutral-600">· click a tile to view from its perspective</span>
        )}
      </div>

      {characters.length > 0 && (
        <Section label="Characters" count={characters.length}>
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
        <Section label="Corp ships" count={corpShips.length}>
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
                  />
                </div>
              </div>
            )
          })}
        </Section>
      )}
      {garrisons.length > 0 && (
        <Section label="Garrisons" count={garrisons.length}>
          {garrisons.map((g) => {
            const combatantId = `garrison:${g.sector}:${g.ownerCharacterId}` as EntityId
            const selected = selectedId === combatantId
            const owner = world.characters.get(g.ownerCharacterId)
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
  label,
  count,
  children,
}: {
  label: string
  count: number
  children: React.ReactNode
}) {
  return (
    <div className="mb-2 last:mb-0">
      <div className="mb-1 text-[10px] uppercase tracking-wider text-neutral-600">
        {label} · {count}
      </div>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  )
}

function StatLine({
  sector,
  fighters,
  maxFighters,
  shields,
  maxShields,
  id,
}: {
  sector: number
  fighters: number
  maxFighters?: number
  shields?: number
  maxShields?: number
  id: string
}) {
  return (
    <>
      <div className="mt-0.5 flex items-center gap-2 text-[11px] text-neutral-400">
        <span>
          sec <span className="text-neutral-200">{sector}</span>
        </span>
        <span className="text-neutral-700">·</span>
        <span>
          F <span className="text-neutral-200">{fighters}</span>
          {maxFighters != null ? <span className="text-neutral-600">/{maxFighters}</span> : null}
        </span>
        {shields != null && (
          <>
            <span className="text-neutral-700">·</span>
            <span>
              S <span className="text-neutral-200">{shields}</span>
              {maxShields != null ? <span className="text-neutral-600">/{maxShields}</span> : null}
            </span>
          </>
        )}
      </div>
      <div className="mt-0.5 font-mono text-[10px] text-neutral-600">{id}</div>
    </>
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
  const root = "min-w-[180px] rounded border px-2 py-1 text-left text-xs transition"
  if (selected) return `${root} ${active}`
  const dim = hasSelection ? "opacity-60 hover:opacity-100" : ""
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
