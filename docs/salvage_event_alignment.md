# Salvage Event Alignment (salvage.created / salvage.collected)

This document lists where `salvage.created` and `salvage.collected` are emitted and what must change on the server to match `docs/event_catalog.md`.

**Where Salvage Events Are Emitted**

salvage.created:

- `deployment/supabase/functions/dump_cargo/index.ts` (actor-scoped; uses `salvage_details`)
- `deployment/supabase/functions/_shared/combat_finalization.ts` (sector-wide; uses top-level `salvage_id`, `cargo`, etc.)

salvage.collected:

- `deployment/supabase/functions/salvage_collect/index.ts` (actor-scoped; uses `salvage_details`)

**Payload Mismatches vs `docs/event_catalog.md`**

1. Actor-scoped salvage events did not include `scope` (`"player"` vs `"corporation"`), even though corp ships can perform these actions.

**Changes Implemented**

- Added `scope` to `salvage.created` when emitted from `dump_cargo`.
- Added `scope` to `salvage.collected` when emitted from `salvage_collect`.
- `scope` is derived from the target ship/character using shared helpers (`resolvePlayerType`, `resolveScope`).
- Sector-wide `salvage.created` from combat remains unchanged (no scope), since it is not actor-scoped.

**PR Summary (Salvage Events)**

**What changed**

- Added optional `scope: "player" | "corporation"` to actor-scoped salvage events.
- Updated the catalog and server payloads for `salvage.created` (dump cargo) and `salvage.collected`.
