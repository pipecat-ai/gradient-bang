# Status Event Alignment (status.snapshot / status.update)

This document lists where `status.snapshot` and `status.update` are emitted and what must change on the server to match `docs/event_catalog.md`.

**Where Status Events Are Emitted**

status.snapshot:

- `deployment/supabase/functions/join/index.ts` (uses `pgBuildStatusPayload`, adds `source`)
- `deployment/supabase/functions/my_status/index.ts` (uses `buildStatusPayload`, adds `source`)

status.update:

- `deployment/supabase/functions/bank_transfer/index.ts`
- `deployment/supabase/functions/combat_collect_fighters/index.ts`
- `deployment/supabase/functions/dump_cargo/index.ts`
- `deployment/supabase/functions/purchase_fighters/index.ts`
- `deployment/supabase/functions/recharge_warp_power/index.ts`
- `deployment/supabase/functions/salvage_collect/index.ts` (adds `source`)
- `deployment/supabase/functions/ship_purchase/index.ts`
- `deployment/supabase/functions/ship_rename/index.ts`
- `deployment/supabase/functions/trade/index.ts`
- `deployment/supabase/functions/transfer_credits/index.ts`
- `deployment/supabase/functions/transfer_warp_power/index.ts`

Status payload builders:

- `deployment/supabase/functions/_shared/status.ts` (`buildStatusPayload`)
- `deployment/supabase/functions/_shared/pg_queries.ts` (`pgBuildStatusPayload`)

Sector snapshot builders used by status payloads:

- `deployment/supabase/functions/_shared/map.ts` (`buildSectorSnapshot`)
- `deployment/supabase/functions/_shared/pg_queries.ts` (`pgBuildSectorSnapshot`)

**Payload Mismatches vs `docs/event_catalog.md`**

1. Missing top-level `scope: "player" | "corporation"` in status payloads. Neither `buildStatusPayload` nor `pgBuildStatusPayload` includes it.

**Recommended Server Changes (To Match Catalog Shapes)**

1. Add `scope` to `buildStatusPayload` and `pgBuildStatusPayload`, and set it in every status emitter (use request context such as `actor_character_id`, `characterId`, and/or `player_type` to decide `player` vs `corporation`).
