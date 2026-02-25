export interface PgQueryClient {
  queryObject<T>(
    query: string,
    args?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export interface TransactionGarrisonRow {
  owner_id: string;
  fighters: number;
  mode: string;
  toll_amount: number;
  toll_balance: number;
  deployed_at: string | null;
}

export interface LeaveFightersTransactionInput {
  sectorId: number;
  characterId: string;
  shipId: string;
  quantity: number;
  mode: string;
  tollAmount: number;
}

export interface LeaveFightersTransactionResult {
  newShipFighters: number;
  garrison: TransactionGarrisonRow;
}

export interface CollectFightersTransactionInput {
  sectorId: number;
  characterId: string;
  shipId: string;
  quantity: number;
}

export interface CollectFightersTransactionResult {
  newShipFighters: number;
  newShipCredits: number;
  tollPayout: number;
  garrisonOwnerId: string;
  updatedGarrison: TransactionGarrisonRow | null;
}

interface LockedShipLeaveRow {
  current_sector: number;
  current_fighters: number;
}

interface LockedShipCollectRow {
  current_fighters: number;
  credits: number;
  owner_corporation_id: string | null;
}

interface LockedGarrisonRow {
  owner_id: string;
  fighters: number;
  mode: string;
  toll_amount: number;
  toll_balance: number;
  deployed_at: string | null;
}

function buildStatusError(message: string, status: number): Error & {
  status: number;
} {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function normalizeGarrisonRow(row: LockedGarrisonRow): TransactionGarrisonRow {
  return {
    owner_id: row.owner_id,
    fighters: asNumber(row.fighters),
    mode: row.mode,
    toll_amount: asNumber(row.toll_amount),
    toll_balance: asNumber(row.toll_balance),
    deployed_at: row.deployed_at ?? null,
  };
}

async function rollbackQuietly(pg: PgQueryClient): Promise<void> {
  try {
    await pg.queryObject("ROLLBACK");
  } catch {
    // Ignore rollback failures.
  }
}

async function lockSectorGarrisons(
  pg: PgQueryClient,
  sectorId: number,
): Promise<LockedGarrisonRow[]> {
  const garrisonResult = await pg.queryObject<LockedGarrisonRow>(
    `SELECT
      owner_id,
      fighters::int AS fighters,
      mode,
      COALESCE(toll_amount, 0)::float8 AS toll_amount,
      COALESCE(toll_balance, 0)::float8 AS toll_balance,
      deployed_at
    FROM garrisons
    WHERE sector_id = $1
    ORDER BY updated_at DESC NULLS LAST, deployed_at DESC NULLS LAST, owner_id ASC
    FOR UPDATE`,
    [sectorId],
  );
  return garrisonResult.rows;
}

export async function runLeaveFightersTransaction(
  pg: PgQueryClient,
  input: LeaveFightersTransactionInput,
): Promise<LeaveFightersTransactionResult> {
  let inTransaction = false;

  try {
    await pg.queryObject("BEGIN");
    inTransaction = true;

    // Serialize deploy attempts per sector to prevent check/insert races.
    await pg.queryObject("SELECT pg_advisory_xact_lock($1::bigint)", [
      input.sectorId,
    ]);

    const garrisonRows = await lockSectorGarrisons(pg, input.sectorId);
    if (garrisonRows.length > 1) {
      console.warn("garrison_transaction.leave.multiple_garrisons", {
        sector_id: input.sectorId,
        owners: garrisonRows.map((row) => row.owner_id),
      });
      throw buildStatusError(
        "Sector has multiple garrisons; resolve data integrity before deploying fighters.",
        409,
      );
    }

    const existingGarrison = garrisonRows[0] ?? null;
    if (existingGarrison && existingGarrison.owner_id !== input.characterId) {
      // Check if the existing garrison belongs to a corp mate (including corp-owned ships).
      // Use COALESCE to check corporation_members first, then ship_instances for corp ships.
      const deployerCorpResult = await pg.queryObject<{ corp_id: string | null }>(
        `SELECT COALESCE(
          (SELECT corp_id FROM corporation_members WHERE character_id = $1 AND left_at IS NULL),
          (SELECT owner_corporation_id FROM ship_instances WHERE ship_id = $1)
        ) as corp_id`,
        [input.characterId],
      );
      const ownerCorpResult = await pg.queryObject<{ corp_id: string | null }>(
        `SELECT COALESCE(
          (SELECT corp_id FROM corporation_members WHERE character_id = $1 AND left_at IS NULL),
          (SELECT owner_corporation_id FROM ship_instances WHERE ship_id = $1)
        ) as corp_id`,
        [existingGarrison.owner_id],
      );
      const deployerCorpId = deployerCorpResult.rows[0]?.corp_id ?? null;
      const ownerCorpId = ownerCorpResult.rows[0]?.corp_id ?? null;
      const isFriendly = deployerCorpId !== null && ownerCorpId !== null && deployerCorpId === ownerCorpId;

      throw buildStatusError(
        isFriendly
          ? "Sector already has a friendly garrison; collect or reinforce through the existing garrison owner."
          : "Sector already contains another player's garrison; clear it before deploying your fighters.",
        409,
      );
    }

    const shipResult = await pg.queryObject<LockedShipLeaveRow>(
      `SELECT
        current_sector::int AS current_sector,
        current_fighters::int AS current_fighters
      FROM ship_instances
      WHERE ship_id = $1
      FOR UPDATE`,
      [input.shipId],
    );
    const shipRow = shipResult.rows[0];
    if (!shipRow) {
      throw buildStatusError("ship not found", 404);
    }
    if (asNumber(shipRow.current_sector) !== input.sectorId) {
      throw buildStatusError(
        `Character in sector ${asNumber(shipRow.current_sector)}, not requested sector ${input.sectorId}`,
        409,
      );
    }

    const currentFighters = asNumber(shipRow.current_fighters);
    if (input.quantity > currentFighters) {
      throw buildStatusError(
        `Insufficient fighters: ship has ${currentFighters}, requested ${input.quantity}`,
        400,
      );
    }

    const shipUpdateResult = await pg.queryObject<{ current_fighters: number }>(
      `UPDATE ship_instances
      SET current_fighters = current_fighters - $1,
          updated_at = NOW()
      WHERE ship_id = $2
      RETURNING current_fighters::int AS current_fighters`,
      [input.quantity, input.shipId],
    );
    const updatedShip = shipUpdateResult.rows[0];
    if (!updatedShip) {
      throw buildStatusError("Failed to update ship fighters", 500);
    }

    const effectiveTollAmount = input.mode === "toll" ? input.tollAmount : 0;
    let garrisonResult;
    if (existingGarrison) {
      garrisonResult = await pg.queryObject<LockedGarrisonRow>(
        `UPDATE garrisons
        SET fighters = fighters + $1,
            mode = $2,
            toll_amount = $3,
            updated_at = NOW()
        WHERE sector_id = $4
          AND owner_id = $5
        RETURNING
          owner_id,
          fighters::int AS fighters,
          mode,
          COALESCE(toll_amount, 0)::float8 AS toll_amount,
          COALESCE(toll_balance, 0)::float8 AS toll_balance,
          deployed_at`,
        [
          input.quantity,
          input.mode,
          effectiveTollAmount,
          input.sectorId,
          input.characterId,
        ],
      );
    } else {
      garrisonResult = await pg.queryObject<LockedGarrisonRow>(
        `INSERT INTO garrisons (
          sector_id,
          owner_id,
          fighters,
          mode,
          toll_amount,
          toll_balance,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, 0, NOW())
        RETURNING
          owner_id,
          fighters::int AS fighters,
          mode,
          COALESCE(toll_amount, 0)::float8 AS toll_amount,
          COALESCE(toll_balance, 0)::float8 AS toll_balance,
          deployed_at`,
        [
          input.sectorId,
          input.characterId,
          input.quantity,
          input.mode,
          effectiveTollAmount,
        ],
      );
    }

    const updatedGarrison = garrisonResult.rows[0];
    if (!updatedGarrison) {
      throw buildStatusError("Failed to deploy garrison", 500);
    }

    await pg.queryObject("COMMIT");
    inTransaction = false;

    return {
      newShipFighters: asNumber(updatedShip.current_fighters),
      garrison: normalizeGarrisonRow(updatedGarrison),
    };
  } catch (err) {
    if (inTransaction) {
      await rollbackQuietly(pg);
    }
    throw err;
  }
}

export async function runCollectFightersTransaction(
  pg: PgQueryClient,
  input: CollectFightersTransactionInput,
): Promise<CollectFightersTransactionResult> {
  let inTransaction = false;

  try {
    await pg.queryObject("BEGIN");
    inTransaction = true;

    // Serialize collect attempts per sector to prevent read/write races.
    await pg.queryObject("SELECT pg_advisory_xact_lock($1::bigint)", [
      input.sectorId,
    ]);

    const shipResult = await pg.queryObject<LockedShipCollectRow>(
      `SELECT
        current_fighters::int AS current_fighters,
        credits::bigint AS credits,
        owner_corporation_id
      FROM ship_instances
      WHERE ship_id = $1
      FOR UPDATE`,
      [input.shipId],
    );
    const shipRow = shipResult.rows[0];
    if (!shipRow) {
      throw buildStatusError("ship not found", 404);
    }

    const garrisonRows = await lockSectorGarrisons(pg, input.sectorId);
    if (garrisonRows.length === 0) {
      throw buildStatusError("No friendly garrison found in this sector", 404);
    }
    if (garrisonRows.length > 1) {
      console.warn("garrison_transaction.collect.multiple_garrisons", {
        sector_id: input.sectorId,
        owners: garrisonRows.map((row) => row.owner_id),
      });
      throw buildStatusError(
        "Sector has multiple garrisons; resolve data integrity before collecting fighters.",
        409,
      );
    }

    const garrison = garrisonRows[0];

    let isFriendly = garrison.owner_id === input.characterId;
    if (!isFriendly) {
      // Resolve effective corporation for both collector and garrison owner.
      // Uses COALESCE to check corporation_members first, then ship_instances
      // for corp-owned ships (whose character_id = ship_id).
      const collectorCorpResult = await pg.queryObject<{ corp_id: string | null }>(
        `SELECT COALESCE(
          (SELECT corp_id FROM corporation_members WHERE character_id = $1 AND left_at IS NULL),
          (SELECT owner_corporation_id FROM ship_instances WHERE ship_id = $1)
        ) as corp_id`,
        [input.characterId],
      );
      const collectorCorpId = collectorCorpResult.rows[0]?.corp_id ?? shipRow.owner_corporation_id;

      if (collectorCorpId) {
        const ownerCorpResult = await pg.queryObject<{ corp_id: string | null }>(
          `SELECT COALESCE(
            (SELECT corp_id FROM corporation_members WHERE character_id = $1 AND left_at IS NULL),
            (SELECT owner_corporation_id FROM ship_instances WHERE ship_id = $1)
          ) as corp_id`,
          [garrison.owner_id],
        );
        const ownerCorpId = ownerCorpResult.rows[0]?.corp_id ?? null;
        isFriendly = ownerCorpId !== null && ownerCorpId === collectorCorpId;
      }
    }

    if (!isFriendly) {
      throw buildStatusError("No friendly garrison found in this sector", 404);
    }

    const garrisonFighters = asNumber(garrison.fighters);
    if (input.quantity > garrisonFighters) {
      throw buildStatusError(
        `Cannot collect more fighters than stationed: garrison has ${garrisonFighters}, requested ${input.quantity}`,
        400,
      );
    }

    const remainingFighters = garrisonFighters - input.quantity;
    const tollPayoutRaw = garrison.mode === "toll"
      ? asNumber(garrison.toll_balance)
      : 0;
    const tollPayout = Math.max(0, Math.trunc(tollPayoutRaw));

    const shipUpdateResult = await pg.queryObject<{
      current_fighters: number;
      credits: number;
    }>(
      `UPDATE ship_instances
      SET current_fighters = current_fighters + $1,
          credits = credits + $2::bigint,
          updated_at = NOW()
      WHERE ship_id = $3
      RETURNING
        current_fighters::int AS current_fighters,
        credits::bigint AS credits`,
      [input.quantity, tollPayout, input.shipId],
    );
    const updatedShip = shipUpdateResult.rows[0];
    if (!updatedShip) {
      throw buildStatusError("Failed to update ship fighters", 500);
    }

    let updatedGarrison: LockedGarrisonRow | null = null;
    if (remainingFighters > 0) {
      const garrisonUpdateResult = await pg.queryObject<LockedGarrisonRow>(
        `UPDATE garrisons
        SET fighters = $1,
            toll_balance = 0,
            updated_at = NOW()
        WHERE sector_id = $2
          AND owner_id = $3
        RETURNING
          owner_id,
          fighters::int AS fighters,
          mode,
          COALESCE(toll_amount, 0)::float8 AS toll_amount,
          COALESCE(toll_balance, 0)::float8 AS toll_balance,
          deployed_at`,
        [remainingFighters, input.sectorId, garrison.owner_id],
      );
      updatedGarrison = garrisonUpdateResult.rows[0] ?? null;
      if (!updatedGarrison) {
        throw buildStatusError("Failed to update garrison", 500);
      }
    } else {
      await pg.queryObject(
        `DELETE FROM garrisons
        WHERE sector_id = $1
          AND owner_id = $2`,
        [input.sectorId, garrison.owner_id],
      );
    }

    await pg.queryObject("COMMIT");
    inTransaction = false;

    return {
      newShipFighters: asNumber(updatedShip.current_fighters),
      newShipCredits: asNumber(updatedShip.credits),
      tollPayout,
      garrisonOwnerId: garrison.owner_id,
      updatedGarrison: updatedGarrison
        ? normalizeGarrisonRow(updatedGarrison)
        : null,
    };
  } catch (err) {
    if (inTransaction) {
      await rollbackQuietly(pg);
    }
    throw err;
  }
}
