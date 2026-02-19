import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.197.0/testing/asserts.ts";

import {
  runCollectFightersTransaction,
  runLeaveFightersTransaction,
  type PgQueryClient,
} from "./garrison_transactions.ts";

interface ShipState {
  ship_id: string;
  current_sector: number;
  current_fighters: number;
  credits: number;
  owner_corporation_id: string | null;
}

interface GarrisonState {
  sector_id: number;
  owner_id: string;
  fighters: number;
  mode: string;
  toll_amount: number;
  toll_balance: number;
  deployed_at: string | null;
}

class SectorLockManager {
  private tails = new Map<number, Promise<void>>();

  async acquire(sectorId: number): Promise<() => void> {
    const current = this.tails.get(sectorId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = current.then(() => next);
    this.tails.set(sectorId, chain);
    await current;

    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      release();
      if (this.tails.get(sectorId) === chain) {
        this.tails.delete(sectorId);
      }
    };
  }
}

class FakeWorld {
  ships = new Map<string, ShipState>();
  garrisons = new Map<number, GarrisonState>();
  memberships = new Map<string, string | null>();
  locks = new SectorLockManager();
}

function cloneMap<K, V extends object>(map: Map<K, V>): Map<K, V> {
  const next = new Map<K, V>();
  for (const [key, value] of map.entries()) {
    next.set(key, { ...value });
  }
  return next;
}

class FakePgClient implements PgQueryClient {
  private inTransaction = false;
  private txShips: Map<string, ShipState> | null = null;
  private txGarrisons: Map<number, GarrisonState> | null = null;
  private lockReleaser: (() => void) | null = null;
  private failOnPattern: string | null = null;

  constructor(private readonly world: FakeWorld) {}

  failOnceOn(pattern: string): void {
    this.failOnPattern = pattern;
  }

  private state() {
    if (!this.txShips || !this.txGarrisons) {
      throw new Error("transaction state not initialized");
    }
    return {
      ships: this.txShips,
      garrisons: this.txGarrisons,
    };
  }

  private ensureSnapshot(): void {
    if (!this.txShips || !this.txGarrisons) {
      this.txShips = cloneMap(this.world.ships);
      this.txGarrisons = cloneMap(this.world.garrisons);
    }
  }

  private maybeFail(query: string): void {
    if (this.failOnPattern && query.includes(this.failOnPattern)) {
      this.failOnPattern = null;
      throw new Error("injected failure");
    }
  }

  async queryObject<T>(
    query: string,
    params: unknown[] = [],
  ): Promise<{ rows: T[] }> {
    const sql = query.trim();

    if (sql === "BEGIN") {
      this.inTransaction = true;
      this.txShips = null;
      this.txGarrisons = null;
      return { rows: [] };
    }

    if (sql === "COMMIT") {
      if (this.txShips && this.txGarrisons) {
        this.world.ships = cloneMap(this.txShips);
        this.world.garrisons = cloneMap(this.txGarrisons);
      }
      this.inTransaction = false;
      this.txShips = null;
      this.txGarrisons = null;
      this.lockReleaser?.();
      this.lockReleaser = null;
      return { rows: [] };
    }

    if (sql === "ROLLBACK") {
      this.inTransaction = false;
      this.txShips = null;
      this.txGarrisons = null;
      this.lockReleaser?.();
      this.lockReleaser = null;
      return { rows: [] };
    }

    if (!this.inTransaction) {
      throw new Error(`unexpected query outside transaction: ${sql}`);
    }

    this.maybeFail(sql);

    if (sql.includes("pg_advisory_xact_lock")) {
      const sectorId = Number(params[0]);
      this.lockReleaser = await this.world.locks.acquire(sectorId);
      this.ensureSnapshot();
      return { rows: [] };
    }

    this.ensureSnapshot();
    const { ships, garrisons } = this.state();

    if (sql.includes("FROM ship_instances") && sql.includes("FOR UPDATE")) {
      const shipId = String(params[0]);
      const ship = ships.get(shipId);
      if (!ship) {
        return { rows: [] };
      }
      if (sql.includes("current_sector::int AS current_sector")) {
        return {
          rows: [{
            current_sector: ship.current_sector,
            current_fighters: ship.current_fighters,
          } as T],
        };
      }
      return {
        rows: [{
          current_fighters: ship.current_fighters,
          credits: ship.credits,
          owner_corporation_id: ship.owner_corporation_id,
        } as T],
      };
    }

    if (sql.includes("FROM garrisons") && sql.includes("FOR UPDATE")) {
      const sectorId = Number(params[0]);
      const garrison = garrisons.get(sectorId);
      return {
        rows: garrison
          ? [{
            owner_id: garrison.owner_id,
            fighters: garrison.fighters,
            mode: garrison.mode,
            toll_amount: garrison.toll_amount,
            toll_balance: garrison.toll_balance,
            deployed_at: garrison.deployed_at,
          } as T]
          : [],
      };
    }

    if (sql.includes("FROM corporation_members")) {
      const characterId = String(params[0]);
      const corpId = this.world.memberships.get(characterId) ?? null;
      return {
        rows: corpId ? [{ corp_id: corpId } as T] : [],
      };
    }

    if (
      sql.includes("UPDATE ship_instances") &&
      sql.includes("current_fighters = current_fighters -")
    ) {
      const quantity = Number(params[0]);
      const shipId = String(params[1]);
      const ship = ships.get(shipId);
      if (!ship) {
        return { rows: [] };
      }
      ship.current_fighters -= quantity;
      return {
        rows: [{ current_fighters: ship.current_fighters } as T],
      };
    }

    if (
      sql.includes("UPDATE ship_instances") &&
      sql.includes("current_fighters = current_fighters +")
    ) {
      const quantity = Number(params[0]);
      const creditDelta = Number(params[1]);
      const shipId = String(params[2]);
      const ship = ships.get(shipId);
      if (!ship) {
        return { rows: [] };
      }
      ship.current_fighters += quantity;
      ship.credits += creditDelta;
      return {
        rows: [{
          current_fighters: ship.current_fighters,
          credits: ship.credits,
        } as T],
      };
    }

    if (
      sql.includes("UPDATE garrisons") &&
      sql.includes("fighters = fighters +")
    ) {
      const quantity = Number(params[0]);
      const mode = String(params[1]);
      const tollAmount = Number(params[2]);
      const sectorId = Number(params[3]);
      const ownerId = String(params[4]);
      const garrison = garrisons.get(sectorId);
      if (!garrison || garrison.owner_id !== ownerId) {
        return { rows: [] };
      }
      garrison.fighters += quantity;
      garrison.mode = mode;
      garrison.toll_amount = tollAmount;
      return {
        rows: [{
          owner_id: garrison.owner_id,
          fighters: garrison.fighters,
          mode: garrison.mode,
          toll_amount: garrison.toll_amount,
          toll_balance: garrison.toll_balance,
          deployed_at: garrison.deployed_at,
        } as T],
      };
    }

    if (sql.startsWith("INSERT INTO garrisons")) {
      const sectorId = Number(params[0]);
      const ownerId = String(params[1]);
      const fighters = Number(params[2]);
      const mode = String(params[3]);
      const tollAmount = Number(params[4]);
      if (garrisons.has(sectorId)) {
        throw new Error("duplicate garrison");
      }
      const garrison: GarrisonState = {
        sector_id: sectorId,
        owner_id: ownerId,
        fighters,
        mode,
        toll_amount: tollAmount,
        toll_balance: 0,
        deployed_at: "2026-02-18T00:00:00.000Z",
      };
      garrisons.set(sectorId, garrison);
      return {
        rows: [{
          owner_id: garrison.owner_id,
          fighters: garrison.fighters,
          mode: garrison.mode,
          toll_amount: garrison.toll_amount,
          toll_balance: garrison.toll_balance,
          deployed_at: garrison.deployed_at,
        } as T],
      };
    }

    if (
      sql.includes("UPDATE garrisons") &&
      sql.includes("SET fighters = $1") &&
      sql.includes("toll_balance = 0")
    ) {
      const fighters = Number(params[0]);
      const sectorId = Number(params[1]);
      const ownerId = String(params[2]);
      const garrison = garrisons.get(sectorId);
      if (!garrison || garrison.owner_id !== ownerId) {
        return { rows: [] };
      }
      garrison.fighters = fighters;
      garrison.toll_balance = 0;
      return {
        rows: [{
          owner_id: garrison.owner_id,
          fighters: garrison.fighters,
          mode: garrison.mode,
          toll_amount: garrison.toll_amount,
          toll_balance: garrison.toll_balance,
          deployed_at: garrison.deployed_at,
        } as T],
      };
    }

    if (sql.startsWith("DELETE FROM garrisons")) {
      const sectorId = Number(params[0]);
      const ownerId = String(params[1]);
      const garrison = garrisons.get(sectorId);
      if (garrison && garrison.owner_id === ownerId) {
        garrisons.delete(sectorId);
      }
      return { rows: [] };
    }

    throw new Error(`unhandled query in fake pg client: ${sql}`);
  }
}

async function expectStatus(
  promise: Promise<unknown>,
  status: number,
): Promise<void> {
  try {
    await promise;
  } catch (err) {
    const typed = err as Error & { status?: number };
    assertEquals(typed.status, status);
    return;
  }
  throw new Error(`expected failure with status ${status}`);
}

Deno.test("leave rejects deploying into another owner's garrison", async () => {
  const world = new FakeWorld();
  world.ships.set("ship-a", {
    ship_id: "ship-a",
    current_sector: 7,
    current_fighters: 100,
    credits: 0,
    owner_corporation_id: null,
  });
  world.ships.set("ship-b", {
    ship_id: "ship-b",
    current_sector: 7,
    current_fighters: 80,
    credits: 0,
    owner_corporation_id: null,
  });
  world.garrisons.set(7, {
    sector_id: 7,
    owner_id: "owner-a",
    fighters: 20,
    mode: "defensive",
    toll_amount: 0,
    toll_balance: 0,
    deployed_at: "2026-02-18T00:00:00.000Z",
  });

  const pg = new FakePgClient(world);
  await expectStatus(
    runLeaveFightersTransaction(pg, {
      sectorId: 7,
      characterId: "owner-b",
      shipId: "ship-b",
      quantity: 10,
      mode: "offensive",
      tollAmount: 0,
    }),
    409,
  );

  assertEquals(world.ships.get("ship-b")?.current_fighters, 80);
  assertEquals(world.garrisons.get(7)?.owner_id, "owner-a");
});

Deno.test("leave serializes race and prevents double insert", async () => {
  const world = new FakeWorld();
  world.ships.set("ship-a", {
    ship_id: "ship-a",
    current_sector: 9,
    current_fighters: 100,
    credits: 0,
    owner_corporation_id: null,
  });
  world.ships.set("ship-b", {
    ship_id: "ship-b",
    current_sector: 9,
    current_fighters: 100,
    credits: 0,
    owner_corporation_id: null,
  });

  const pgA = new FakePgClient(world);
  const pgB = new FakePgClient(world);

  const [first, second] = await Promise.allSettled([
    runLeaveFightersTransaction(pgA, {
      sectorId: 9,
      characterId: "owner-a",
      shipId: "ship-a",
      quantity: 10,
      mode: "offensive",
      tollAmount: 0,
    }),
    runLeaveFightersTransaction(pgB, {
      sectorId: 9,
      characterId: "owner-b",
      shipId: "ship-b",
      quantity: 10,
      mode: "offensive",
      tollAmount: 0,
    }),
  ]);

  const fulfilled = [first, second].filter((r) => r.status === "fulfilled");
  const rejected = [first, second].filter((r) => r.status === "rejected");
  assertEquals(fulfilled.length, 1);
  assertEquals(rejected.length, 1);

  const failure = rejected[0] as PromiseRejectedResult;
  assertEquals((failure.reason as { status?: number }).status, 409);

  const garrison = world.garrisons.get(9);
  assertEquals(Boolean(garrison), true);
  assertEquals(garrison?.fighters, 10);

  if ((fulfilled[0] as PromiseFulfilledResult<any>).value.garrison.owner_id === "owner-a") {
    assertEquals(world.ships.get("ship-a")?.current_fighters, 90);
    assertEquals(world.ships.get("ship-b")?.current_fighters, 100);
  } else {
    assertEquals(world.ships.get("ship-a")?.current_fighters, 100);
    assertEquals(world.ships.get("ship-b")?.current_fighters, 90);
  }
});

Deno.test("leave rolls back ship fighter deduction when garrison write fails", async () => {
  const world = new FakeWorld();
  world.ships.set("ship-a", {
    ship_id: "ship-a",
    current_sector: 3,
    current_fighters: 80,
    credits: 0,
    owner_corporation_id: null,
  });

  const pg = new FakePgClient(world);
  pg.failOnceOn("INSERT INTO garrisons");

  await assertRejects(
    () =>
      runLeaveFightersTransaction(pg, {
        sectorId: 3,
        characterId: "owner-a",
        shipId: "ship-a",
        quantity: 25,
        mode: "offensive",
        tollAmount: 0,
      }),
  );

  assertEquals(world.ships.get("ship-a")?.current_fighters, 80);
  assertEquals(world.garrisons.get(3), undefined);
});

Deno.test("collect rolls back ship credit/fighter updates when garrison write fails", async () => {
  const world = new FakeWorld();
  world.ships.set("ship-a", {
    ship_id: "ship-a",
    current_sector: 4,
    current_fighters: 20,
    credits: 1000,
    owner_corporation_id: null,
  });
  world.garrisons.set(4, {
    sector_id: 4,
    owner_id: "owner-a",
    fighters: 30,
    mode: "toll",
    toll_amount: 50,
    toll_balance: 200,
    deployed_at: "2026-02-18T00:00:00.000Z",
  });

  const pg = new FakePgClient(world);
  pg.failOnceOn("SET fighters = $1");

  await assertRejects(
    () =>
      runCollectFightersTransaction(pg, {
        sectorId: 4,
        characterId: "owner-a",
        shipId: "ship-a",
        quantity: 10,
      }),
  );

  assertEquals(world.ships.get("ship-a")?.current_fighters, 20);
  assertEquals(world.ships.get("ship-a")?.credits, 1000);
  assertEquals(world.garrisons.get(4)?.fighters, 30);
  assertEquals(world.garrisons.get(4)?.toll_balance, 200);
});
