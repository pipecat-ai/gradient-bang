import { Client } from "https://deno.land/x/postgres@v0.17.0/mod.ts";

// ── Global connection pool ──────────────────────────────────────────────────
//
// Reuses PG connections across requests within the same Deno process.
//
// When edge functions run in the bot container (via server.ts), all functions
// share this pool — avoiding ~950ms connection overhead on each request.
//
// On Supabase Edge (isolated per invocation), the pool still helps within
// a single request that acquires/releases multiple times (e.g., move releases
// before the hyperspace delay and reacquires after — with the pool, the
// reacquire is near-instant instead of ~950ms).

const idle: Client[] = [];
const MAX_IDLE = 4;

function getConnectionUrl(): string {
  const url =
    Deno.env.get("POSTGRES_POOLER_URL") ?? Deno.env.get("POSTGRES_URL");
  if (!url) {
    throw new Error("POSTGRES_POOLER_URL is required for direct PG access");
  }
  return url;
}

/**
 * Acquire a PG client from the pool.
 *
 * If an idle connection is available, it's reused (with DEALLOCATE ALL for
 * Supavisor/PgBouncer transaction-mode safety). Otherwise a new connection
 * is established.
 *
 * Call `releasePg()` when done — NOT `client.end()`.
 */
export async function acquirePg(): Promise<Client> {
  // Try to reuse an idle connection
  while (idle.length > 0) {
    const client = idle.pop()!;
    try {
      // DEALLOCATE ALL serves as both liveness check and prepared-statement
      // cleanup (required when Supavisor may reassign the PG backend between
      // transactions in transaction-pooling mode).
      await client.queryObject("DEALLOCATE ALL");
      return client;
    } catch {
      // Connection is stale or broken — discard silently
      try {
        await client.end();
      } catch {
        /* ignore */
      }
    }
  }

  // No idle connections — create a fresh one
  const client = new Client(getConnectionUrl());
  await client.connect();
  try {
    await client.queryObject("DEALLOCATE ALL");
  } catch (err) {
    console.debug("pg.deallocate_all.ignored", err);
  }
  return client;
}

/**
 * Return a PG client to the pool for reuse.
 *
 * Do NOT call `client.end()` — the pool manages the connection lifecycle.
 */
export function releasePg(client: Client): void {
  if (idle.length < MAX_IDLE) {
    idle.push(client);
  } else {
    // Pool is full — close the excess connection
    client.end().catch(() => {});
  }
}

// ── Legacy API (kept for call sites not yet migrated) ─────────────────────

/** @deprecated Use `acquirePg()` instead. */
export function createPgClient(): Client {
  return new Client(getConnectionUrl());
}

/** @deprecated Use `acquirePg()` instead (it handles DEALLOCATE ALL). */
export async function connectWithCleanup(pg: Client): Promise<void> {
  await pg.connect();
  try {
    await pg.queryObject("DEALLOCATE ALL");
  } catch (err) {
    console.debug("pg.deallocate_all.ignored", err);
  }
}
