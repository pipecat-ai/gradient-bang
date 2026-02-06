# Event Identity Standardization Plan

## Goal
Standardize event identity so the client can safely scope UI updates by player/ship without guessing.

## Proposed Standard
- **All events emitted via `emitCharacterEvent` / `pgEmitCharacterEvent` include a top-level
  `player: { id, name? }` block.**
  - Implemented at the emission layer for `emitCharacterEvent` + `pgEmitCharacterEvent`.
  - Only injected when `payload.player` is missing (avoid overriding richer `player` payloads).
  - Events recorded via `recordEventWithRecipients` (e.g., `chat.message`, `ship.destroyed`)
    are **not** covered unless explicitly updated at their call sites.
- **Ship-specific events include `ship_id` when not already present.**
  - If a `ship` block already exists, its `ship_id` is sufficient.
  - This is mostly for events like `course.plot`, `movement.start`, `garrison.*`, `salvage.*`, etc.
- **`sector.update` is treated as player-scoped for UI.**
  - The client should only apply it to the *active player's* UI (ignore corp-ship updates).

Rationale:
- Each player pilots exactly one ship at a time; corp ships have a distinct "virtual player" id.
- `player.id` is a stable routing key for UI decisions.
- `ship_id` is still useful for ship list updates and ship-scoped UI.

## Emission-Layer Injection (Mechanism)
To avoid per-call-site duplication and DB lookups:
- In both `emitCharacterEvent` and `pgEmitCharacterEvent`:
  - `finalPayload = { ...payload }`
  - If `finalPayload.player` is missing:
    - `finalPayload.player = { id: characterId }`
  - If `shipId` exists and `finalPayload.ship_id` is missing and `finalPayload.ship` is missing:
    - `finalPayload.ship_id = shipId`
- If a call site already provides a richer `player` block (including `name`), it is preserved.

## Clarifications
### 1) What is "ship-specific"?
For this plan, **ship-specific** means events that mutate a ship's state or directly drive ship UI.
Even if routing is by `player.id`, a `ship_id` (or `ship` block) is still useful to update ship lists and panels without extra fetches.

Ship-specific (non-exhaustive, current client-handled):  
`status.*`, `movement.start`, `movement.complete`, `course.plot`, `path.region`, `trade.executed`,  
`warp.purchase`, `warp.transfer`, `credits.transfer`, `fighter.purchase`,  
`salvage.created`, `salvage.collected`, `garrison.deployed`, `garrison.collected`, `garrison.mode_changed`,  
`combat.*` (round events + action accepted), `ship.renamed`, `ship.destroyed`.

### 2) Where is `sector.update` used in the client?
`client/app/src/GameContext.tsx` handles `sector.update` by calling `gameStore.setSector`.
That single store field drives sector UI in components like:
`SectorPanel`, `PortPanel`, `PortBadge`, `SectorTitleBanner`, `SectorBadge`, `SectorPlayersBadge`,
`MapScreen`, `MiniMapPanel`, `ShipDetails`, and `CoursePlotPanel`.
Because this is *the* current sector UI, the client must only apply `sector.update`
for the active player's ship, not for corp-ship activity.
Corp ship panels currently read from `ships.data` (ship list) and `ship.sector`,
not from `gameStore.sector`, so filtering `sector.update` to the active player
should not break corp ship UI. If we ever need corp-ship sector detail views,
we'll need a per-ship sector snapshot store (e.g., `sectorByShipId`).

Important detail:
- `sector.update` payloads do **not** include `player` or `ship` identity.
- Delivery is limited to **sector observers** (current-sector ships + garrison owners),
  not corp scope, so corp ships in other sectors do not receive these updates.
- Client fix should be a defensive guard, not identity routing:
  - Prefer `updateSector` (ID-guarded) or `if (data.id === gameStore.sector?.id) setSector(...)`.

### Corp Ship Update Flow (Current Client)
Corp ship UI (e.g., the list rows and map position icons) is driven by `ships.data`.
Key components:
- `PlayerShipPanel` renders corp ships from `ships.data` (shows name, sector, credits).
- `MapScreen` and `MiniMapPanel` render corp ship position icons from `ships.data[].sector`.

Events that currently update `ships.data`:
- `ships.list` → `gameStore.setShips` (initial/refresh list)
- `corporation.ship_purchased` → `gameStore.addShip` (adds a corp ship entry)
- `character.moved` → `gameStore.updateShip({ ship_id, sector })` (updates position)

Corp ship **map position icons** (MapScreen/MiniMapPanel) are driven by
`ships.data[].sector`, so they update via `character.moved` and `ships.list`.

Additional reality (important):
- The bot already polls **corp + ship scopes** and forwards most events to the client.
- It only drops `movement.start`, `movement.complete`, and some `character.moved` depart events
  for other players. `status.update` is **not** dropped.
- The client currently **filters out** non-human `status.update` events
  (`client/app/src/GameContext.tsx`), which is why corp ship stats appear stale.
  - Many `status.update` emitters already set `corp_id` even for **human** players, which means
    corp members can receive other humans’ status updates. This is **intended** — corp members
    should see corp-mate status — but the client must not apply those to the personal UI.

Note: `sector.update` does **not** affect corp ship panels/icons directly.
If corp ship UI needs richer ship stats (credits/cargo/etc.), we should update `ships.data`
on **corp ship** `status.update` events (non-personal `player.id`).

### Map Data Fetch + Update (Main Branch)
- Client `get-my-map` → `bot.py` → `local_map_region` edge function.
- `local_map_region` emits `map.region` for the requesting character (merged personal+corp knowledge).
- On movement:
  - `movement.complete` emits `map.local` to the moving character (merged knowledge).
  - If a **human player** discovers a new sector not known to the corp:
    - `map.update` is emitted to corp members (so everyone’s merged map updates).
  - If a **corp ship** discovers a new sector:
    - corp knowledge is updated, and `map.update` is emitted to corp members.
- Conclusion:
  - Player map updates on every player move (`map.local`).
  - Corp ship discoveries *do* update the player’s map via `map.update` if they expand corp knowledge.

Map event routing (with identity injection):
- `map.local` and `map.region` will receive an injected `player.id`; the client must **only** apply
  these to the personal player.
- `map.update` remains additive and should stay unguarded.

### Map Coloring (Visited vs Unvisited) — Follow-up
This is UI-only and does not depend on identity work. Keep it out of this plan:
- Remove `visited_corp` styling.
- Update map legend + map detail panel ("Visited") accordingly.

### Corp Ship Mini-Panel: Richer Stats (Planned)
The corp ship mini-panel (list rows) reads `ships.data` and currently only updates via:
`ships.list`, `corporation.ship_purchased`, and `character.moved` (sector only).

Updated understanding:
- **Corp ship `status.update` events already reach the client** via the bot’s corp/ship polling scope.
- They are filtered out in `GameContext.tsx`, so the data exists but is ignored.

Chosen approach: **Use existing `status.update` events; fix client routing.**

Impact considerations:
- **Payload size:** `status.update` includes a full sector snapshot.
- **Frequency:** many actions emit `status.update` (trade, move, warp, combat).
- **Client cost:** more events to parse; must route by `player.id` to avoid mutating personal UI.

Mitigations:
- Route on the client using `player.id` and `player.player_type` so only **corp ship** rows update (no toasts/UI spam).
- Avoid applying `sector.update` to corp ships; use `status.update` for ship stats only.

Payload assumptions to verify (server):
- `status.update` payload includes a full `ship` block with stats.
- Events are recorded with `corp_id` and `ship_id` so they are reachable via polling scope.
  - Status update emitters (main branch) to audit for `corp_id` + `ship_id` correctness:
    - `transfer_warp_power/index.ts`
    - `recharge_warp_power/index.ts`
    - `dump_cargo/index.ts`
    - `ship_rename/index.ts`
    - `trade/index.ts` (pgEmitCharacterEvent)
    - `ship_purchase/index.ts`
    - `salvage_collect/index.ts`
    - `purchase_fighters/index.ts`
    - `bank_transfer/index.ts`
    - `transfer_credits/index.ts`
    - `combat_collect_fighters/index.ts`

Audit note (current main):
- `bank_transfer/index.ts` and `ship_purchase/index.ts` already pass `corpId`.
- `ship_rename/index.ts` personal-ship `status.update` omits `corpId` (fix required).

Implementation detail (client):
- On `status.update`:
  - If `player.id === personalPlayerId`, update personal store as usual.
  - Else if `player.player_type === "corporation_ship"`, update the matching entry in `ships.data`:
    - merge in `payload.ship` fields
    - set `sector = payload.sector?.id`
    - preserve `owner_type` and `current_task_id` already in `ships.data`
  - Else (other humans), ignore to avoid stomping UI.

### 3) Other non-player/ship-specific events (world/sector)
Events that should **not** be routed by player/ship identity:
- `port.update` (sector port state; broadcast to sector observers)
- `character.moved` (sector presence)
- `ship.destroyed` (sector + corp visibility)
- `chat.message` when broadcast (still not ship-specific)
- `garrison.character_moved` (server-side broadcast, not currently handled in client)

### 4) Rollout approach
We will update **server and client together**. No backward-compatible fallbacks.
This keeps client logic simple and avoids dual-shape handling.

## Plan
1. **Define payload identity rules**
   - Add `player.id` to all character-delivered events at the emission layer (`name` optional).
   - Add `ship_id` to ship-specific events that lack it.

2. **Server updates**
   - Add emission-layer injection of `player.id` + `ship_id` in `emitCharacterEvent` and `pgEmitCharacterEvent`
     (no call-site changes required; preserve richer `player` blocks when present).
   - Add `ship_id` where missing for **character-delivered** ship-specific events (e.g., `course.plot`, `movement.start`, `garrison.*`, `salvage.*`, `combat.*`).
   - Audit `status.update` emitters to ensure `corp_id` + `ship_id` are set for **corp ships**
     (so existing polling delivers them). No new broadcast layer needed.
   - Fix missing `corpId` in `ship_rename` personal-ship `status.update` emission
     (corp members should receive it).

3. **Client updates**
   - Update `client/app/src/types/messages.ts` (add `player` block + `ship_id` where appropriate).
   - Track `personalPlayerId` in store, set from **any** `status.snapshot` with
     `player.player_type === "human"` (not only join).
   - Update `client/app/src/GameContext.tsx` to route events by `player.id` (personal vs corp) and use `ship_id` when updating ship lists.
   - Apply the full Client Guard Table (all personal-state mutations are gated).
   - Ensure `sector.update` is **ID-guarded** (use `updateSector` or guard `setSector`).

4. **Docs + guardrails**
   - Update `docs/event_catalog.md` and alignment notes.
   - Add a small audit/check to flag events missing identity fields.

## Debug Logging Plan
- Edge functions: log when an event is emitted without `player.id` (after injection) or without `ship_id`
  for ship-specific character events.
- Pipecat bot: log when dropping events due to "other player" filters (movement.start/complete).
- Client: log when ignoring events due to identity guards, and warn when expected identity fields are missing.
- No feature flag for these logs (remove after rollout).

## Appendix: status.update emitters (line refs)
- `deployment/supabase/functions/recharge_warp_power/index.ts:270` — includes `shipId` + `corpId`
- `deployment/supabase/functions/bank_transfer/index.ts:577` — target deposit update; includes `shipId` + `corpId`
- `deployment/supabase/functions/bank_transfer/index.ts:601` — source deposit update; includes `shipId` + `corpId`
- `deployment/supabase/functions/bank_transfer/index.ts:747` — withdraw update; includes `shipId` + `corpId`
- `deployment/supabase/functions/combat_collect_fighters/index.ts:295` — includes `shipId` + `corpId`
- `deployment/supabase/functions/transfer_warp_power/index.ts:361` — sender update; includes `shipId` + `corpId`
- `deployment/supabase/functions/transfer_warp_power/index.ts:373` — recipient update; includes `shipId` + `corpId`
- `deployment/supabase/functions/ship_purchase/index.ts:272` — personal purchase update; includes `shipId` + `corpId`
- `deployment/supabase/functions/ship_purchase/index.ts:433` — corp purchase update; includes `shipId` + `corpId`
- `deployment/supabase/functions/transfer_credits/index.ts:379` — sender update; includes `shipId` + `corpId`
- `deployment/supabase/functions/transfer_credits/index.ts:391` — recipient update; includes `shipId` + `corpId`
- `deployment/supabase/functions/purchase_fighters/index.ts:312` — includes `shipId` + `corpId`
- `deployment/supabase/functions/salvage_collect/index.ts:497` — includes `shipId` + `corpId`
- `deployment/supabase/functions/dump_cargo/index.ts:291` — includes `shipId` + `corpId`
- `deployment/supabase/functions/trade/index.ts:374` — uses `pgEmitCharacterEvent`, includes `shipId` + `corpId`
- `deployment/supabase/functions/ship_rename/index.ts:293` — **missing `corpId`** (fix required)
## Out of Scope (Follow-ups)
- Map visited coloring cleanup (legend + map detail panel + `visited_corp` styling).
- Combat event naming reconciliation (`combat.action_accepted` vs `combat.action_response`).

## Pre-Implementation Questions
Event Identity & Routing
1. **Decision:** we do **not** require `ship_id` on *all* events. We will ensure ship identity for
   **character-delivered, ship-specific** events only. Other event types may remain without `ship_id`.
2. **Decision:** ignore corp-mate human `status.update` events in UI for now.

Emission Layer Injection
1. **Decision:** keep injection at `player.id` only (no call-site changes). `player.name` remains optional
   and is preserved when already present in payloads.
2. **Decision:** no injection for `emitSectorEvent` or `recordEventWithRecipients`; those events are explicitly exempt.

Client State Ownership
1. **Decision:** route by `player.id`, store by `ship_id`.
2. **Decision:** no per-ship sector snapshots for now.

Risk of UI Corruption
1. **Decision:** guard *all* personal-state mutations per the Client Guard Table.
2. **Decision:** corp ships do **not** need `movement.start` / `movement.complete` delivered to the client.

Server Coverage
1. **Decision:** no `status.update` emitters bypass `emitCharacterEvent` / `pgEmitCharacterEvent`.
2. **Audit complete:** no corp-ship `status.update` emitters missing `corp_id` or `ship_id` found.
   - Only gap observed: `ship_rename` personal-ship `status.update` lacks `corpId` (will fix).

Rollout / Testing
1. **Decision:** skip formal QA checklist for now.
2. **Decision:** add debug logging without a feature flag during rollout (remove later).

## Client Guard Table (Event -> UI Routing)
Purpose: prevent corp-ship and corp-mate updates from stomping personal UI while still updating corp ship panels.

Legend:
- **Personal** = apply to player/ship/sector state.
- **Corp ship** = update `ships.data` only.
- **Ignore** = no UI mutation.
- **Sector-guarded** = apply only if `payload.sector.id` matches current sector.

Personal-state mutations (must be gated)
- `status.snapshot` / `status.update`
  - Personal if `payload.player.id === personalPlayerId`
  - Corp ship if `payload.player.player_type === "corporation_ship"`
  - Ignore other humans
- `movement.start` / `movement.complete`
  - Personal only (requires `payload.player.id === personalPlayerId`)
- `course.plot` / `path.region`
  - Personal only (requires `payload.player.id === personalPlayerId`)
- `map.region` / `map.local`
  - Personal only (requires `payload.player.id === personalPlayerId`)
- `bank.transaction`
  - Personal only (`payload.character_id === personalPlayerId` or injected `player.id`)
- `trade.executed`, `salvage.created`, `salvage.collected`, `warp.purchase`
  - Personal only (requires `payload.player.id === personalPlayerId`)
- `warp.transfer` / `credits.transfer`
  - Personal only (match player via `from.id` / `to.id` or injected `player.id`)
- `combat.round_waiting`
  - Personal only if `payload.participants` includes `personalPlayerId`
- `combat.round_resolved` / `combat.ended`
  - Personal only if `payload.actions` includes `personalPlayerId` or matches active combat id
- `combat.action_response`
  - Personal only (match combat session or actor id if present)

World / sector updates (sector-guarded)
- `sector.update`
  - Apply only if `payload.id === gameStore.sector?.id` (use `updateSector` or guard `setSector`)
- `port.update`
  - Already guarded via `updateSector` (ID match), keep as-is
- `character.moved`
  - Sector players / activity log only if `payload.sector === current sector`
  - Always update `ships.data` by `ship_id` (corp ship position icons)
    - `character.moved` payloads already include `ship.ship_id` (emitted via movement observers),
      so no additional injection is required.

Corp ship list updates (always apply)
- `ships.list` → `gameStore.setShips`
- `corporation.ship_purchased` → `gameStore.addShip`

Events safe to leave unguarded
- `map.update` (merged corp knowledge update)
- `corporation.*` events (corp state)
- `chat.message`
- `task.*` (task list is already ship-tagged)
