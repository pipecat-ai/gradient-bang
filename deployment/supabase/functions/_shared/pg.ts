import { Client } from "https://deno.land/x/postgres@v0.17.0/mod.ts";

/**
 * Create a Postgres client using the transaction pooler connection string.
 * Expected env var: POSTGRES_POOLER_URL (or POSTGRES_URL as fallback).
 */
export function createPgClient(): Client {
  const url = Deno.env.get("POSTGRES_POOLER_URL") ?? Deno.env.get("POSTGRES_URL");
  if (!url) {
    throw new Error("POSTGRES_POOLER_URL is required for direct PG access");
  }
  return new Client(url);
}

