# Sector.Update Event Alignment (sector.update)

This document lists where `sector.update` is emitted and what must change on the server to match `docs/event_catalog.md`.

**Where sector.update Events Are Emitted**

- `deployment/supabase/functions/dump_cargo/index.ts` (uses `buildSectorSnapshot`)
- `deployment/supabase/functions/salvage_collect/index.ts` (uses `buildSectorSnapshot`, adds `source`)
- `deployment/supabase/functions/_shared/combat_resolution.ts` (uses `buildSectorSnapshot`, adds `source`)
- `deployment/supabase/functions/combat_collect_fighters/index.ts` (uses `buildSectorSnapshot`, adds `source`)
- `deployment/supabase/functions/combat_set_garrison_mode/index.ts` (uses `buildSectorSnapshot`, adds `source`)
- `deployment/supabase/functions/combat_leave_fighters/index.ts` (uses `buildSectorSnapshot`, adds `source`)

**Payload Builder**

- `deployment/supabase/functions/_shared/map.ts` (`buildSectorSnapshot`)

**Payload Mismatches vs `docs/event_catalog.md`**

1. None.

**Changes Implemented**

- `combat_collect_fighters` now emits a full `buildSectorSnapshot(...)` payload for `sector.update`.
- `combat_set_garrison_mode` now emits a full `buildSectorSnapshot(...)` payload for `sector.update`.
- `combat_leave_fighters` now emits `sector.update` with a full sector snapshot for parity.
- `source` is attached to the sector snapshot payload in the combat-related updates above.

**Notes**

- `dump_cargo`, `salvage_collect`, and `combat_resolution` already emit a full sector snapshot (same shape as `status.sector`).

**PR Summary (Sector.Update Payload)**

**What changed**

- Normalized `sector.update` emissions to always send a full sector snapshot for combat actions.
- Added `sector.update` emission to `combat_leave_fighters` for parity.
- Attached optional `source` metadata to combat-driven `sector.update` payloads.
