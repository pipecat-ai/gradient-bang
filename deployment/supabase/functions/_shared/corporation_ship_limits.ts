import type { PoolClient } from "https://deno.land/x/postgres@v0.17.0/mod.ts";

const DEFAULT_CORPORATION_SHIP_OWNER_CAP = 5;
const ENV_CORPORATION_SHIP_OWNER_CAP = "CORPORATION_SHIP_OWNER_CAP";

export interface CorporationShipOwnerLimitState {
  cap: number;
  count: number;
}

export function getCorporationShipOwnerCap(): number {
  const raw = (Deno.env.get(ENV_CORPORATION_SHIP_OWNER_CAP) ?? "").trim();
  if (!raw) {
    return DEFAULT_CORPORATION_SHIP_OWNER_CAP;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return DEFAULT_CORPORATION_SHIP_OWNER_CAP;
  }
  return parsed;
}

export async function lockCorporationShipOwnerLimit(
  pg: PoolClient,
  corpId: string,
  characterId: string,
): Promise<void> {
  await pg.queryObject(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`corp_ship_owner_limit:${corpId}:${characterId}`],
  );
}

export async function getCorporationShipOwnerLimitState(
  pg: PoolClient,
  corpId: string,
  characterId: string,
): Promise<CorporationShipOwnerLimitState> {
  const result = await pg.queryObject<{ count: bigint }>(
    `SELECT COUNT(*)::bigint AS count
       FROM corporation_ships cs
       JOIN ship_instances si ON si.ship_id = cs.ship_id
      WHERE cs.corp_id = $1
        AND cs.added_by = $2
        AND si.owner_type = 'corporation'
        AND si.owner_corporation_id = $1
        AND si.destroyed_at IS NULL
        AND si.byoa_owner_character_id IS NULL`,
    [corpId, characterId],
  );
  return {
    cap: getCorporationShipOwnerCap(),
    count: Number(result.rows[0]?.count ?? 0n),
  };
}

export function corporationShipOwnerLimitMessage(cap: number): string {
  return `corp_ship_owner_limit_exceeded: maximum ${cap} active corporation ships per character`;
}
