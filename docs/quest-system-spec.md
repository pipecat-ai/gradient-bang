# Quest System Spec (Event-Driven, Postgres-Native)

## Status
- Proposed
- Date: 2026-02-20
- Scope: Quest progress tracking, completion, rewards, and client updates

## Problem
We want quests driven by player actions already present in the event stream, without adding expensive per-action quest reads/writes inside gameplay edge functions, and without introducing new infrastructure (queues, workers) until scale demands it.

## Key Decisions From Design Discussion
1. Quest state is server-authoritative.
2. Edge functions do not execute quest logic inline — they write events as they already do.
3. Quest evaluation runs inside Postgres via a trigger on the `events` table, requiring zero changes to existing edge functions.
4. All quest logic lives in a single Postgres function (`evaluate_quest_progress`) that early-exits for non-matching events.
5. Client-side quest checks are optional UX hints only, not authoritative completion.
6. Connected players are notified through the existing event system (quest events emitted like any other game event).
7. Quest completion events flow through the existing event pipeline — no separate delivery mechanism needed. Voice/NPC systems can react to `quest.step_completed` and `quest.completed` events like any other game event.

## Goals
- Zero changes to existing edge functions.
- Keep gameplay edge function latency unchanged for non-quest-relevant events.
- Avoid N-quest checks on every action — use indexed subscription routing for O(1) event-type lookups.
- Ensure idempotent, reliable quest progression.
- Support realtime updates for connected clients via existing event infrastructure.

## Non-Goals
- Full narrative authoring DSL in first version.
- Real-time strict ordering guarantees across all quest types.
- Trusting client-reported completion for rewards.
- External queue infrastructure (pgmq) in v1.

## Concepts

### Quest
A top-level unit of work visible in the player's quest log. Examples: "Tutorial", "Merchant's Guild", "Deep Space Explorer". A quest is assigned to a player through various triggers — character creation, NPC interaction, game events, or admin action. A quest contains one or more sequential **sub-quests**.

### Sub-Quest
A single step within a quest. Sub-quests are sequential — completing sub-quest 1 reveals sub-quest 2. Each sub-quest has its own evaluation criteria (event type, filter, target value). Only the current (lowest incomplete) sub-quest is actively evaluated.

### Player's Quest Log
A player can have multiple quests active simultaneously, each progressing independently at its own current sub-quest:

```
Player's Quest Log:
  ├─ Tutorial (auto-assigned on character creation)
  │    ├─ ✅ Travel to any adjacent sector
  │    ├─ → Locate the Megaport              ← current step
  │    ├─ 🔒 Refuel your ship
  │    └─ 🔒 ...
  │
  ├─ Merchant's Guild (assigned by NPC interaction)
  │    ├─ → Find the guild headquarters      ← current step
  │    └─ 🔒 ...
  │
  └─ Explorer (assigned by NPC interaction)
       ├─ ✅ Visit 10 sectors
       ├─ → Explore all of fedspace          ← current step
       └─ 🔒 ...
```

## High-Level Architecture

```
Edge Functions (unchanged)
       │
       ▼
   events table  ←── AFTER INSERT trigger
       │
       ▼
   evaluate_quest_progress()   (single Postgres function)
       │
       ├─→ player_quests / player_quest_steps   (progress state)
       └─→ events table   (quest.step_completed, quest.completed events)
```

1. Gameplay edge function writes normal game event(s) — no changes needed.
2. AFTER INSERT trigger on `events` calls `evaluate_quest_progress(NEW.id)`.
3. Function does one indexed lookup on `quest_event_subscriptions`. For ~75% of event types, this returns empty and exits immediately (microseconds).
4. For matching events, function finds active player quests whose current sub-quest matches, evaluates filters, updates progress — all in-process inside Postgres with zero network round trips.
5. On sub-quest completion, function advances the quest to the next sub-quest and emits a `quest.step_completed` event.
6. On final sub-quest completion, function marks the quest as `completed` and emits a `quest.completed` event.

## Why This Over a Worker/Queue

- **Zero network round trips** — all quest logic runs in-process inside Postgres. What would be 5-6 queries over the network from a worker is a single function call with indexed joins.
- **Zero new infrastructure** — no queue (pgmq), no worker process, no poller to monitor.
- **Zero edge function changes** — trigger fires automatically on every event insert.
- **Atomic consistency** — quest progress updates are in the same transaction as the triggering event.
- **Early exit is cheap** — non-matching events cost one indexed lookup returning zero rows (microseconds).
- **No "multiple players" scaling concern** — each event belongs to one player, so 50 players moving simultaneously means 50 independent trigger invocations, each doing one indexed lookup. They don't compound.

## Scaling Path: LISTEN/NOTIFY

If trigger overhead on the `events` table ever becomes measurable under load:

1. Replace the trigger body with a lightweight `NOTIFY quest_events, event_id`.
2. Run a small always-on connection (edge function cron or minimal service) that `LISTEN`s on the channel.
3. On notification, call `evaluate_quest_progress(event_id)`.

This decouples quest evaluation from the event write transaction while keeping the same single-function architecture. The event write becomes near-zero overhead (NOTIFY is ~0.01ms), and quest evaluation happens asynchronously at ms-scale latency.

If LISTEN/NOTIFY proves insufficient, the next step would be pgmq + a TaskAgent worker draining the queue in batches — but the same `evaluate_quest_progress` function is reused regardless of what calls it.

## Runtime Components

### 1) Gameplay Edge Functions
Responsibilities (unchanged):
- Validate and apply gameplay action.
- Persist gameplay event to `events` table.

Do not:
- Know about quests at all.
- Call any quest-related functions.
- Enqueue quest jobs.

### 2) Quest Trigger + Evaluation Function
- AFTER INSERT trigger on `events` table.
- Calls `evaluate_quest_progress(event_id)`.
- Function handles all quest logic in a single database call.

### 3) Player Realtime Delivery
Pattern:
- `evaluate_quest_progress` inserts `quest.step_completed` and `quest.completed` events into the `events` table.
- These flow through the existing event delivery pipeline (Pipecat RTVI) to connected clients.
- No separate notification table or channel needed.

## Data Model (v1)

### Quest Authoring

- `quest_definitions` — top-level quests
  - `id` UUID PK
  - `code` TEXT UNIQUE — machine-readable identifier (e.g., `tutorial`)
  - `name` TEXT — display name (e.g., "Tutorial")
  - `description` TEXT
  - `assign_on_creation` BOOLEAN DEFAULT false — auto-assign to new characters
  - `is_repeatable` BOOLEAN DEFAULT false
  - `enabled` BOOLEAN DEFAULT true

- `quest_step_definitions` — sequential sub-quests within a quest
  - `id` UUID PK
  - `quest_id` UUID FK → quest_definitions
  - `step_index` INT — position within quest (1, 2, 3...)
  - `name` TEXT — display name (e.g., "Travel to any adjacent sector")
  - `description` TEXT
  - `eval_type` TEXT — `count` | `count_filtered` | `aggregate` | `unique_count`
  - `event_types` TEXT[] — array of matching event types (e.g., `{movement.complete}` or `{corporation.created, corporation.member_joined}`)
  - `target_value` NUMERIC — threshold for completion (count=1, aggregate=2000, unique_count=847)
  - `payload_filter` JSONB — predicate matched against event payload (e.g., `{"ship_type": "kestrel_courier"}`)
  - `aggregate_field` TEXT — payload key for aggregate eval (e.g., `profit`)
  - `unique_field` TEXT — payload key for unique_count eval (e.g., `sector_id`)
  - `enabled` BOOLEAN DEFAULT true
  - UNIQUE (`quest_id`, `step_index`)

### Routing/Optimization
- `quest_event_subscriptions`
  - `event_type` TEXT
  - `step_id` UUID FK → quest_step_definitions
  - PRIMARY KEY (`event_type`, `step_id`)
  - Purpose: one indexed lookup maps an event type to candidate sub-quest steps. Populated when quest definitions are created/updated.

### Player State

- `player_quests` — which quests a player has been assigned
  - `id` UUID PK
  - `player_id` UUID FK → characters
  - `quest_id` UUID FK → quest_definitions
  - `status` TEXT — `active` | `completed` | `claimed` | `failed`
  - `current_step_index` INT DEFAULT 1 — which sub-quest the player is on
  - `started_at` TIMESTAMPTZ DEFAULT now()
  - `completed_at` TIMESTAMPTZ
  - `claimed_at` TIMESTAMPTZ
  - UNIQUE (`player_id`, `quest_id`) for non-repeatable quests

- `player_quest_steps` — progress on each sub-quest step
  - `id` UUID PK
  - `player_quest_id` UUID FK → player_quests
  - `step_id` UUID FK → quest_step_definitions
  - `current_value` NUMERIC DEFAULT 0 — progress toward target
  - `completed_at` TIMESTAMPTZ
  - `last_event_id` BIGINT — last event that updated this step
  - `unique_values` JSONB DEFAULT '[]' — tracks distinct values for `unique_count` eval type

### Reliability/Idempotency
- `quest_progress_events`
  - `event_id` BIGINT
  - `player_id` UUID
  - `step_id` UUID
  - `applied_at` TIMESTAMPTZ DEFAULT now()
  - UNIQUE (`event_id`, `player_id`, `step_id`) — prevents double-application on reprocessing

## Processing Algorithm (v1)

`evaluate_quest_progress(p_event_id BIGINT)` — called by AFTER INSERT trigger:

```
1. Load event row by p_event_id.

2. SELECT matching step definitions from quest_event_subscriptions
   WHERE event_type = event.event_type
   JOIN quest_step_definitions WHERE enabled = true.

   → If no rows: RETURN (early exit — most events stop here).

3. For each matching step definition:

   a. Find active player quest where this step is the CURRENT step:
      SELECT pq.*, pqs.*
      FROM player_quests pq
      JOIN player_quest_steps pqs ON pqs.player_quest_id = pq.id
      JOIN quest_step_definitions qsd ON qsd.id = pqs.step_id
      WHERE pq.player_id = event.character_id
        AND pq.status = 'active'
        AND pqs.step_id = matching_step_id
        AND qsd.step_index = pq.current_step_index
        AND pqs.completed_at IS NULL

      → If not found: CONTINUE (player doesn't have this quest,
        or isn't on this step yet).

   b. Idempotency check:
      INSERT INTO quest_progress_events (event_id, player_id, step_id)
      ON CONFLICT DO NOTHING.
      → If no insert: CONTINUE (already processed).

   c. Evaluate payload_filter against event.payload:
      Check each key/value in filter JSONB against event payload.
      → If no match: CONTINUE.

   d. Update progress based on eval_type:
      - count / count_filtered: current_value += 1
      - aggregate: current_value += payload->>aggregate_field
      - unique_count:
          Extract value at unique_field from payload.
          If not in unique_values array, append and current_value += 1.

   e. Set last_event_id = p_event_id.

   f. If current_value >= target_value:
      Set step completed_at = now().
      Emit quest.step_completed event.

      Check if there is a next step (step_index + 1):
      → If YES:
          Advance player_quests.current_step_index += 1.
          Create player_quest_steps row for the next step.
      → If NO (final step):
          Set player_quests.status = 'completed', completed_at = now().
          Emit quest.completed event.
```

Important: the trigger must not re-fire on quest event inserts (step f). Filter the trigger:
```sql
CREATE TRIGGER quest_eval_trigger
  AFTER INSERT ON events
  FOR EACH ROW
  WHEN (NEW.event_type NOT LIKE 'quest.%')
  EXECUTE FUNCTION trigger_evaluate_quest_progress();
```

## Quest Assignment

### How quests are assigned

Quests enter a player's quest log through `assign_quest(p_player_id, p_quest_code)`, which:
1. Looks up the quest definition by code.
2. Creates a `player_quests` row with `status = 'active'`, `current_step_index = 1`.
3. Creates a `player_quest_steps` row for only the first sub-quest step.
4. Subsequent steps are created on-the-fly as each step completes (in `evaluate_quest_progress`).

### Assignment triggers

| Trigger | Example | Mechanism |
|---------|---------|-----------|
| Character creation | Tutorial quest | `assign_quest` called in `character_create` / `user_character_create` edge function |
| NPC interaction | Merchant's Guild | Edge function for NPC dialogue calls `assign_quest` |
| Game event | Unlock quest after milestone | `evaluate_quest_progress` calls `assign_quest` on quest completion (quest A completing assigns quest B) |
| Admin action | Seasonal event quest | Admin endpoint or migration calls `assign_quest` for target players |
| Future: quest givers | Story quests | Any edge function can call `assign_quest` when conditions are met |

### Issuing new quests after launch

To add a new quest:
1. INSERT into `quest_definitions` + `quest_step_definitions` + `quest_event_subscriptions` (migration or admin tool).
2. Assign to players via one of the triggers above.
3. No code changes, no deploys — quest definitions are pure data.

To append steps to an existing quest:
1. INSERT new `quest_step_definitions` rows with higher `step_index` values.
2. Players currently on the quest will naturally progress into the new steps.
3. Players who already completed the quest are unaffected (status = `completed`).

## Example Quest Definitions

### Tutorial Quest

Quest: `tutorial` — "Getting Started"

| Step | Name | eval_type | event_types | target | filter/field |
|------|------|-----------|-------------|--------|-------------|
| 1 | Travel to any adjacent sector | `count` | `{movement.complete}` | 1 | — |
| 2 | Locate the Megaport | `count_filtered` | `{movement.complete}` | 1 | `{"has_megaport": true}` |
| 3 | Refuel your ship | `count` | `{warp.purchase}` | 1 | — |
| 4 | Purchase a commodity | `count` | `{trade.executed}` | 1 | — |
| 5 | Earn 2000 credits trading | `aggregate` | `{trade.executed}` | 2000 | field: `profit` |
| 6 | Deposit 2000 credits into the megabank | `count_filtered` | `{bank.transaction}` | 1 | `{"amount_gte": 2000}` |
| 7 | Purchase a kestrel | `count_filtered` | `{ship.traded_in}` | 1 | `{"ship_type": "kestrel_courier"}` |
| 8 | Create or join a corporation | `count` | `{corporation.created, corporation.member_joined}` | 1 | — |
| 9 | Run a task on a corp ship | `count` | `{task.start}` | 1 | `{"ship_owner": "corporation"}` |

### Achievement Quests (standalone, assigned via NPC or admin)

Quest: `explorer` — "Deep Space Explorer"

| Step | Name | eval_type | event_types | target | field |
|------|------|-----------|-------------|--------|-------|
| 1 | Explore all of fedspace | `unique_count` | `{movement.complete}` | (total fed sectors) | `sector_id`, filter: `{"region": "fedspace"}` |
| 2 | Find all the megaports | `unique_count` | `{movement.complete}` | (total megaports) | `sector_id`, filter: `{"has_megaport": true}` |
| 3 | Have a corp ship find 100 sectors outside fedspace | `unique_count` | `{movement.complete}` | 100 | `sector_id`, filter: `{"region_not": "fedspace", "is_corp_ship": true}` |

Quest: `trader` — "Master Trader"

| Step | Name | eval_type | event_types | target | field |
|------|------|-----------|-------------|--------|-------|
| 1 | Pair trade $5k profit in a single run | `aggregate` | `{trade.executed}` | 5000 | `profit`, filter: `{"task_type": "pair_trade"}` |

Quest: `warlord` — "Sector Warlord"

| Step | Name | eval_type | event_types | target | field |
|------|------|-----------|-------------|--------|-------|
| 1 | Take control of a sector by deploying fighters | `count` | `{garrison.deployed}` | 1 | — |

## Reward Claim Contract
Client calls `claim_quest_reward` edge function.
Server verifies atomically:
- quest exists and belongs to player,
- status is `completed`,
- reward not already claimed.

Then server:
- grants reward (credits, items, unlocks),
- sets `claimed_at` and status `claimed`,
- emits `quest.reward_claimed` event.

Never grant based only on client completion reports.

## Performance Characteristics

### Cost per event (non-matching, ~75% of events)
- One indexed lookup on `quest_event_subscriptions(event_type)` → 0 rows → return.
- Estimated overhead: <0.1ms.

### Cost per event (matching, player has active quest at this step)
- One indexed lookup on subscriptions.
- One indexed join to player_quests + player_quest_steps.
- One insert for idempotency check.
- One update for progress.
- Optionally: step completion + next step creation.
- Estimated overhead: 1-5ms.

### Cost per event (matching, player does NOT have this step active)
- One indexed lookup on subscriptions.
- One indexed join to player_quests + player_quest_steps → 0 rows → continue.
- Estimated overhead: <0.5ms.

### Indexes
- `quest_event_subscriptions (event_type)` — routing lookup
- `player_quests (player_id, status)` — find active quests
- `player_quest_steps (player_quest_id, step_id)` — find active steps
- `quest_progress_events (event_id, player_id, step_id) UNIQUE` — idempotency
- `quest_step_definitions (quest_id, step_index)` — find next step in sequence

## Failure Handling
- Trigger failure rolls back the event write transaction — the gameplay action appears to fail. This is intentional: quest logic bugs should not silently corrupt state.
- If this behavior is undesirable, wrap the trigger body in an exception handler that logs the error and returns without blocking the event write.
- Idempotency markers (`quest_progress_events` unique constraint) guarantee safe reprocessing if events are ever replayed.
- For the LISTEN/NOTIFY scaling path: failed evaluations can be retried by re-sending the notification or maintaining a high-water mark cursor.

## Security
- Quest evaluation runs in trigger context (superuser/service role) — no RLS bypass needed.
- Clients can read only their own quest/notification records via RLS on `player_quests`, `player_quest_steps`.
- `claim_quest_reward` endpoint validates ownership and completion server-side.
- Quest definition tables are read-only for clients (admin-managed).

## Observability
Track via Postgres function logging or application queries:
- Quest completion throughput (count of `quest.completed` events per period).
- Step completion rate by quest and step.
- Trigger execution time (via `pg_stat_user_functions` if `track_functions = 'all'`).
- Failed evaluations (logged exceptions if using exception handler approach).

Log structured fields in function:
- `event_id`, `player_id`, `quest_id`, `step_id`, `eval_type`, `progress_delta`, `new_value`.

## Rollout Plan
1. **Schema migration** — Create quest tables, indexes, `evaluate_quest_progress` function, trigger, and `assign_quest` helper.
2. **Seed tutorial quest** — Insert quest definition + 9 step definitions + event subscriptions.
3. **Quest assignment** — Call `assign_quest` in character creation edge functions (assigns tutorial quest step 1 only).
4. **Client UI** — Quest log panel reading `player_quests` + `player_quest_steps` joined to definitions.
5. **Expand eval types** — Add `count_filtered`, `aggregate`, `unique_count` support (start with `count` only).
6. **Achievement quests** — Add explorer/trader/warlord quest definitions, assigned via NPC or admin.
7. **Reward claim endpoint** — `claim_quest_reward` edge function.
8. **Scaling (if needed)** — Swap trigger for LISTEN/NOTIFY approach.

## Open Implementation Choices
1. **Trigger failure behavior:**
   - Recommended: let trigger failure roll back the event write (strict consistency).
   - Alternative: exception handler that logs and continues (availability over consistency).
2. **Payload filter evaluation:**
   - Simple key/value matching with optional operators (`_gte`, `_lte`, `_not`, `_in`).
   - Or: full JSONB containment (`payload @> filter`).
3. **Step creation strategy:**
   - Recommended: create only the current step's `player_quest_steps` row; create the next on completion (lazy).
   - Alternative: create all steps upfront, only evaluate the current one (eager).

## Minimal v1 Acceptance Criteria
- AFTER INSERT trigger on `events` calls `evaluate_quest_progress`.
- Function correctly evaluates `count` sub-quest steps and updates progress.
- Step completion advances the quest to the next step (creates `player_quest_steps` row).
- Final step completion marks the quest as `completed`.
- Idempotency prevents double-counting on reprocessed events.
- `assign_quest(player_id, quest_code)` creates initial quest + first step for any quest.
- Quest events (`quest.step_completed`, `quest.completed`) flow through existing event pipeline.
- Non-matching events add <0.1ms overhead to event writes.
