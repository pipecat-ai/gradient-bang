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

- `lanes[].two_way` can still be omitted for derived (unvisited) lanes because we are not changing lane construction logic; the catalog expects a boolean.

**Changes Implemented**

- Renamed `sectors[].source` to `sectors[].scope`.
- Replaced `sectors[].port` string with `{ code, mega? } | null` (empty string → `null`).
- Removed `hyperlane` from lane objects.
- Ensured `adjacent_sectors` is always present (empty array for unvisited sectors).

**Lane Logic Note**

- Do **not** modify lane construction or mapping logic beyond removing `hyperlane`. If a change would require SQL or algorithm changes, leave it as-is.

**Notes**

- Client types currently expect `port?: string`, `source?: "player" | "corp" | "both"`, and `hyperlane?: boolean` in `client/app/src/types/global.d.ts`. Aligning client types and UI logic will be required (notably the map renderer that checks `node.port === "SSS"`).

**PR Summary (Map.Local Payload)**

**What changed**
- `sectors[].source` → `sectors[].scope`.
- `sectors[].port` is now `{ code, mega? } | null` instead of a string (no empty string).
- Removed `hyperlane` from lane objects.
- `adjacent_sectors` is always an array (empty if unknown).

**Remaining gap**
- `lanes[].two_way` can still be omitted for derived lanes because lane logic was left unchanged by design.
