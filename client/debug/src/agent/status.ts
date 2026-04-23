import type {
  CharacterId,
  CorpId,
  ShipId,
  World,
} from "../engine/types"

// Shapes modeled after production `my_status` / `corporation_info` responses.
// Kept deliberately loose (Record<string, unknown>-ish) so the harness can
// emit them as JSON into the agent's context without a schema mismatch.

export interface StatusShip {
  ship_id: string
  ship_type: string
  ship_name: string | null
  current_fighters: number
  current_shields: number
  max_fighters: number
  max_shields: number
  credits: number
  cargo: number
  sector: number
  turns_per_warp: number
}

export interface StatusSnapshot {
  character_id: string
  name: string
  current_sector: number
  ship: StatusShip
  corporation: { corp_id: string; name: string } | null
}

export interface CorporationInfoSnapshot {
  corp_id: string
  name: string
  members: Array<{ character_id: string; name: string }>
  ships: Array<{ ship_id: string; ship_type: string; ship_name: string | null }>
}

/**
 * Build a status snapshot for a character as the agent would see it from
 * calling `my_status()` in production. Works for human characters; for a
 * corp-ship pseudo-character, pass the ship id cast as CharacterId — this
 * helper falls back to a ship-only snapshot if no matching character exists.
 */
export function buildStatusFromWorld(
  world: World,
  characterId: CharacterId,
): StatusSnapshot {
  const char = world.characters.get(characterId)
  if (char) {
    const ship = world.ships.get(char.currentShipId)
    if (!ship) throw new Error(`Character ${characterId} has no ship`)
    const corp = char.corpId ? world.corporations.get(char.corpId) : undefined
    return {
      character_id: char.id,
      name: char.name,
      current_sector: char.currentSector,
      ship: {
        ship_id: ship.id,
        ship_type: ship.type,
        ship_name: ship.name ?? null,
        current_fighters: ship.fighters,
        current_shields: ship.shields,
        max_fighters: ship.fighters,
        max_shields: ship.maxShields,
        credits: ship.credits,
        cargo: ship.cargo,
        sector: ship.sector,
        turns_per_warp: ship.turnsPerWarp,
      },
      corporation: corp ? { corp_id: corp.id, name: corp.name } : null,
    }
  }

  // Fallback: pseudo-character — treat the id as a ship id (corp ship pattern).
  const pseudoShip = world.ships.get(characterId as unknown as ShipId)
  if (!pseudoShip) {
    throw new Error(`No character or corp-ship pseudo with id ${characterId}`)
  }
  const corp = pseudoShip.ownerCorpId
    ? world.corporations.get(pseudoShip.ownerCorpId)
    : undefined
  return {
    character_id: characterId,
    name: pseudoShip.name ?? String(characterId),
    current_sector: pseudoShip.sector,
    ship: {
      ship_id: pseudoShip.id,
      ship_type: pseudoShip.type,
      ship_name: pseudoShip.name ?? null,
      current_fighters: pseudoShip.fighters,
      current_shields: pseudoShip.shields,
      max_fighters: pseudoShip.fighters,
      max_shields: pseudoShip.maxShields,
      credits: pseudoShip.credits,
      cargo: pseudoShip.cargo,
      sector: pseudoShip.sector,
      turns_per_warp: pseudoShip.turnsPerWarp,
    },
    corporation: corp ? { corp_id: corp.id, name: corp.name } : null,
  }
}

export function buildCorporationInfoFromWorld(
  world: World,
  corpId: CorpId,
): CorporationInfoSnapshot {
  const corp = world.corporations.get(corpId)
  if (!corp) throw new Error(`No such corporation: ${corpId}`)
  const members = corp.memberCharacterIds.map((cid) => {
    const c = world.characters.get(cid)
    return { character_id: cid as string, name: c?.name ?? (cid as string) }
  })
  const ships = Array.from(world.ships.values())
    .filter((s) => s.ownerCorpId === corpId)
    .map((s) => ({
      ship_id: s.id as string,
      ship_type: s.type,
      ship_name: s.name ?? null,
    }))
  return {
    corp_id: corp.id,
    name: corp.name,
    members,
    ships,
  }
}
