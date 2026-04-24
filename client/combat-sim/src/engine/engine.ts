import {
  buildCombatEndedPayload,
  buildRoundResolvedPayload,
  buildRoundWaitingPayload,
  collectParticipantIds,
} from "./events"
import { InMemoryEmitter, type Emitter } from "./emitter"
import { DEFAULT_SHIP_TYPE, SHIP_DEFINITIONS } from "./ship_definitions"
import { buildCorporationMap } from "./friendly"
import {
  allHostilesPaid,
  anyOutstandingToll,
  buildGarrisonActions,
  ensureTollRegistry,
  type TollRegistryEntry,
} from "./garrison"
import { ROUND_TIMEOUT_SECONDS, SHIELD_REGEN_PER_ROUND, resolveRound } from "./resolution"
import {
  characterId,
  combatId,
  corpId as corpIdBrand,
  garrisonId,
  makeEmptyWorld,
  shipId,
  type ActionResult,
  type Character,
  type CharacterId,
  type CombatEncounterState,
  type CombatEvent,
  type CombatId,
  type CombatRoundOutcome,
  type CombatantState,
  type CorpId,
  type Corporation,
  type EntityId,
  type Garrison,
  type GarrisonId,
  type GarrisonMode,
  type RoundActionState,
  type SectorId,
  type Ship,
  type ShipId,
  type ShipType,
  type SubmitAction,
  type World,
} from "./types"

export interface CombatEngineOpts {
  emitter?: Emitter
  now?: () => number
  rng?: () => number
  /**
   * When false, new rounds are created with `deadline: null` so rounds only
   * resolve via all-submitted, never via tick. Useful for debugging without
   * time pressure. Default: true.
   */
  timerEnabled?: boolean
  /**
   * When true, auto-engage on arrival and garrison deploy-time auto-initiate
   * are suppressed until `runScenario()` is called. Lets the user compose
   * the arena without combat firing mid-setup. Default: false.
   */
  stagingMode?: boolean
}

export interface CreateCharacterOpts {
  name: string
  shipType?: ShipType
  sector?: SectorId
  credits?: number
  fighters?: number
  shields?: number
  cargo?: number
  turnsPerWarp?: number
}

export interface DeployGarrisonOpts {
  ownerCharacterId: CharacterId
  sector: SectorId
  fighters: number
  mode?: GarrisonMode
  tollAmount?: number
}

export interface CreateCorporationOpts {
  name: string
  memberCharacterIds?: CharacterId[]
}

export interface CreateCorpShipOpts {
  ownerCorpId: CorpId
  sector: SectorId
  name?: string
  shipType?: ShipType
  fighters?: number
  shields?: number
  cargo?: number
  credits?: number
}

/**
 * The in-process combat engine. Synchronous. Deterministic given a seeded rng + now.
 * Ported back into `_shared/combat/` when mature.
 */
export class CombatEngine {
  readonly emitter: Emitter
  private readonly now: () => number
  private readonly rng: () => number

  private world: World = makeEmptyWorld()
  private snapshot: World = makeEmptyWorld()
  private idSeq = 0
  private eventSeq = 0
  private timerEnabled: boolean
  // Harness-only "composition" flag. When true, `moveCharacter` does NOT
  // auto-engage hostile garrisons on arrival. Lets the user assemble the
  // arena (randomize, drop ships into garrison sectors, etc) without combat
  // kicking off mid-setup. Flip to false via `runScenario()` to release.
  private stagingMode = false

  constructor(opts: CombatEngineOpts = {}) {
    this.emitter = opts.emitter ?? new InMemoryEmitter()
    this.now = opts.now ?? (() => Date.now())
    this.rng = opts.rng ?? Math.random
    this.timerEnabled = opts.timerEnabled ?? true
    this.stagingMode = opts.stagingMode ?? false
    this.refreshSnapshot()
  }

  /** True while the scenario is still being composed — auto-engage is gated. */
  isStagingMode(): boolean {
    return this.stagingMode
  }

  /** Enter composition mode: no auto-engage on arrival until `runScenario()`. */
  setStagingMode(enabled: boolean): void {
    this.stagingMode = enabled
  }

  /**
   * Release composition mode and kick off combat anywhere it's viable:
   *   1. Every offensive/toll garrison gets a deploy-time auto-initiate pass,
   *      same as if it had just been deployed outside staging.
   *   2. Every character triggers the arrival auto-engage path so characters
   *      sitting in garrison sectors get pulled into combat.
   *   3. Any sector with 2+ combatants (and no active combat) gets an
   *      explicit `initiateCombat` call. Production combat only auto-starts
   *      via garrison aggression — this extra pass is harness-only so
   *      "Run scenario" reliably produces a fight from a composed arena
   *      even when no aggressive garrison is present.
   */
  runScenario(): void {
    if (!this.stagingMode) return
    this.stagingMode = false
    // Snapshot before iteration — all paths mutate activeCombats.
    const garrisons = Array.from(this.world.garrisons.values())
    for (const g of garrisons) {
      if (g.mode === "offensive" || g.mode === "toll") {
        this.maybeAutoInitiateFromGarrison(g)
      }
    }
    const chars = Array.from(this.world.characters.values()).map((c) => ({
      id: c.id,
      sector: c.currentSector,
    }))
    for (const { id, sector } of chars) {
      this.maybeAutoEngageOnArrival(id, sector)
    }
    // Sectors with 2+ combatants and no active combat → explicit initiate.
    const sectorsTried = new Set<SectorId>()
    for (const c of this.world.characters.values()) {
      if (sectorsTried.has(c.currentSector)) continue
      sectorsTried.add(c.currentSector)
      const existing = Array.from(this.world.activeCombats.values()).some(
        (enc) => !enc.ended && enc.sector_id === c.currentSector,
      )
      if (existing) continue
      const combatants = this.buildSectorCombatants(c.currentSector)
      if (combatants.length < 2) continue
      try {
        this.initiateCombat(c.id, c.currentSector)
      } catch {
        // Sector had combatants but none were targetable (e.g. all corp-mates
        // + a friendly garrison). Harmless — skip.
      }
    }
  }

  /** Read current timer state (whether rounds get a real deadline). */
  isTimerEnabled(): boolean {
    return this.timerEnabled
  }

  /**
   * Toggle the round timer. When turning off, clears deadlines on any active
   * combats so the current round no longer has a ticking countdown. When
   * turning back on, resets active-combat deadlines to now + 30s. Emits a
   * synthetic `harness.timer_toggled` event so UI + subscribers re-render.
   */
  setTimerEnabled(enabled: boolean): void {
    this.timerEnabled = enabled
    for (const encounter of this.world.activeCombats.values()) {
      if (!encounter.ended) {
        encounter.deadline = this.computeDeadline()
      }
    }
    this.emit({
      type: "harness.timer_toggled",
      payload: { enabled },
      recipients: [],
    })
  }

  private computeDeadline(): number | null {
    return this.timerEnabled ? this.now() + ROUND_TIMEOUT_SECONDS * 1000 : null
  }

  // ---- World setup ----

  resetWorld(): void {
    this.world = makeEmptyWorld()
    this.idSeq = 0
    this.eventSeq = 0
    if (this.emitter instanceof InMemoryEmitter) this.emitter.clear()
    this.emit({ type: "world.reset", payload: {}, recipients: [] })
  }

  createCharacter(opts: CreateCharacterOpts): CharacterId {
    const charId = characterId(this.nextId("char"))
    // Ship stats default from the production ship_definitions table so combat
    // scales match real matchups; callers may still override any field.
    const type = opts.shipType ?? DEFAULT_SHIP_TYPE
    const def = SHIP_DEFINITIONS[type]
    const shipMaxShields = def.shields
    const ship: Ship = {
      id: shipId(this.nextId("ship")),
      type,
      ownerCharacterId: charId,
      fighters: opts.fighters ?? def.fighters,
      shields: opts.shields ?? shipMaxShields,
      maxShields: shipMaxShields,
      turnsPerWarp: opts.turnsPerWarp ?? def.turns_per_warp,
      cargo: opts.cargo ?? 0,
      credits: opts.credits ?? 1000,
      sector: opts.sector ?? 1,
    }
    const character: Character = {
      id: charId,
      name: opts.name,
      currentShipId: ship.id,
      currentSector: opts.sector ?? 1,
    }
    this.world.characters.set(charId, character)
    this.world.ships.set(ship.id, ship)

    this.emit({
      type: "character.created",
      payload: {
        character_id: charId,
        name: character.name,
        ship_id: ship.id,
        sector: character.currentSector,
        credits: ship.credits,
      },
      recipients: [charId],
      actor: charId,
      sector_id: character.currentSector,
    })
    return charId
  }

  createCorporation(opts: CreateCorporationOpts): CorpId {
    const cid = corpIdBrand(this.nextId("corp"))
    const corp: Corporation = {
      id: cid,
      name: opts.name,
      memberCharacterIds: [],
    }
    this.world.corporations.set(cid, corp)
    for (const memberId of opts.memberCharacterIds ?? []) {
      this.addCharacterToCorpInternal(memberId, cid)
    }

    this.emit({
      type: "corporation.created",
      payload: { corp_id: cid, name: opts.name, members: corp.memberCharacterIds },
      recipients: corp.memberCharacterIds as EntityId[],
      actor: corp.memberCharacterIds[0],
    })
    return cid
  }

  addCharacterToCorp(charId: CharacterId, cid: CorpId): void {
    this.addCharacterToCorpInternal(charId, cid)
    this.emit({
      type: "corporation.member_added",
      payload: { corp_id: cid, character_id: charId },
      recipients: [charId],
      actor: charId,
    })
  }

  removeCharacterFromCorp(charId: CharacterId): ActionResult {
    const char = this.world.characters.get(charId)
    if (!char) return { ok: false, reason: "no such character" }
    const cid = char.corpId
    if (!cid) return { ok: false, reason: "character is not in a corp" }
    const corp = this.world.corporations.get(cid)
    if (corp) {
      corp.memberCharacterIds = corp.memberCharacterIds.filter((id) => id !== charId)
    }
    char.corpId = undefined

    this.emit({
      type: "corporation.member_removed",
      payload: { corp_id: cid, character_id: charId },
      recipients: [charId],
      actor: charId,
    })
    return { ok: true }
  }

  createCorpShip(opts: CreateCorpShipOpts): ShipId {
    const corp = this.world.corporations.get(opts.ownerCorpId)
    if (!corp) throw new Error(`No such corporation: ${opts.ownerCorpId}`)

    const sid = shipId(this.nextId("ship"))
    const type = opts.shipType ?? DEFAULT_SHIP_TYPE
    const def = SHIP_DEFINITIONS[type]
    const shieldsMax = opts.shields ?? def.shields
    const ship: Ship = {
      id: sid,
      type,
      name: opts.name ?? `${corp.name} Probe ${this.world.ships.size + 1}`,
      ownerCorpId: opts.ownerCorpId,
      fighters: opts.fighters ?? def.fighters,
      shields: shieldsMax,
      maxShields: shieldsMax,
      turnsPerWarp: def.turns_per_warp,
      cargo: opts.cargo ?? 0,
      credits: opts.credits ?? 0,
      sector: opts.sector,
    }
    this.world.ships.set(sid, ship)

    this.emit({
      type: "corp_ship.created",
      payload: {
        ship_id: sid,
        ship_name: ship.name,
        ship_type: ship.type,
        corp_id: opts.ownerCorpId,
        corp_name: corp.name,
        sector: opts.sector,
        fighters: ship.fighters,
        shields: ship.shields,
      },
      // Corp-scope visibility: every corp member sees their corp's new ship.
      recipients: [...corp.memberCharacterIds, sid] as EntityId[],
      sector_id: opts.sector,
    })
    return sid
  }

  private addCharacterToCorpInternal(charId: CharacterId, cid: CorpId): void {
    const char = this.world.characters.get(charId)
    if (!char) throw new Error(`No such character: ${charId}`)
    const corp = this.world.corporations.get(cid)
    if (!corp) throw new Error(`No such corporation: ${cid}`)
    char.corpId = cid
    if (!corp.memberCharacterIds.includes(charId)) {
      corp.memberCharacterIds.push(charId)
    }
  }

  /**
   * Reassign a corp ship from one corporation to another (or to no corp, if
   * `newCorpId` is null). Blocks the transfer while the ship is a live
   * combat participant — mirroring the character chip's "cannot move while
   * in combat" guard — otherwise the old corp's fan-out would continue to
   * deliver events to the old corp even though the ship belongs elsewhere.
   */
  transferCorpShip(sid: ShipId, newCorpId: CorpId | null): ActionResult {
    const ship = this.world.ships.get(sid)
    if (!ship) return { ok: false, reason: "no such ship" }
    if (!ship.ownerCorpId && newCorpId == null) {
      return { ok: false, reason: "ship is not a corp ship and no target corp given" }
    }
    for (const encounter of this.world.activeCombats.values()) {
      if (encounter.ended) continue
      if ((sid as unknown as string) in encounter.participants) {
        return { ok: false, reason: "ship is in active combat — cannot reassign" }
      }
    }
    if (newCorpId != null) {
      const target = this.world.corporations.get(newCorpId)
      if (!target) return { ok: false, reason: `no such corporation: ${newCorpId}` }
    }
    const prevCorpId = ship.ownerCorpId ?? null
    if (prevCorpId === newCorpId) return { ok: true } // no-op

    if (newCorpId == null) {
      delete ship.ownerCorpId
    } else {
      ship.ownerCorpId = newCorpId
    }

    // Notify both corps' members so their corp_info snapshots stay fresh.
    const recipientSet = new Set<string>()
    recipientSet.add(sid as unknown as string)
    const prev = prevCorpId ? this.world.corporations.get(prevCorpId) : null
    if (prev) for (const m of prev.memberCharacterIds) recipientSet.add(m)
    const next = newCorpId ? this.world.corporations.get(newCorpId) : null
    if (next) for (const m of next.memberCharacterIds) recipientSet.add(m)

    this.emit({
      type: "corp_ship.transferred",
      payload: {
        ship_id: sid,
        ship_name: ship.name,
        ship_type: ship.type,
        prev_corp_id: prevCorpId,
        prev_corp_name: prev?.name ?? null,
        new_corp_id: newCorpId,
        new_corp_name: next?.name ?? null,
        sector: ship.sector,
      },
      recipients: Array.from(recipientSet) as EntityId[],
      sector_id: ship.sector,
    })
    return { ok: true }
  }

  /**
   * Move a character (and their ship) to a new sector.
   *
   * Mirrors production's `move` edge function: a character participating in an
   * active combat cannot move. Arriving in a sector with an ongoing combat
   * does NOT add the character to that combat — they become a sector observer,
   * not a participant. A new combat could theoretically fire on arrival
   * (garrison auto-engage in production); that's deferred.
   */
  moveCharacter(charId: CharacterId, destinationSector: SectorId): ActionResult {
    const char = this.world.characters.get(charId)
    if (!char) return { ok: false, reason: "no such character" }
    if (this.isCharacterInActiveCombat(charId)) {
      return { ok: false, reason: "cannot move while in combat" }
    }
    if (char.currentSector === destinationSector) {
      return { ok: false, reason: "already in that sector" }
    }
    const fromSector = char.currentSector
    char.currentSector = destinationSector
    const ship = this.world.ships.get(char.currentShipId)
    if (ship) ship.sector = destinationSector

    this.emit({
      type: "character.moved",
      payload: {
        character_id: charId,
        ship_id: ship?.id,
        from_sector: fromSector,
        to_sector: destinationSector,
      },
      recipients: [charId],
      actor: charId,
      sector_id: destinationSector,
    })

    // Ported from `_shared/garrison_combat.ts:checkGarrisonAutoEngage`.
    // Arriving in a sector with a hostile offensive/toll garrison triggers
    // combat. No auto-engage if a combat is already active (the arrival is an
    // observer of the existing fight; matches production skipping the case).
    this.maybeAutoEngageOnArrival(charId, destinationSector)

    return { ok: true }
  }

  private maybeAutoEngageOnArrival(charId: CharacterId, sector: SectorId): void {
    // Staging mode suppresses auto-engage so the user can compose scenarios
    // (drop a character into a garrison sector, randomize layouts) without
    // combat firing mid-setup. `runScenario()` releases and retriggers.
    if (this.stagingMode) return
    const active = Array.from(this.world.activeCombats.values()).some(
      (c) => !c.ended && c.sector_id === sector,
    )
    if (active) return

    const autoEngaging = Array.from(this.world.garrisons.values()).filter(
      (g) => g.sector === sector && g.fighters > 0 && (g.mode === "offensive" || g.mode === "toll"),
    )
    if (autoEngaging.length === 0) return

    const arrivingChar = this.world.characters.get(charId)
    if (!arrivingChar) return
    const arrivingCorp = arrivingChar.corpId ?? null

    const hostile = autoEngaging.find((g) => {
      if (g.ownerCharacterId === charId) return false
      const owner = this.world.characters.get(g.ownerCharacterId)
      const ownerCorp = owner?.corpId ?? null
      if (arrivingCorp && ownerCorp === arrivingCorp) return false
      return true
    })
    if (!hostile) return

    const encounter = this.createSectorCombat(
      sector,
      `garrison:${hostile.sector}:${hostile.ownerCharacterId}`,
    )
    if (!encounter) return

    const recipients = this.combatRecipients(encounter)
    this.emit({
      type: "combat.round_waiting",
      payload: buildRoundWaitingPayload(encounter),
      recipients,
      actor: charId,
      combat_id: encounter.combat_id as CombatId,
      sector_id: sector,
    })
  }

  /** True iff the character is a participant in any non-ended combat. */
  isCharacterInActiveCombat(charId: CharacterId): boolean {
    for (const encounter of this.world.activeCombats.values()) {
      if (encounter.ended) continue
      if (charId in encounter.participants) return true
    }
    return false
  }

  deployGarrison(opts: DeployGarrisonOpts): GarrisonId {
    const owner = this.world.characters.get(opts.ownerCharacterId)
    if (!owner) throw new Error(`No such character: ${opts.ownerCharacterId}`)
    if (opts.fighters <= 0) throw new Error("Garrison must have > 0 fighters")

    // Production invariant (migration 20260218123000_enforce_single_garrison_per_sector):
    // UNIQUE (sector_id) — at most one garrison per sector, regardless of owner.
    // Production's combat_finalization removes 0-fighter garrisons after combat,
    // so in practice a "dead" garrison never blocks a new deployment. The harness
    // doesn't model finalization yet, so we auto-replace 0-fighter garrisons here
    // to match the same user-observable behavior.
    const existing = Array.from(this.world.garrisons.values()).find(
      (g) => g.sector === opts.sector,
    )
    if (existing) {
      if (existing.fighters > 0) {
        const ownerName =
          this.world.characters.get(existing.ownerCharacterId)?.name ?? existing.ownerCharacterId
        throw new Error(
          `Sector ${opts.sector} already has a garrison (owner: ${ownerName}, ${existing.fighters} fighters)`,
        )
      }
      // Replace the spent garrison.
      this.world.garrisons.delete(existing.id)
    }

    const gid = garrisonId(this.nextId("garrison"))
    const garrison: Garrison = {
      id: gid,
      ownerCharacterId: opts.ownerCharacterId,
      sector: opts.sector,
      fighters: opts.fighters,
      mode: opts.mode ?? "defensive",
      tollAmount: opts.tollAmount ?? 0,
    }
    this.world.garrisons.set(gid, garrison)

    this.emit({
      type: "garrison.deployed",
      payload: {
        garrison_id: gid,
        owner_character_id: opts.ownerCharacterId,
        owner_name: owner.name,
        sector: opts.sector,
        fighters: opts.fighters,
        mode: garrison.mode,
        toll_amount: garrison.tollAmount,
      },
      recipients: [opts.ownerCharacterId, gid],
      actor: opts.ownerCharacterId,
      sector_id: opts.sector,
    })

    // Auto-initiate combat on hostile deploy.
    // Production (`combat_leave_fighters/index.ts:358`) does this only for
    // offensive mode. The harness extends it to toll mode too so toll garrisons
    // are usable without relying on a move-auto-engage path (which we haven't
    // ported yet). Toll mode + auto-init plays cleanly: round 1 brace = demand.
    if (garrison.mode === "offensive" || garrison.mode === "toll") {
      this.maybeAutoInitiateFromGarrison(garrison)
    }

    return gid
  }

  private maybeAutoInitiateFromGarrison(garrison: Garrison): void {
    // Staging mode suppresses deploy-time combat kickoff — see `runScenario()`.
    if (this.stagingMode) return
    // Don't stomp an active combat.
    const active = Array.from(this.world.activeCombats.values()).some(
      (c) => !c.ended && c.sector_id === garrison.sector,
    )
    if (active) return

    const owner = this.world.characters.get(garrison.ownerCharacterId)
    const ownerCorp = owner?.corpId ?? null

    // Targetable ship-side opponents = any character or corp-ship combatant in
    // the sector that isn't this garrison's owner and isn't a corp-mate.
    const targetable = this.buildSectorCombatants(garrison.sector).some((p) => {
      if (p.combatant_type !== "character") return false
      if (p.is_escape_pod) return false
      if ((p.fighters ?? 0) <= 0) return false
      if (p.owner_character_id === garrison.ownerCharacterId) return false
      const meta = (p.metadata ?? {}) as Record<string, unknown>
      const corp = (meta.corporation_id ?? meta.owner_corporation_id) as
        | string
        | null
        | undefined
      if (ownerCorp && corp === ownerCorp) return false
      return true
    })
    if (!targetable) return

    const encounter = this.createSectorCombat(
      garrison.sector,
      `garrison:${garrison.sector}:${garrison.ownerCharacterId}`,
    )
    if (!encounter) return
    const recipients = this.combatRecipients(encounter)
    this.emit({
      type: "combat.round_waiting",
      payload: buildRoundWaitingPayload(encounter),
      recipients,
      actor: garrison.ownerCharacterId,
      combat_id: encounter.combat_id as CombatId,
      sector_id: garrison.sector,
    })
  }

  private createSectorCombat(
    sector: SectorId,
    initiatorLabel: string,
  ): CombatEncounterState | null {
    const participants: Record<string, CombatantState> = {}
    for (const c of this.buildSectorCombatants(sector)) {
      participants[c.combatant_id] = c
    }
    if (Object.keys(participants).length < 2) return null
    const cid = combatId(this.nextId("combat"))
    const encounter: CombatEncounterState = {
      combat_id: cid,
      sector_id: sector,
      round: 1,
      deadline: this.computeDeadline(),
      participants,
      pending_actions: {},
      ui_last_actions: {},
      logs: [],
      context: { initiator: initiatorLabel },
      awaiting_resolution: false,
      ended: false,
      end_state: null,
      base_seed: Math.floor(this.rng() * 2 ** 31),
      last_updated: this.now(),
    }
    this.world.activeCombats.set(cid, encounter)

    // DELIBERATE HARNESS IMPROVEMENT OVER PRODUCTION: seed the toll_registry
    // at combat-creation time for any toll garrison present. Production only
    // populates this lazily in buildGarrisonActions during the first round
    // resolution, which means `pay` in round 1 fails with "no toll garrison
    // in this combat" — a production UX quirk. Pre-seeding here lets the
    // `pay` action work from round 1 forward. Keep this in mind if porting
    // back: production would need the same fix or the quirk remains.
    const tollGarrisons = Object.values(participants).filter((p) => {
      if (p.combatant_type !== "garrison") return false
      const meta = (p.metadata ?? {}) as Record<string, unknown>
      return meta.mode === "toll"
    })
    if (tollGarrisons.length > 0) {
      const registry = ensureTollRegistry(encounter)
      for (const g of tollGarrisons) {
        const meta = (g.metadata ?? {}) as Record<string, unknown>
        if (!registry[g.combatant_id]) {
          registry[g.combatant_id] = {
            owner_id: g.owner_character_id,
            toll_amount: typeof meta.toll_amount === "number" ? meta.toll_amount : 0,
            toll_balance: 0,
            demand_round: 1,
          }
        }
      }
    }
    return encounter
  }

  // ---- Combat ----

  /**
   * Join-or-create combat in the given sector.
   *
   * Matches production semantics (`combat_initiate/index.ts:309`): at most one
   * combat per sector. If a non-ended combat already exists in `sector`, the
   * initiator is *added* to it — the existing combatants stay in place. Other
   * sector observers remain observers. Otherwise a fresh encounter is created
   * from every eligible participant in the sector.
   *
   * Guards: initiator must be in the sector with fighters > 0; there must be
   * at least one targetable (non-friendly, non-pod, fighters > 0) opponent.
   */
  initiateCombat(actorId: CharacterId, sector: SectorId): CombatId {
    const actor = this.world.characters.get(actorId)
    if (!actor) throw new Error(`No such character: ${actorId}`)
    if (actor.currentSector !== sector) {
      throw new Error(`Character ${actor.name} is in sector ${actor.currentSector}, not ${sector}`)
    }
    const actorShip = this.world.ships.get(actor.currentShipId)
    if (!actorShip) throw new Error(`Character ${actor.name} has no ship`)
    if (actorShip.fighters <= 0) {
      throw new Error("Cannot initiate combat while you have no fighters")
    }

    const existing = Array.from(this.world.activeCombats.values()).find(
      (c) => !c.ended && c.sector_id === sector,
    )

    const initiatorCombatant = this.buildCharacterCombatant(actor, actorShip)
    const initiatorCorpId = actor.corpId ?? null

    // Collect candidate opponents. If joining, opponents are the existing
    // combat's participants; if creating, they're every eligible participant
    // in the sector.
    const opponents: CombatantState[] = existing
      ? Object.values(existing.participants)
      : this.buildSectorCombatants(sector).filter(
          (p) => p.combatant_id !== actorId,
        )

    const hasTargetable = opponents.some((p) => {
      if (p.combatant_id === actorId) return false
      if (p.is_escape_pod) return false
      if ((p.fighters ?? 0) <= 0) return false
      const meta = (p.metadata ?? {}) as Record<string, unknown>
      const corp =
        (meta.corporation_id as string | null | undefined) ??
        (meta.owner_corporation_id as string | null | undefined) ??
        null
      if (initiatorCorpId && corp === initiatorCorpId) return false
      if (p.combatant_type === "garrison" && p.owner_character_id === actorId) return false
      return true
    })

    if (!hasTargetable) {
      throw new Error("No targetable opponents available to engage")
    }

    let encounter: CombatEncounterState
    if (existing) {
      encounter = existing
      if (!(actorId in encounter.participants)) {
        encounter.participants[actorId] = initiatorCombatant
      }
      encounter.last_updated = this.now()
    } else {
      const created = this.createSectorCombat(sector, actorId)
      if (!created) {
        throw new Error(`Need at least 2 combat participants in sector ${sector}`)
      }
      encounter = created
    }

    const recipients = this.combatRecipients(encounter)
    this.emit({
      type: "combat.round_waiting",
      payload: buildRoundWaitingPayload(encounter),
      recipients,
      actor: actorId,
      combat_id: encounter.combat_id as CombatId,
      sector_id: sector,
    })
    return encounter.combat_id as CombatId
  }

  // ---- Combatant builders ----

  private buildCharacterCombatant(char: Character, ship: Ship): CombatantState {
    return {
      combatant_id: char.id,
      combatant_type: "character",
      name: char.name,
      fighters: ship.fighters,
      shields: ship.shields,
      turns_per_warp: ship.turnsPerWarp,
      max_fighters: ship.fighters,
      max_shields: ship.maxShields,
      is_escape_pod: false,
      owner_character_id: char.id,
      ship_type: ship.type,
      metadata: {
        ship_id: ship.id,
        ship_name: ship.name ?? char.name,
        player_type: "human",
        corporation_id: char.corpId ?? null,
      },
    }
  }

  private buildCorpShipCombatant(ship: Ship): CombatantState {
    const ownerCorp = ship.ownerCorpId ? this.world.corporations.get(ship.ownerCorpId) : undefined
    return {
      combatant_id: ship.id,
      combatant_type: "character",
      name: ship.name ?? ship.id,
      fighters: ship.fighters,
      shields: ship.shields,
      turns_per_warp: ship.turnsPerWarp,
      max_fighters: ship.fighters,
      max_shields: ship.maxShields,
      is_escape_pod: false,
      owner_character_id: ship.id,
      ship_type: ship.type,
      metadata: {
        ship_id: ship.id,
        ship_name: ship.name ?? ship.id,
        player_type: "corporation_ship",
        corporation_id: ship.ownerCorpId ?? null,
        corp_name: ownerCorp?.name ?? null,
      },
    }
  }

  private buildGarrisonCombatant(g: Garrison): CombatantState {
    const owner = this.world.characters.get(g.ownerCharacterId)
    const ownerName = owner?.name ?? g.ownerCharacterId
    return {
      combatant_id: `garrison:${g.sector}:${g.ownerCharacterId}`,
      combatant_type: "garrison",
      name: `${ownerName} Garrison`,
      fighters: g.fighters,
      shields: 0,
      turns_per_warp: 0,
      max_fighters: g.fighters,
      max_shields: 0,
      is_escape_pod: false,
      owner_character_id: g.ownerCharacterId,
      ship_type: null,
      metadata: {
        garrison_id: g.id,
        mode: g.mode,
        toll_amount: g.tollAmount,
        toll_balance: 0,
        deployed_at: new Date(this.now()).toISOString(),
        sector_id: g.sector,
        owner_name: ownerName,
        owner_corporation_id: owner?.corpId ?? null,
      },
    }
  }

  private buildSectorCombatants(sector: SectorId): CombatantState[] {
    const out: CombatantState[] = []
    for (const c of this.world.characters.values()) {
      if (c.currentSector !== sector) continue
      const ship = this.world.ships.get(c.currentShipId)
      if (!ship) continue
      out.push(this.buildCharacterCombatant(c, ship))
    }
    for (const s of this.world.ships.values()) {
      if (!s.ownerCorpId) continue
      if (s.sector !== sector) continue
      if (s.fighters <= 0) continue
      out.push(this.buildCorpShipCombatant(s))
    }
    for (const g of this.world.garrisons.values()) {
      if (g.sector !== sector) continue
      if (g.fighters <= 0) continue
      out.push(this.buildGarrisonCombatant(g))
    }
    return out
  }

  submitAction(actorId: CharacterId, cid: CombatId, input: SubmitAction): ActionResult {
    const encounter = this.world.activeCombats.get(cid)
    if (!encounter) return { ok: false, reason: "no such combat" }
    if (encounter.ended) return { ok: false, reason: "combat already ended" }
    if (!(actorId in encounter.participants)) return { ok: false, reason: "not a participant" }

    const participant = encounter.participants[actorId]
    if (participant.fighters <= 0) return { ok: false, reason: "no fighters remaining" }

    const target_id = "target_id" in input ? (input.target_id ?? null) : null
    const commit = "commit" in input ? input.commit : 0
    const destination_sector =
      "destination_sector" in input ? (input.destination_sector ?? null) : null

    if (input.action === "attack") {
      if (!target_id) return { ok: false, reason: "attack requires a target" }
      if (target_id === actorId) return { ok: false, reason: "cannot target self" }
      if (!(target_id in encounter.participants))
        return { ok: false, reason: "target is not in this combat" }
      // Reject attacks on destroyed participants. resolveRound already
      // no-ops damage against 0-fighter targets, but silently accepting
      // the action lets an LLM spend the whole fight attacking a corpse
      // (observed: 20 rounds of sustained fire into a dead ship with no
      // state change). Surface the rejection so the agent picks a real
      // target.
      const target = encounter.participants[target_id]
      if ((target?.fighters ?? 0) <= 0)
        return { ok: false, reason: "target has been destroyed — pick another" }
      if (commit <= 0) return { ok: false, reason: "attack commit must be > 0" }
      // Per-payer toll semantics: paying a toll is a peace contract with
      // that garrison. Attacking afterwards is incoherent — the payer
      // already bought passage. Reject so the LLM picks brace/flee/attack
      // of a non-paid hostile instead.
      const registry = (encounter.context as Record<string, unknown> | undefined)
        ?.toll_registry as Record<string, TollRegistryEntry> | undefined
      const tollEntry = registry?.[target_id]
      if (tollEntry?.payments?.some((p) => p.payer === actorId)) {
        return {
          ok: false,
          reason: `already paid toll to ${target_id}; cannot attack a garrison you are at peace with`,
        }
      }
    }

    if (input.action === "pay") {
      // Deduct credits + mark toll registry entry paid. Mutates
      // encounter.context.toll_registry so garrison.ts sees it next round.
      const result = this.processTollPayment(encounter, actorId, target_id)
      if (!result.ok) return result
    }

    const action: RoundActionState = {
      action: input.action,
      commit,
      timed_out: false,
      submitted_at: new Date(this.now()).toISOString(),
      target_id,
      destination_sector,
    }
    encounter.pending_actions[actorId] = action
    // Clear any round-N-1 display remnant for this participant so the badge
    // flips cleanly from "resolved: X" (previous round) to "submitted: Y".
    delete encounter.ui_last_actions[actorId]
    encounter.last_updated = this.now()

    this.emit({
      type: "combat.action_accepted",
      payload: {
        combat_id: cid,
        sector: { id: encounter.sector_id },
        round: encounter.round,
        actor_id: actorId,
        action: {
          action: action.action,
          commit: action.commit,
          target_id: action.target_id,
          destination_sector: action.destination_sector,
        },
      },
      recipients: [actorId],
      actor: actorId,
      combat_id: cid,
      sector_id: encounter.sector_id,
    })

    // If every living character-participant has submitted, resolve immediately.
    const activeIds = Object.entries(encounter.participants)
      .filter(([, p]) => p.combatant_type === "character" && p.fighters > 0)
      .map(([id]) => id)
    const submitted = new Set(Object.keys(encounter.pending_actions))
    if (activeIds.every((id) => submitted.has(id))) {
      this.resolveEncounterRound(encounter)
    }
    return { ok: true }
  }

  tick(nowMs: number): void {
    for (const encounter of this.world.activeCombats.values()) {
      if (encounter.ended) continue
      if (encounter.deadline != null && nowMs >= encounter.deadline) {
        this.resolveEncounterRound(encounter)
      }
    }
  }

  /**
   * Harness-only debug escape hatch. Immediately terminates an in-flight
   * combat encounter without running round resolution — no further damage
   * is applied, no toll credits move, no flee rolls. Emits a final
   * `combat.round_resolved` (with current state as fighters/shields remaining)
   * followed by a personalized `combat.ended` per character recipient, so
   * the summary card + summary-modal digest see a terminated encounter.
   *
   * Use when an agent hangs, a timer's off, or some other harness-only
   * state prevents natural resolution and you just want to close the log.
   * Does NOT exist in production.
   */
  forceEndCombat(cid: CombatId, endLabel = "aborted"): ActionResult {
    const encounter = this.world.activeCombats.get(cid)
    if (!encounter) return { ok: false, reason: "no such combat" }
    if (encounter.ended) return { ok: false, reason: "combat already ended" }

    const fightersRemaining: Record<string, number> = {}
    const shieldsRemaining: Record<string, number> = {}
    for (const [pid, p] of Object.entries(encounter.participants)) {
      fightersRemaining[pid] = p.fighters
      shieldsRemaining[pid] = p.shields
    }

    const outcome: CombatRoundOutcome = {
      round_number: encounter.round,
      hits: {},
      offensive_losses: {},
      defensive_losses: {},
      shield_loss: {},
      damage_mitigated: {},
      fighters_remaining: fightersRemaining,
      shields_remaining: shieldsRemaining,
      flee_results: {},
      end_state: endLabel,
      effective_actions: { ...encounter.pending_actions },
    }

    encounter.ended = true
    encounter.end_state = endLabel
    encounter.deadline = null
    // Mirror normal-resolution bookkeeping so the summary card has something
    // meaningful under "actions this round" (whoever had submitted) and the
    // ui_last_actions buffer reflects the final frame.
    encounter.ui_last_actions = { ...encounter.pending_actions }
    encounter.pending_actions = {}
    encounter.awaiting_resolution = false

    encounter.logs.push({
      round_number: encounter.round,
      actions: outcome.effective_actions,
      hits: outcome.hits,
      offensive_losses: outcome.offensive_losses,
      defensive_losses: outcome.defensive_losses,
      shield_loss: outcome.shield_loss,
      damage_mitigated: outcome.damage_mitigated,
      result: endLabel,
      timestamp: new Date(this.now()).toISOString(),
    })

    const recipients = this.combatRecipients(encounter)

    this.emit({
      type: "combat.round_resolved",
      payload: buildRoundResolvedPayload(encounter, outcome, outcome.effective_actions),
      recipients,
      combat_id: encounter.combat_id as CombatId,
      sector_id: encounter.sector_id,
    })

    const characterRecipients = collectParticipantIds(encounter) as EntityId[]
    for (const recipient of characterRecipients) {
      const endedPayload = this.buildCombatEndedPayloadForViewer(
        encounter,
        outcome,
        recipient,
      )
      this.emit({
        type: "combat.ended",
        payload: endedPayload,
        recipients: [recipient],
        combat_id: encounter.combat_id as CombatId,
        sector_id: encounter.sector_id,
      })
    }

    encounter.last_updated = this.now()
    return { ok: true }
  }

  // ---- Observation ----

  getWorldSnapshot(): World {
    return this.snapshot
  }

  // ---- Internal ----

  private resolveEncounterRound(encounter: CombatEncounterState): void {
    const timeoutActions: Record<string, RoundActionState> = {}
    for (const [pid, participant] of Object.entries(encounter.participants)) {
      if (participant.combatant_type === "garrison") continue
      if (encounter.pending_actions[pid]) continue
      if ((participant.fighters ?? 0) <= 0) continue
      timeoutActions[pid] = {
        action: "brace",
        commit: 0,
        timed_out: true,
        target_id: null,
        destination_sector: null,
        submitted_at: new Date(this.now()).toISOString(),
      }
    }

    const garrisonActions = buildGarrisonActions(encounter, this.now)

    const combinedActions: Record<string, RoundActionState> = {
      ...encounter.pending_actions,
      ...timeoutActions,
      ...garrisonActions,
    }

    const outcome = resolveRound(encounter, combinedActions)

    // Port of combat_resolution.ts stalemate/toll unstuck: if the engine returns
    // "stalemate" but any toll garrison still has an unpaid hostile, the
    // garrison will escalate next round — don't end combat on a toll-demand
    // brace/brace round. Per-payer semantics: "unpaid" means at least one
    // non-friendly hostile lacks a payment record on this garrison's entry.
    if (outcome.end_state === "stalemate") {
      const registry = (encounter.context as Record<string, unknown> | undefined)
        ?.toll_registry as Record<string, TollRegistryEntry> | undefined
      if (registry) {
        const corps = buildCorporationMap(encounter)
        if (anyOutstandingToll(encounter, registry, corps)) {
          outcome.end_state = null
        }
      }
    }

    // Port of combat_resolution.ts checkTollStanddown: if toll was paid this
    // round AND the garrison braced AND every other submitter braced or paid,
    // combat ends cleanly with `toll_satisfied`. Runs UNCONDITIONALLY so it
    // can promote a stalemate end_state into toll_satisfied — matches
    // production's ordering (combat_resolution.ts:91).
    if (this.checkTollStanddown(encounter, outcome.round_number, combinedActions)) {
      outcome.end_state = "toll_satisfied"
    }

    encounter.logs.push({
      round_number: outcome.round_number,
      actions: combinedActions,
      hits: outcome.hits,
      offensive_losses: outcome.offensive_losses,
      defensive_losses: outcome.defensive_losses,
      shield_loss: outcome.shield_loss,
      damage_mitigated: outcome.damage_mitigated,
      result: outcome.end_state ?? null,
      timestamp: new Date(this.now()).toISOString(),
    })

    for (const [pid, participant] of Object.entries(encounter.participants)) {
      participant.fighters = outcome.fighters_remaining[pid] ?? participant.fighters
      participant.shields = outcome.shields_remaining[pid] ?? participant.shields
    }
    // Mirror the round's actions into the UI-only buffer BEFORE clearing
    // pending_actions. This lets the ParticipantDock show "resolved: X" for
    // the final submitter of the round — whose `pending_actions[id]` would
    // otherwise be wiped in the same sync tick the tool call lands in (React
    // batches the emits and only paints the post-clear state).
    encounter.ui_last_actions = { ...combinedActions }
    encounter.pending_actions = {}
    encounter.awaiting_resolution = false

    const recipients = this.combatRecipients(encounter)

    this.emit({
      type: "combat.round_resolved",
      payload: buildRoundResolvedPayload(encounter, outcome, combinedActions),
      recipients,
      combat_id: encounter.combat_id as CombatId,
      sector_id: encounter.sector_id,
    })

    if (outcome.end_state) {
      encounter.ended = true
      encounter.end_state = outcome.end_state
      encounter.deadline = null

      // Apply post-combat state back to world. Handles three cases:
      // 1. Character participants (pid = character_id) → their ship via currentShipId
      // 2. Corp-ship pseudo-characters (pid = ship_id)  → ship directly
      // 3. Garrisons → sync fighters back to world.garrisons
      for (const [pid, participant] of Object.entries(encounter.participants)) {
        if (participant.combatant_type === "garrison") {
          const metadata = (participant.metadata ?? {}) as Record<string, unknown>
          const gidFromMeta = metadata.garrison_id
          if (typeof gidFromMeta === "string") {
            const g = this.world.garrisons.get(gidFromMeta as GarrisonId)
            if (g) g.fighters = participant.fighters
          }
          continue
        }
        const char = this.world.characters.get(pid as CharacterId)
        if (char) {
          const ship = this.world.ships.get(char.currentShipId)
          if (ship) {
            ship.fighters = participant.fighters
            ship.shields = participant.shields
          }
          continue
        }
        const directShip = this.world.ships.get(pid as ShipId)
        if (directShip) {
          directShip.fighters = participant.fighters
          directShip.shields = participant.shields
        }
      }

      // Emit ship.destroyed + salvage.created for each defeated ship, clean up
      // spent garrisons, convert defeated human ships to escape pods. Ported
      // from `_shared/combat_finalization.ts:finalizeCombat`.
      this.finalizeCombat(encounter, recipients)

      // Move successful fleers to their destination sector. Production does
      // this in combat_resolution.ts `moveSuccessfulFleers` after finalize
      // and before combat.ended. The harness has no adjacency model, so if
      // the action didn't specify a destination we fall back to sector - 1.
      this.moveSuccessfulFleers(encounter, outcome, combinedActions)

      // combat.ended goes ONLY to character recipients (production restricts
      // to collectParticipantIds — garrisons are NPCs and don't receive it).
      // Each recipient gets a payload personalized with THEIR own ship block.
      const characterRecipients = collectParticipantIds(encounter) as EntityId[]
      for (const recipient of characterRecipients) {
        const endedPayload = this.buildCombatEndedPayloadForViewer(
          encounter,
          outcome,
          recipient,
        )
        this.emit({
          type: "combat.ended",
          payload: endedPayload,
          recipients: [recipient],
          combat_id: encounter.combat_id as CombatId,
          sector_id: encounter.sector_id,
        })
      }
    } else {
      encounter.round = outcome.round_number + 1
      encounter.deadline = this.computeDeadline()

      for (const participant of Object.values(encounter.participants)) {
        if (participant.fighters > 0 && !participant.is_escape_pod) {
          participant.shields = Math.min(
            participant.shields + SHIELD_REGEN_PER_ROUND,
            participant.max_shields,
          )
        }
      }

      this.emit({
        type: "combat.round_waiting",
        payload: buildRoundWaitingPayload(encounter),
        recipients,
        combat_id: encounter.combat_id as CombatId,
        sector_id: encounter.sector_id,
      })
    }

    encounter.last_updated = this.now()
  }

  /**
   * Ported from `combat_action/index.ts:processTollPayment`. Finds the toll
   * garrison the payer is paying, validates credits, deducts, and marks the
   * toll_registry entry as paid. Harness simplification: deducts from
   * `character.credits` rather than ship credits (harness doesn't model ship
   * credits yet).
   */
  private processTollPayment(
    encounter: CombatEncounterState,
    payerId: CharacterId,
    targetId: string | null,
  ): ActionResult {
    const registry = ensureTollRegistry(encounter)

    // If the caller named a target that exists in the combat but ISN'T a
    // toll-mode garrison, reject explicitly — don't silently redirect the
    // payment to whatever toll garrison happens to be first in the registry.
    // The old fallback (`garrisonIds[0]`) meant paying "target=Alice" would
    // silently pay the unrelated toll garrison next door, which is a
    // double-confusing failure for an LLM to reason about. Clean rejection
    // here lets the agent re-decide toward `brace` / `attack` / `flee`.
    // Run this check BEFORE the empty-registry guard so the "this target
    // is not in toll mode" message wins when both would apply.
    if (targetId && targetId in encounter.participants && !(targetId in registry)) {
      const target = encounter.participants[targetId]
      const mode =
        (target.metadata as Record<string, unknown> | undefined)?.mode ?? "?"
      return {
        ok: false,
        reason: `target ${targetId} is not in toll mode (mode=${mode}); pay only works against toll garrisons`,
      }
    }

    const garrisonIds = Object.keys(registry)
    if (garrisonIds.length === 0) {
      return { ok: false, reason: "no toll garrison in this combat" }
    }

    const garrisonKey =
      targetId && targetId in registry ? targetId : garrisonIds[0]
    const entry: TollRegistryEntry | undefined = registry[garrisonKey]
    if (!entry) return { ok: false, reason: "toll entry missing" }

    // Per-payer semantics: a payer who has already paid this garrison is
    // at peace with it. Re-paying is incoherent and would charge credits
    // for a contract already in force. Reject so the LLM picks a real
    // action (brace / flee / attack a non-paid hostile).
    if (entry.payments?.some((p) => p.payer === payerId)) {
      return {
        ok: false,
        reason: `already paid toll to ${garrisonKey}; you are at peace with this garrison — choose brace, flee, or attack a non-paid hostile instead`,
      }
    }

    const amount = typeof entry.toll_amount === "number" ? entry.toll_amount : 0

    if (amount > 0) {
      // Find the payer's ship: character participants own a ship via
      // currentShipId; corp-ship pseudos pay from their own ship record.
      const payerChar = this.world.characters.get(payerId)
      const payerShip = payerChar
        ? this.world.ships.get(payerChar.currentShipId)
        : this.world.ships.get(payerId as unknown as ShipId)
      if (!payerShip) return { ok: false, reason: "payer ship not found" }
      if (payerShip.credits < amount) {
        return {
          ok: false,
          reason: `insufficient credits (need ${amount}, have ${payerShip.credits})`,
        }
      }
      payerShip.credits -= amount
    }

    entry.paid = true
    entry.paid_round = encounter.round
    entry.toll_balance = (entry.toll_balance ?? 0) + amount
    entry.payments = entry.payments ?? []
    entry.payments.push({ payer: payerId, amount, round: encounter.round })

    return { ok: true }
  }

  /**
   * Ported from `_shared/combat_finalization.ts`. For every participant with
   * fighters == 0 at combat end:
   *   - Character / corp-ship pseudo → emit `salvage.created` (sector-scope)
   *     and `ship.destroyed` (sector + corp-scope). Corp ships are removed
   *     from world.ships; human character ships are converted to `escape_pod`
   *     to mirror production's `convertShipToEscapePod`.
   *   - Garrison → deleted from world.garrisons to match production's
   *     `updateGarrisonState` row-delete at 0 fighters.
   */
  private finalizeCombat(encounter: CombatEncounterState, recipients: EntityId[]): void {
    for (const [pid, participant] of Object.entries(encounter.participants)) {
      if ((participant.fighters ?? 0) > 0) continue

      if (participant.combatant_type === "garrison") {
        const metadata = (participant.metadata ?? {}) as Record<string, unknown>
        const internalGid =
          typeof metadata.garrison_id === "string" ? metadata.garrison_id : null
        const ownerCharId = participant.owner_character_id ?? null
        const ownerCorpId =
          typeof metadata.owner_corporation_id === "string"
            ? metadata.owner_corporation_id
            : null
        const modeStr =
          typeof metadata.mode === "string" ? metadata.mode : "offensive"
        const ownerName =
          typeof metadata.owner_name === "string"
            ? metadata.owner_name
            : (ownerCharId ?? participant.name)

        // Production gap: when a garrison is destroyed in combat, production
        // currently deletes the row silently. The harness emits a dedicated
        // event so the absent owner's agent has a loud, unambiguous signal —
        // this is the one that *should* trigger LLM inference (voice
        // notification) in the production wiring; spec'd in
        // `docs/combat-debug-harness-spec.md` under the Event-flow section.
        //
        // Recipients: owner + owner's corp members + sector observers. The
        // attacker and everyone else in the sector already saw it via
        // combat.round_resolved, but a semantic event makes UI + agent code
        // simpler than post-hoc inferring "did that garrison die?".
        const destRecipients = new Set<string>()
        if (ownerCharId) destRecipients.add(ownerCharId)
        if (ownerCorpId) {
          const corp = this.world.corporations.get(ownerCorpId as CorpId)
          if (corp) for (const m of corp.memberCharacterIds) destRecipients.add(m)
        }
        for (const c of this.world.characters.values()) {
          if (c.currentSector === encounter.sector_id) destRecipients.add(c.id)
        }

        // Expose the COMBATANT id (stable `garrison:<sector>:<owner>` form)
        // as `garrison_id` on the payload + XML envelope — that matches the
        // combatant_id used in combat-event payloads and is the key clients
        // already key off of. Keep the internal map id under a separate
        // field for callers that want to map back to the world's garrison
        // row.
        this.emit({
          type: "garrison.destroyed",
          payload: {
            garrison_id: participant.combatant_id,
            internal_garrison_id: internalGid,
            combatant_id: participant.combatant_id,
            owner_character_id: ownerCharId,
            owner_corp_id: ownerCorpId,
            owner_name: ownerName,
            sector: { id: encounter.sector_id },
            mode: modeStr,
            combat_id: encounter.combat_id,
          },
          recipients: Array.from(destRecipients) as EntityId[],
          combat_id: encounter.combat_id as CombatId,
          sector_id: encounter.sector_id,
        })

        if (internalGid) {
          this.world.garrisons.delete(internalGid as GarrisonId)
        }
        continue
      }

      const metadata = (participant.metadata ?? {}) as Record<string, unknown>
      const destroyedShipId = typeof metadata.ship_id === "string" ? metadata.ship_id : pid
      const shipType = participant.ship_type ?? "unknown"
      const shipName =
        (typeof metadata.ship_name === "string" ? metadata.ship_name : undefined) ??
        participant.name
      const playerType =
        metadata.player_type === "corporation_ship" ? "corporation_ship" : "human"
      const timestamp = new Date(this.now()).toISOString()
      const salvageIdValue = this.nextId("salvage")

      // Pull cargo/credits off the destroyed ship so salvage contents reflect
      // what the ship was carrying (matches production's
      // `buildSalvageEntry` logic in combat_finalization.ts).
      const destroyedShip = this.world.ships.get(destroyedShipId as ShipId)
      const cargoLoot = destroyedShip?.cargo ?? 0
      const creditsLoot = destroyedShip?.credits ?? 0

      this.emit({
        type: "salvage.created",
        payload: {
          timestamp,
          salvage_id: salvageIdValue,
          sector: { id: encounter.sector_id },
          cargo: cargoLoot > 0 ? { cargo: cargoLoot } : {},
          scrap: {},
          credits: creditsLoot,
          from_ship_type: shipType,
          from_ship_name: shipName,
          combat_id: encounter.combat_id,
        },
        recipients,
        combat_id: encounter.combat_id as CombatId,
        sector_id: encounter.sector_id,
      })

      // Harness enhancement: surface owner_character_id + corp_id alongside
      // the production-shaped fields so the agent's XML filter can frame the
      // event as "your ship" / "your corp's ship" / other. Production keeps
      // these private (used only for recipient computation).
      const ownerCharacterId =
        typeof participant.owner_character_id === "string"
          ? participant.owner_character_id
          : null
      const ownerCorpId =
        typeof metadata.corporation_id === "string"
          ? metadata.corporation_id
          : null
      this.emit({
        type: "ship.destroyed",
        payload: {
          timestamp,
          ship_id: destroyedShipId,
          ship_type: shipType,
          ship_name: shipName,
          player_type: playerType,
          player_name: participant.name,
          sector: { id: encounter.sector_id },
          combat_id: encounter.combat_id,
          salvage_created: true,
          owner_character_id: ownerCharacterId,
          corp_id: ownerCorpId,
        },
        recipients,
        combat_id: encounter.combat_id as CombatId,
        sector_id: encounter.sector_id,
      })

      if (playerType === "corporation_ship") {
        // Corp ship: production soft-deletes via `destroyed_at` + cleans up the
        // pseudo-character. Harness drops the row since it doesn't model
        // pseudos separately from ships.
        this.world.ships.delete(destroyedShipId as ShipId)
      } else if (destroyedShip) {
        // Human character ship: convert to escape_pod in place.
        // Mirrors combat_finalization.ts `convertShipToEscapePod`.
        destroyedShip.type = "escape_pod"
        destroyedShip.name = "Escape Pod"
        destroyedShip.fighters = 0
        destroyedShip.shields = 0
        destroyedShip.maxShields = 0
        destroyedShip.cargo = 0
        destroyedShip.credits = 0
      }
    }
  }

  /**
   * Ported from `combat_resolution.ts:moveSuccessfulFleers`. At combat end,
   * every participant with `flee_results[pid] === true` relocates to their
   * declared `destination_sector`. Harness fallback when unset: sector - 1
   * (production uses a random adjacent sector; harness has no adjacency).
   */
  private moveSuccessfulFleers(
    encounter: CombatEncounterState,
    outcome: CombatRoundOutcome,
    actions: Record<string, RoundActionState>,
  ): void {
    for (const [pid, succeeded] of Object.entries(outcome.flee_results)) {
      if (!succeeded) continue
      const participant = encounter.participants[pid]
      if (!participant || participant.combatant_type !== "character") continue

      const destination =
        actions[pid]?.destination_sector ?? Math.max(1, encounter.sector_id - 1)
      const metadata = (participant.metadata ?? {}) as Record<string, unknown>
      if (metadata.player_type === "corporation_ship") {
        const ship = this.world.ships.get(pid as ShipId)
        if (ship) ship.sector = destination
      } else {
        const char = this.world.characters.get(pid as CharacterId)
        if (!char) continue
        char.currentSector = destination
        const ship = this.world.ships.get(char.currentShipId)
        if (ship) ship.sector = destination
      }
      // Mark the combatant as fled so the UI can distinguish fled vs
      // still-active vs destroyed. Participant record stays in place for
      // event replay; only the visual + action-lock state changes.
      participant.has_fled = true
      participant.fled_to_sector = destination
    }
  }

  /**
   * Ported from combat_events.ts `buildCombatEndedPayloadForViewer`. Builds
   * the per-recipient combat.ended payload with the viewer's own ship block
   * injected. Production's block includes cargo/warp_power/max_fighters — the
   * harness fills what it models and passes through the rest.
   */
  private buildCombatEndedPayloadForViewer(
    encounter: CombatEncounterState,
    outcome: CombatRoundOutcome,
    viewerId: EntityId,
  ): Record<string, unknown> {
    const payload = buildCombatEndedPayload(encounter, outcome, encounter.logs)
    const viewerChar = this.world.characters.get(viewerId as CharacterId)
    const viewerShip = viewerChar
      ? this.world.ships.get(viewerChar.currentShipId)
      : this.world.ships.get(viewerId as unknown as ShipId)
    if (viewerShip) {
      payload.ship = {
        ship_id: viewerShip.id,
        ship_type: viewerShip.type,
        ship_name: viewerShip.name ?? viewerShip.id,
        credits: viewerShip.credits,
        cargo: viewerShip.cargo,
        cargo_capacity: 0,
        empty_holds: 0,
        warp_power: 0,
        shields: viewerShip.shields,
        fighters: viewerShip.fighters,
        max_shields: viewerShip.maxShields,
        max_fighters: viewerShip.fighters,
      }
    }
    return payload
  }

  /**
   * Per-payer toll standdown: combat ends with `toll_satisfied` only when
   *   - a payment was recorded THIS round (the trigger — don't gratuitously
   *     end peaceful rounds before any toll activity);
   *   - no participant is attacking this round (an active PvP attack keeps
   *     combat alive even if the garrison is placated);
   *   - every toll garrison has a payment on record from EVERY non-friendly,
   *     non-destroyed character combatant. One player's payment does NOT
   *     absolve other players of their toll obligation.
   *
   * Diverges from the old per-garrison-flag behavior where one payer plus
   * everyone-else-bracing ended combat — a silent free-ride for non-payers.
   */
  private checkTollStanddown(
    encounter: CombatEncounterState,
    roundNumber: number,
    actions: Record<string, RoundActionState>,
  ): boolean {
    const registry = (encounter.context as Record<string, unknown> | undefined)
      ?.toll_registry as Record<string, TollRegistryEntry> | undefined
    if (!registry) return false

    // Trigger: at least one garrison received a payment this round.
    let paidThisRound = false
    for (const entry of Object.values(registry)) {
      if (entry.paid_round === roundNumber) {
        paidThisRound = true
        break
      }
    }
    if (!paidThisRound) return false

    // Any active attack keeps combat alive.
    for (const a of Object.values(actions)) {
      if (a.action === "attack") return false
    }

    // Every toll garrison must have all its hostiles paid. If even one
    // garrison has an unpaid non-friendly hostile, combat continues so
    // that garrison can escalate next round.
    const corps = buildCorporationMap(encounter)
    for (const [garrisonKey, entry] of Object.entries(registry)) {
      const garrison = encounter.participants[garrisonKey]
      if (!garrison) continue

      // Garrison must not be attacking this round.
      const garrisonAction = actions[garrisonKey]
      if (
        garrisonAction &&
        garrisonAction.action !== "brace" &&
        garrisonAction.action !== "pay"
      ) {
        return false
      }

      if (!allHostilesPaid(encounter, garrison, entry, corps)) return false
    }
    return true
  }

  // Harness recipient scope for combat events, mirroring production's
  // `computeEventRecipients` (visibility.ts). Includes:
  //   1. Character participants (via collectParticipantIds — includes corp ship pseudos).
  //   2. Sector observers — every character or corp-ship pseudo physically in
  //      `encounter.sector_id`. Production does this via a query over
  //      `ship_instances.current_sector`; the harness iterates world state.
  //   3. Corp members of any corp-affiliated participant — corp-scope fan-out.
  //   4. Garrison combatant ids and their owners — HARNESS ONLY, so the POV
  //      filter works on garrisons. Production doesn't emit to garrison NPCs.
  //      Drop #4 when porting back.
  private combatRecipients(encounter: CombatEncounterState): EntityId[] {
    const recipients = new Set<string>(collectParticipantIds(encounter))

    // Sector observers (characters + corp-ship pseudos in the sector).
    for (const c of this.world.characters.values()) {
      if (c.currentSector === encounter.sector_id) recipients.add(c.id)
    }
    for (const s of this.world.ships.values()) {
      if (s.ownerCorpId && s.sector === encounter.sector_id && s.fighters > 0) {
        recipients.add(s.id)
      }
    }

    // Garrison filter-only recipients + their owners.
    for (const p of Object.values(encounter.participants)) {
      if (p.combatant_type === "garrison") {
        recipients.add(p.combatant_id)
        if (p.owner_character_id) recipients.add(p.owner_character_id)
      }
    }

    // Corp-scope fan-out.
    const corpsInvolved = new Set<string>()
    for (const p of Object.values(encounter.participants)) {
      const metadata = p.metadata as Record<string, unknown> | undefined
      const corp = metadata?.corporation_id as string | undefined
      const ownerCorp = metadata?.owner_corporation_id as string | undefined
      if (corp) corpsInvolved.add(corp)
      if (ownerCorp) corpsInvolved.add(ownerCorp)
    }
    for (const cid of corpsInvolved) {
      const corp = this.world.corporations.get(cid as CorpId)
      if (!corp) continue
      for (const memberId of corp.memberCharacterIds) recipients.add(memberId)
    }

    return Array.from(recipients) as EntityId[]
  }

  private nextId(prefix: string): string {
    return `${prefix}-${++this.idSeq}`
  }

  // Refresh the snapshot on every emit so React subscribers always see
  // state consistent with the event they were notified about. Also stamps
  // a `source` field on the payload to mirror production's
  // `buildEventSource(eventType, requestId)` convention.
  private emit(e: Omit<CombatEvent, "id" | "timestamp">): void {
    this.refreshSnapshot()
    const eventId = `ev-${++this.eventSeq}`
    if (e.payload && typeof e.payload === "object") {
      ;(e.payload as Record<string, unknown>).source = {
        name: e.type,
        request_id: `harness:${eventId}`,
      }
    }
    this.emitter.emit({
      ...e,
      id: eventId,
      timestamp: this.now(),
    })
  }

  private refreshSnapshot(): void {
    this.snapshot = {
      characters: new Map(this.world.characters),
      ships: new Map(this.world.ships),
      corporations: new Map(this.world.corporations),
      garrisons: new Map(this.world.garrisons),
      strategies: new Map(this.world.strategies),
      activeCombats: new Map(this.world.activeCombats),
    }
  }
}
