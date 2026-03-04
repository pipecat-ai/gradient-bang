import {
  Client,
  Pool,
} from "https://deno.land/x/postgres@v0.17.0/mod.ts";
import type { PoolClient } from "https://deno.land/x/postgres@v0.17.0/mod.ts";

const POOL_SIZE = 3;

let _pool: Pool | null = null;

function getPgUrl(): string {
  const url =
    Deno.env.get("POSTGRES_POOLER_URL") ?? Deno.env.get("POSTGRES_URL");
  if (!url) {
    throw new Error("POSTGRES_POOLER_URL is required for direct PG access");
  }
  return url;
}

/** Get or create the global connection pool (lazy, size 3). */
export function getPgPool(): Pool {
  if (!_pool) {
    _pool = new Pool(getPgUrl(), POOL_SIZE, true /* lazy */);
  }
  return _pool;
}

/** Acquire a client from the global pool. Caller MUST call client.release() when done. */
export async function acquirePgClient(): Promise<PoolClient> {
  return await getPgPool().connect();
}

/** @deprecated Use acquirePgClient() instead. Kept for test compatibility. */
export function createPgClient(): Client {
  return new Client(getPgUrl());
}

/** @deprecated Pool clients do not need cleanup. Kept for test compatibility. */
export async function connectWithCleanup(pg: Client): Promise<void> {
  await pg.connect();
  try {
    await pg.queryObject("DEALLOCATE ALL");
  } catch (err) {
    console.debug("pg.deallocate_all.ignored", err);
  }
}

// ============================================================================
// Global Adjacency Cache
// ============================================================================

let _adjacencyCache: Map<number, number[]> | null = null;
let _adjacencyWarmupPromise: Promise<void> | null = null;

/**
 * Get the cached adjacency map. If the cache is not yet populated,
 * fetches from the database using the provided query function.
 * The queryFn parameter allows callers to use their own PG client
 * without creating a circular dependency.
 */
export async function getCachedAdjacencies(
  queryFn: () => Promise<Map<number, number[]>>,
): Promise<Map<number, number[]>> {
  if (_adjacencyCache) {
    return _adjacencyCache;
  }
  // If warmup is in progress, wait for it
  if (_adjacencyWarmupPromise) {
    await _adjacencyWarmupPromise;
    if (_adjacencyCache) {
      return _adjacencyCache;
    }
  }
  // Fetch and cache
  _adjacencyCache = await queryFn();
  return _adjacencyCache;
}

/**
 * Start a background task to populate the adjacency cache.
 * Does not block — returns immediately. Errors are logged but not thrown.
 */
export function warmupAdjacencyCache(
  queryFn: () => Promise<Map<number, number[]>>,
): void {
  if (_adjacencyCache || _adjacencyWarmupPromise) {
    return; // Already cached or warming up
  }
  _adjacencyWarmupPromise = queryFn()
    .then((map) => {
      _adjacencyCache = map;
      console.log(`[pg] adjacency cache warmed: ${map.size} sectors`);
    })
    .catch((err) => {
      console.error("[pg] adjacency cache warmup failed:", err);
    })
    .finally(() => {
      _adjacencyWarmupPromise = null;
    });
}

/** Clear the adjacency cache (for testing). */
export function clearAdjacencyCache(): void {
  _adjacencyCache = null;
  _adjacencyWarmupPromise = null;
}
