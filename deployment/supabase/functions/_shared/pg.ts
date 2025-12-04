import { Client } from "https://deno.land/x/postgres@v0.17.0/mod.ts";

/**
 * Create a Postgres client using the pooler connection string.
 * Expected env var: POSTGRES_POOLER_URL (or POSTGRES_URL as fallback).
 */
export function createPgClient(): Client {
  const url = Deno.env.get("POSTGRES_POOLER_URL") ?? Deno.env.get("POSTGRES_URL");
  if (!url) {
    throw new Error("POSTGRES_POOLER_URL is required for direct PG access");
  }
  return new Client(url);
}

/**
 * Connect to the database and clear any lingering prepared statements.
 * This is necessary when using PgBouncer in transaction pooling mode,
 * where prepared statements from other sessions may persist on the connection.
 */
export async function connectWithCleanup(pg: Client): Promise<void> {
  await pg.connect();
  // Clear any prepared statements from previous sessions on this pooled connection
  // This prevents "prepared statement already exists" errors with PgBouncer
  try {
    await pg.queryObject("DEALLOCATE ALL");
  } catch (err) {
    // Ignore errors - DEALLOCATE ALL may fail if not supported or not needed
    console.debug("pg.deallocate_all.ignored", err);
  }
}

