# Map.Local Event Alignment (map.local)

This document lists where `map.local` is emitted and what must change on the server to match `docs/event_catalog.md`.

**Where map.local Events Are Emitted**

- `deployment/supabase/functions/join/index.ts` (uses `pgBuildLocalMapRegion`, adds `source`)
- `deployment/supabase/functions/move/index.ts` (uses `pgBuildLocalMapRegion`, adds `source`)

**Payload Builders**

- `deployment/supabase/functions/_shared/map.ts`
  - `buildLocalMapRegion`
  - `buildLocalMapRegionByBounds`
  - `loadPortCodes`
- `deployment/supabase/functions/_shared/pg_queries.ts`
  - `pgBuildLocalMapRegion`
  - `pgLoadPortCodes`

**Payload Mismatches vs `docs/event_catalog.md`**

1. `sectors[].port` is currently a **string port code** (or `""` when unknown). The catalog expects `port` to be **an object or null**: `{ code, mega? } | null`.

2. `lanes[].two_way` is optional/missing in server output (especially for unvisited derived lanes). The catalog requires a boolean.
3. `lanes[].hyperlane` is emitted by the server but no longer exists in the catalog and should be removed.
4. `adjacent_sectors` is only present for **visited** sectors in the server payload. The catalog expects it to always be an array (can be empty).

**Recommended Server Changes (To Match Catalog Shapes)**

1. Rename `sectors[].source` to `sectors[].scope` in both Supabase and PG builders.
2. Replace `sectors[].port` string with a port object or null:
   - Prefer `knowledge.sectors_visited[sectorId].port` (already stored from sector snapshots) and reduce it to `{ code, mega? }`.
   - Or expand `loadPortCodes`/`pgLoadPortCodes` to return `{ code, mega? }` instead of a bare string.
   - Replace empty string with `null` when no port exists.
3. Ensure every lane includes `two_way` (default to `false` when unknown).
4. Remove `hyperlane` from lanes in the payload.
5. Provide `adjacent_sectors` for unvisited sectors (use universe adjacency) or set it to `[]`.
6. Do **not** modify lane construction or mapping logic beyond removing `hyperlane`. If a change would require SQL or algorithm changes, leave it as-is and only strip the `hyperlane` property.

**Notes**

- Client types currently expect `port?: string`, `source?: "player" | "corp" | "both"`, and `hyperlane?: boolean` in `client/app/src/types/global.d.ts`. Aligning server output to the catalog will require updating client types and any related UI logic (notably the map renderer that checks `node.port === "SSS"`).
