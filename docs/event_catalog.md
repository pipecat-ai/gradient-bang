# Event Catalog (Supabase)

This catalog describes events emitted by Supabase edge functions. **Source of truth** is the edge-function code under `deployment/supabase/functions/**` and the shared emit helpers in `deployment/supabase/functions/_shared/events.ts`.

## Where Events Come From
- Edge functions emit events by calling the helpers in `_shared/events.ts`.
- Event payloads are built in shared helpers such as:
  - `_shared/status.ts` (status snapshots + player/ship payloads)
  - `_shared/map.ts` (map/local/sector payloads)
  - `_shared/combat_*` (combat participants + outcomes)
  - `_shared/corporations.ts` (corporation payloads)

## Common Event Types
These are the primary events consumed by the voice agent and NPC tooling (see `src/gradientbang/pipecat_server/voice_task_manager.py`).

- `status.snapshot`
- `status.update`
- `sector.update`
- `course.plot`
- `path.region`
- `movement.start`
- `movement.complete`
- `map.knowledge`
- `map.region`
- `map.local`
- `map.update`
- `ports.list`
- `character.moved`
- `trade.executed`
- `port.update`
- `fighter.purchase`
- `warp.purchase`
- `warp.transfer`
- `credits.transfer`
- `garrison.deployed`
- `garrison.collected`
- `garrison.mode_changed`
- `salvage.collected`
- `salvage.created`
- `bank.transaction`
- `combat.round_waiting`
- `combat.round_resolved`
- `combat.ended`
- `combat.action_accepted`
- `ship.destroyed`
- `ship.renamed`
- `corporation.created`
- `corporation.ship_purchased`
- `corporation.member_joined`
- `corporation.member_left`
- `corporation.member_kicked`
- `corporation.disbanded`
- `chat.message`
- `event.query`
- `ships.list`
- `task.start`
- `task.finish`
- `task.cancel`
- `error`

## Updating This Catalog
If you add or rename events:
1. Update the emitting edge function(s).
2. Add the new event type to `VoiceTaskManager._event_names` if the voice agent should consume it.
3. Update this list if the event is user-facing.
