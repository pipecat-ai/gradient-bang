# Supabase Events + RLS Delivery Plan

## 🚀 Quick Start: Current Status (2025-11-11)

**✅ WORKING:** Cloud deployment with postgres_changes realtime delivery
- **Deployed functions:** `join`, `move`, `my_status`, `get_character_jwt`
- **First passing test:** `test_move_to_adjacent_sector` - full payload parity verified
- **Key fixes:** Awaited async completion, postgres_changes payload extraction, event format transformation, duplicate emission removal

**🔧 To deploy next function:**
```bash
# 1. Implement in supabase/functions/<name>/index.ts
# 2. Deploy to cloud
npx supabase functions deploy <name> --project-ref pqmccexihlpnljcjfght --no-verify-jwt

# 3. Test locally (if needed)
source .env.cloud && uv run pytest tests/integration/test_game_server_api.py::test_<name> -xvs

# 4. Run payload parity comparison
source .env.cloud && uv run python scripts/double_run_payload_parity.py tests/integration/test_game_server_api.py::test_<name>
```

**📋 Next priorities:**
1. `trade` - Buy/sell commodities at ports
2. `recharge_warp_power` - Refuel at sector 0
3. Combat functions (`combat_action`, `combat_initiate`)
4. Corporation functions

**⚠️ Remember:**
- Always `await` delayed operations (no fire-and-forget setTimeout)
- Use `emitCharacterEvent()` for direct events, `emitSectorEnvelope()` only for sector broadcasts
- Avoid duplicate emissions (character receives sector broadcasts automatically)
- Test with authentic delays (don't scale down timeouts)

---

## 0. Executive Summary
**Problem.** Movement and corp RPCs currently fan out one HTTP POST per recipient via Supabase Realtime Broadcast. A single move in a 30-character sector emits ~90 POSTs in <200 ms (depart + arrive, sector + observer envelopes, garrison fan-out). With retries every 40 ms, the burst exceeds Supabase’s per-project quota (≈100 msg/s on Free, 500 msg/s on Pro), producing `429 Too Many Requests` and dropping events even though the app-level rate limiter never trips.

**Solution.** Make the `public.events` table the single source of truth for both history (`event_query`) and realtime by:
- Logging every outbound event once, along with normalized recipient rows that encode who may see it.
- Enforcing visibility through Postgres row-level security (RLS) so Supabase’s `postgres_changes` feed delivers only rows the subscriber is allowed to read.
- Subscribing clients to the RLS-protected `public.events` changefeed with per-character JWTs while API queries continue to use the `visible_events` view.

**Benefits.**
- Eliminates HTTP fan-out: one INSERT → Supabase handles delivery internally.
- Reuse exact same authorization rules for replay and realtime; no more divergence.
- Server-side enforcement prevents client tampering and makes “who saw what?” auditable.
- Removes ~300 lines of broadcast plumbing and its retry storm failure modes.

**Success criteria.**
1. No `429` errors while running the corporation move loop (100 moves/sec with 30 observers).
2. Move RPC latency stays <100 ms with 50 recipients because we only insert once.
3. `event_query` JSON matches realtime payloads byte-for-byte for the same request window.
4. Unauthorized subscribers fail to receive rows even when they can open a websocket.
5. Storage/index growth stays within +200 MB per additional million events (see §9).

**Rate-limit comparison.**
```
Today: 30 observers × 2 events (depart/arrive) + garrison fan-out ≈ 90 POSTs
With retries (×3) → up to 270 HTTP requests in <0.2 s
Supabase quota: 100–500 messages/sec/project → throttled
New design: 1 INSERT into events + internal WAL fan-out → 1 database write
```

**Realtime flow (textual diagram).**
```
[Edge Function]
  └─ logEvent(payload) + insert recipient rows
          ↓
  PostgreSQL WAL + RLS
          ↓
  Supabase Realtime (postgres_changes)
          ↓
  Client websocket authenticated with character JWT
```
Supabase’s changefeed enforces RLS before emitting each row, so the same records back both live delivery and replay.

## 1. Objectives
- Replace per-topic HTTP broadcasts with a single authoritative `events` stream governed by RLS.
- Guarantee realtime delivery and historical replay consume identical rows and filters.
- Enforce all visibility scopes (sector, garrison, corp, direct/BCC, broadcast, self/system, admin) on the server.
- Maintain compatibility with existing RPC contracts while reducing Realtime load to O(1) inserts per RPC.

## 2. Functional Requirements
1. **Visibility scopes** — sector-local, remote assets (garrisons/drones), corp-wide, direct, broadcast, GM/admin broadcast, self/system.
2. **Admin broadcast utility** — ops staff can emit a broadcast with an arbitrary `from_display_name` (no backing `actor_character_id`) via a locked-down endpoint.
3. **Corp messaging** — any player may send messages to their own corporation, but never to a corp they’re not a member of; server must enforce membership before inserting recipients.
4. **Latency & durability** — inserts <10 ms/event; changefeed latency <1 s; events stay queryable via `event_query` for the existing retention window.
5. **Auditability** — answer “why did character X see event Y?” by inspecting normalized recipient rows.
6. **Fairness** — visibility snapshot occurs at insert time; later moves or corp changes do not retroactively expose or hide past events. All authorization checks reference the frozen recipient rows, never the character’s current game state.

## 3. Architecture & Flow
1. Edge function builds payload (unchanged) and calls `record_event(...)`.
2. `record_event` inserts into `public.events` and writes to the appropriate recipient tables (`event_character_recipients`, plus `event_broadcast_recipients` when needed).
3. No HTTP broadcast occurs. Supabase captures the INSERT from WAL and evaluates RLS per subscriber.
4. Clients subscribe to `postgres_changes` on `public.events` using per-character JWTs issued by a new `get_character_jwt` RPC.
5. `event_query` runs a normal SELECT over the same view.

### CLI & Environment Notes
- Use `npx supabase` for all local Supabase CLI commands (start/stop/db push); no global install is required for this repo.
- Source `.env.supabase` via `set -a && source .env.supabase && set +a` before running CLI commands so `SUPABASE_URL`, service-role keys, and JWT secrets are present in the shell.
- When running the edge runtime locally, call `scripts/start_supabase_functions.sh` instead of invoking `npx supabase functions serve` directly; the wrapper sources `.env.supabase`, redirects logs to `logs/cli-functions.log`, detaches the process, and records its PID for easy teardown.
- To completely stop the local stack (CLI services + stray containers/processes), run `cd ~/src/gb-supa/supabase && npx supabase stop && docker stop $(docker ps -q --filter "name=supabase") 2>/dev/null ; ps aux | grep supabase | grep -v grep | awk '{print $2}' | xargs kill -9 2>/dev/null`.

### Current Status (2025-11-11)
**✅ Cloud postgres_changes verified working:**
- Schema, RLS policies, and ES256 JWT signing deployed to cloud project `pqmccexihlpnljcjfght`
- Custom character JWTs authenticate correctly (`auth.uid()` returns character ID)
- postgres_changes delivery confirmed working with RLS enforcement
- `SupabaseRealtimeListener` updated to parse postgres_changes payload structure (`change['data']['record']`)

**✅ Payload assertion helpers complete:**
- `tests/helpers/payload_assertions.py` implemented with comparers for:
  - `status.snapshot` - player/ship/sector comparison with canonical UUID mapping
  - `movement.start` and `movement.complete` - movement event payloads
  - `map.local` - map region data with sector graph structure
  - UUID/legacy ID mapping via `canonicalize_character_id`
- Ready for payload parity testing once test infrastructure supports cloud deployment

**✅ Edge functions migrated to RLS events:**
- `move` - emits via `emitCharacterEvent`, `emitSectorEnvelope`, `emitMovementObservers`
- `join` - emits via `emitCharacterEvent`, `emitMovementObservers`
- All functions use `recordEventWithRecipients` → single INSERT with recipient snapshots
- Events being written to database correctly (verified via direct queries)

**✅ Local environment configured:**
- Added ES256 JWT signing key to `.env.supabase:18`
- Local edge functions server can generate character JWTs
- Database writes working correctly (events table + recipient tables populated)

**❌ Local CLI postgres_changes still broken:**
- Supabase CLI v2.54.11 has a bug where `postgres_cdc_rls` extension doesn't start
- Replication slot `supabase_realtime_replication_slot` remains inactive
- Database configuration is correct (WAL, publication, REPLICA IDENTITY FULL)
- This is a known CLI issue affecting multiple versions; no easy local fix available

## ✅ CLOUD DEPLOYMENT SUCCESS (2025-11-11)

### Completed Milestones
1. ✅ **Edge Functions with delayed events** - Move function waits for 2s movement completion before responding
2. ✅ **Postgres_changes realtime delivery** - Events delivered via changefeed to authenticated clients
3. ✅ **Payload parity infrastructure** - Tests compare legacy vs Supabase event payloads
4. ✅ **Cloud database seeding** - Direct PostgreSQL connection via IPv4 add-on working
5. ✅ **Test fixtures for cloud** - Integration tests run against cloud deployment

### Critical Bugs Fixed

#### Bug #1: Edge Functions terminated before delayed events emitted
**Problem**: `move` function only emitted 3/6 events (missing `movement.complete` + post-movement events)
**Root cause**: `scheduleMovementCompletion()` used fire-and-forget async IIFE with `setTimeout`
**Solution**: Converted to `await completeMovement()` - function waits for full operation before responding
**Impact**: Client waits ~2s for move response but receives ALL events via realtime
**Lesson learned**: Edge Functions can handle long-running requests (150s idle timeout) - use `await` for delayed operations

#### Bug #2: Realtime listener received 0 events despite database writes
**Problem**: `payload_parity` fixture captured events from DB but `listener.events` was empty
**Root cause**: EventListener extracted `change["new"]` but postgres_changes nests payload as `change["data"]["new"]`
**Solution**: Updated `_handle_supabase_change()` to extract from correct nested structure
**Lesson learned**: Postgres_changes payload structure differs from direct WebSocket events

#### Bug #3: Events received but test assertions failed
**Problem**: Listener received 6 database records but `event.get("type")` returned `None`
**Root cause**: Database records have `event_type` field but tests expect `type` field (legacy format)
**Solution**: Added transformation in `_handle_supabase_change()` to convert database records to legacy event format
**Lesson learned**: Realtime listeners need to transform database schema to match application event format

#### Bug #4: Duplicate events delivered (8 instead of 6)
**Problem**: Move function emitted `movement.complete` and `map.local` via BOTH `emitCharacterEvent` and `emitSectorEnvelope`
**Root cause**: Character receives sector broadcasts for their own sector, creating duplicates
**Solution**: Removed redundant `emitSectorEnvelope()` calls - only emit direct to character
**Lesson learned**: Don't broadcast events to sector if already sending direct to character in that sector

### Architecture Patterns Validated

**Pattern: Long-Running Edge Functions**
- Edge Functions can await async operations (tested up to 2 seconds)
- 150s idle timeout allows for delayed event emission patterns
- Client experiences higher latency but guarantees event delivery
- Use case: Movement completion, combat rounds, timed operations

**Pattern: Event Format Transformation**
- Database schema (normalized): `event_type`, `payload` (JSONB), `scope`, `sector_id`, etc.
- Application format (legacy): `{type, payload, summary}`
- Transform in realtime listener: extract DB fields → reconstruct app format
- Keep transformation logic in one place (`_handle_supabase_change`)

**Pattern: Direct vs Broadcast Emissions**
- Use `emitCharacterEvent()` for events targeting specific character
- Use `emitSectorEnvelope()` only for events others in sector should see
- Never use both for same event to same character
- Character receives sector broadcasts automatically if in that sector

### Lessons Learned

**Edge Function Development:**
1. **Always `await` delayed operations** - Never use fire-and-forget async patterns with `setTimeout`
2. **Long-running requests are OK** - Edge Functions support 150s idle timeout, adequate for game mechanics
3. **Response latency reflects reality** - Client waiting 2s for move completion is more accurate than instant response
4. **Deploy early, deploy often** - Cloud deployments are fast (~5-10s), iterate rapidly with real postgres_changes

**Realtime Event Delivery:**
1. **postgres_changes payload structure** - Extract from `change["data"]["new"]`, not `change["new"]`
2. **Transform database schema to app format** - DB has `event_type`, app expects `type`
3. **Keep transformation centralized** - All conversion logic in `_handle_supabase_change()`
4. **RLS policies work automatically** - Character JWT authentication enforces visibility without extra code

**Event Emission Strategy:**
1. **Avoid duplicate emissions** - Check if character is in broadcast sector before using `emitSectorEnvelope`
2. **Direct events first** - Use `emitCharacterEvent` for character-specific data
3. **Sector broadcasts for observers** - Use `emitSectorEnvelope` only for multi-recipient notifications
4. **One database write per event** - Trust postgres_changes to handle delivery fan-out

**Testing & Validation:**
1. **Payload parity tests catch subtle bugs** - Event count mismatches revealed duplicate emissions
2. **Test with authentic delays** - Don't scale down timeouts; test production behavior
3. **Cloud testing is essential** - Local Supabase CLI has realtime bugs; cloud is ground truth
4. **Manual seeding for cloud tests** - Direct PostgreSQL connection (IPv4 add-on) enables test_reset on cloud

**Database Operations:**
1. **IPv4 add-on required** - Cloud databases are IPv6-only by default; need add-on for direct connections
2. **Connection string format matters** - Direct connection: `postgresql://postgres:PASSWORD@db.PROJECT.supabase.co:5432/postgres`
3. **Pooler has tenant issues** - Direct connection more reliable than Supavisor pooler for test resets
4. **Test data isolation** - Use `tests/test-world-data` (10 sectors) vs production `world-data` (5000 sectors)

### Development Workflow
**Local development (recommended for iteration):**
- ✅ Add/modify edge function logic
- ✅ Run tests that insert events into database
- ✅ Query `events` table directly to verify writes: `SELECT event_type, payload, scope FROM events WHERE character_id = '...' ORDER BY inserted_at DESC LIMIT 10;`
- ✅ Test RLS policies via authenticated queries
- ❌ **Cannot** test postgres_changes realtime delivery (CLI bug)

**Cloud deployment (required for end-to-end testing):**
1. Deploy functions: `npx supabase functions deploy <function_name> --project-ref pqmccexihlpnljcjfght --no-verify-jwt`
2. Run tests with cloud env: `set -a && source .env.cloud && set +a && uv run pytest tests/edge/test_*.py -xvs`
3. Verify realtime delivery with test scripts (e.g., `uv run python scripts/test_cloud_realtime_minimal.py`)
4. Run payload parity comparisons: `uv run python scripts/double_run_payload_parity.py tests/integration/test_*.py::test_name`

**Recommended cycle:**
- Iterate locally (fast): write function → run tests → query database → verify logic
- Deploy to cloud frequently: test realtime delivery → validate payload parity
- Cloud deployments are fast (~5-10 seconds per function)

### Next Steps: Edge Function Migration

**Completed Functions:**
- ✅ `join` - Character join/rejoin with status and map events
- ✅ `move` - Movement with delayed completion (2s hyperspace) - **PAYLOAD PARITY VERIFIED**
- ✅ `my_status` - Get current character status - **DEPLOYED 2025-11-11**
- ✅ `get_character_jwt` - JWT generation for realtime auth

**Milestone: First Payload Parity Test Passing (2025-11-11 08:02)**
- Test: `tests/integration/test_game_server_api.py::test_move_to_adjacent_sector`
- Events verified: `status.snapshot`, `map.local`, `movement.start`, `movement.complete`
- Result: ✅ "Payloads match; see step5 log for details"
- Significance: End-to-end validation of Supabase postgres_changes delivery with authentic delays

**Priority 1: Core Gameplay (next to migrate)**

2. **`trade`** - Buy/sell commodities at ports
   - Pattern: Direct event to character, update port state
   - Events: `trade.executed`, `port.update`
   - Complexity: Medium - port state updates, credit transfers

3. **`recharge_warp_power`** - Refuel at sector 0
   - Pattern: Direct event to character
   - Events: `warp.recharged`
   - Complexity: Low - simple credit/warp power exchange

**Priority 2: Combat System**
4. **`combat_action`** - Player combat actions (attack, flee, brace)
5. **`combat_initiate`** - Start combat encounter
6. **Combat garrison functions** - Deploy/collect/set mode

**Priority 3: Corporation System**
7. Corporation management functions (join, leave, kick, create, disband)
8. Corporation bank transfers

**Testing Strategy:**
- Deploy each function to cloud after local testing
- Run payload parity test: `source .env.cloud && uv run python scripts/double_run_payload_parity.py tests/integration/test_game_server_api.py::test_<function>`
- Verify event count matches legacy
- Check for duplicate events (direct vs sector broadcast)
- Ensure delayed operations use `await` pattern

**Deployment Checklist per Function:**
1. Implement edge function in `supabase/functions/<name>/index.ts`
2. Use `emitCharacterEvent()` for direct events
3. Use `await` for any delayed operations (no fire-and-forget setTimeout)
4. Avoid duplicate emissions (check if sector broadcast needed)
5. Deploy: `npx supabase functions deploy <name> --project-ref pqmccexihlpnljcjfght --no-verify-jwt`
6. Run integration test against cloud
7. Run payload parity comparison
8. Update this planning doc with results
   - `combat_*` endpoints (initiate, action, tick)
   - `trade` endpoint
   - `corporation_*` endpoints
   - Each should compute recipients and emit via `recordEventWithRecipients`
8. **FUTURE: AsyncGameClient migration**:
   - Update `utils/supabase_client.py` to use postgres_changes subscription
   - Remove legacy broadcast code
   - This can happen after payload parity is verified for all endpoints

## 4. Schema Changes
### 4.1 `public.events`
Keep existing columns and add:
- `scope text not null default 'direct' check (scope in ('direct','sector','corp','broadcast','gm_broadcast','self','system','admin'))` — routing hint.
- `actor_character_id uuid null` — character that triggered the event.
- `corp_id uuid null` — corp primarily referenced (auditing only).
- `inserted_at timestamptz default now()` — convenience ordering index (if not already present).
Visibility is expressed via recipient tables below (no arrays, which keeps indexes selective and audit tables queryable).

### 4.2 Recipient tables (both `ON DELETE CASCADE` back to `events(id)`)
| Table | Columns | Purpose |
| --- | --- | --- |
| `event_character_recipients` | `event_id uuid`, `character_id uuid`, `reason text` | One row per authorized character; `reason` tags (`sector_snapshot`, `corp_snapshot`, `direct`, etc.) describe why they can see it. |
| `event_broadcast_recipients` | `event_id uuid` | Flags events that should reach everyone without enumerating characters. |

Indexes:
- `create index on event_character_recipients (character_id, event_id);`
- `create index on event_broadcast_recipients (event_id);`
- `create index on events (actor_character_id, inserted_at);` for self/system filters.

**Snapshot procedure.** Every time an event is recorded we expand the applicable scopes directly into `event_character_recipients`, tagging each inserted row with a `reason` that indicates which scope granted visibility (e.g., `sector_snapshot`, `corp_snapshot`, `garrison_owner`). Because the tag lives next to the character row, downstream analytics can recover scope counts offline by grouping on `reason`; no extra sector/corp tables are required. Broadcasts still avoid per-character inserts by writing a single row to `event_broadcast_recipients`.

### 4.3 Helper functions
- `can_view_sector(p_character uuid, p_sector int) returns boolean` — true if character currently occupies the sector or owns garrisons there.
- `is_corp_member(p_character uuid, p_corp uuid) returns boolean` — wraps membership lookup (and can be optimized via materialized view later).
- `is_service_role()` — checks Supabase auth claims for service-role access.

### 4.4 Client-facing view
```sql
create view public.visible_events as
select
  e.id,
  e.event_type,
  e.payload,
  e.scope,
  e.actor_character_id,
  e.sector_id,
  e.corp_id,
  e.inserted_at,
  e.request_id,
  e.meta
from public.events e;
```
RLS policies stay on the base `public.events` table so the view inherits the same authorization rules while the recipient tables remain private.
Because Supabase publications currently accept tables only, realtime subscriptions point at `public.events` (with RLS) even though API queries continue to hit the `visible_events` view for stability.

## 5. Row-Level Security Policies
Enable `ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;` (policies must live on the base table—PostgreSQL automatically enforces them when clients query through `visible_events`) and add policies that reference only frozen data captured at insert time (no dynamic sector/corp lookups):
1. **Self/system** – `scope in ('self','system') AND actor_character_id = auth.uid()`.
2. **Direct / sector / corp / other scopes** – everything funnels through `event_character_recipients`, so a single EXISTS on `character_id = auth.uid()` covers every non-broadcast scope. The `reason` column disambiguates why the row exists when we need to audit.
3. **Broadcast** – EXISTS on `event_broadcast_recipients`.
4. **Admin/service override** – allow `is_service_role()` (or `characters.is_admin`) to see everything.
Policies short-circuit; a row is visible if any predicate evaluates true, and every predicate depends solely on recipients recorded when the event was created.
Game moderators therefore have blanket visibility (no corp- or sector-scoped special cases).

## 6. Event Ingestion Workflow
1. Build payload (unchanged) and call `record_event`.
2. `record_event` inserts into `public.events`, returning `event_id`.
3. Depending on scope:
   - Sector/corp/combat/etc.: snapshot the eligible characters immediately into `event_character_recipients(event_id, character_id, reason)` (reasons distinguish the scope).
   - Direct/self/system: insert explicit character recipients with appropriate reason tags.
   - Broadcast / GM broadcast: insert a single row into `event_broadcast_recipients` (no per-character rows).
4. No call to `/realtime/v1/api/broadcast`.
5. `movement.observers` et al log metrics by counting inserted recipients instead of HTTP calls.

### 6.1 `record_event_with_recipients()` helper
- **Implementation:** Postgres `SECURITY DEFINER` function so the entire workflow happens in a single transaction inside the database (edge callers never split the insert + expansion steps).
- **Signature (conceptual):**
  ```sql
  create function record_event_with_recipients(
    p_direction text,
    p_event_type text,
    p_scope text,
    p_actor_character_id uuid,
    p_corp_id uuid,
    p_sector_id int,
    p_payload jsonb,
    p_meta jsonb,
    p_request_id uuid,
    p_recipients uuid[],
    p_reasons text[],
    p_is_broadcast boolean
  ) returns uuid
  ```
- **Behavior:**
  1. Insert into `events` (`inserted_at default now()`) and capture `event_id`.
  2. If `array_length(p_recipients, 1) > 0`, bulk insert via `INSERT INTO event_character_recipients SELECT p_event_id, rec, reason FROM unnest(p_recipients, p_reasons)`; enforce `array_length` equality and a unique constraint on `(event_id, character_id)` (conflict → do nothing) so retries stay idempotent.
  3. If `p_is_broadcast` (or `p_scope = 'gm_broadcast'`), insert `event_id` into `event_broadcast_recipients`.
  4. Emit structured log `event.recipient_counts` with `{ event_id, scope, recipient_counts_by_reason }` (built via `jsonb_each_text`).
  5. Return `event_id` to the caller.
- **Inputs:** edge helpers compute and dedupe the recipient UUIDs + matching `reason` strings before calling the SQL function.
- **Error handling:** raise `invalid_parameter_value` when `array_length` mismatches or when required IDs (e.g., `corp_id` for `scope='corp'`) are missing.
- **Admin/system messages:** pass `p_actor_character_id = NULL`, stash arbitrary display names inside `p_payload.from_display_name`, and rely on the broadcast table (when `p_is_broadcast = true`) or the explicit recipient array for GM direct messages. Clients read the display name from the payload.

### 6.2 Admin / GM broadcast + direct utility
- New RPC: `supabase/functions/admin_broadcast_message` (service-role token + operator API key required).
- Input JSON:
  - `from_display_name` (string, required) — e.g., `"Commander Nova"` or `"MegaPort Supply Dock"`.
  - `message` (string, required) — markdown-safe body.
  - `priority` (enum: `info|warning|critical`, optional) for client styling.
  - `target_character_ids` (array<uuid>, optional). If omitted/empty → broadcast to everyone; otherwise treat as an admin-authored direct message to the listed characters.
  - `request_id` (optional) for auditing.
- Behavior:
  1. Validate caller has `is_admin` claim; reject otherwise.
  2. Build payload `{ content, priority, from_display_name }` (and include `targets` metadata when present).
  3. If `target_character_ids` is empty or not supplied:
     - Call `record_event_with_recipients()` with `event_type = 'gm.broadcast'`, `scope = 'gm_broadcast'`, `actor_character_id = null`, `corp_id = null`, and skip per-character inserts so `event_broadcast_recipients` carries delivery.
  4. If `target_character_ids` is provided:
     - Dedupe + validate each UUID, then snapshot them into `event_character_recipients` with `reason = 'admin_direct'`.
     - Insert event with `event_type = 'gm.direct_message'`, `scope = 'direct'`, `actor_character_id = null`, `corp_id = null`.
  5. In both cases set `meta.admin_source = operator_user_id` for audit.
- Clients render the supplied `from_display_name` regardless of whether a real character exists, satisfying the “send as arbitrary name” requirement.

### 6.3 Corp messaging (member → corp)
- New RPC: `supabase/functions/corp_chat_send`.
- Input JSON:
  - `character_id` (UUID, required) — sender (validated via API token + AsyncGameClient identity binding).
  - `message` (string, required).
  - `request_id` optional.
- Flow:
  1. Validate the caller is authenticated as `character_id`.
  2. Look up `corp_id` for the character (`SELECT corp_id FROM characters`); if null → `400` (“not in a corp”). Cache this value so downstream helpers reuse it instead of re-querying.
  3. Fetch current corp member UUIDs via `_shared/corporations.listCorporationMemberIds`, which consults `corporation_members` (`left_at IS NULL`) to mirror the legacy `world.character_to_corp` + in-memory membership.
  4. Insert event with:
     - `event_type = 'corp.chat.message'`
     - `scope = 'corp'`
     - `actor_character_id = character_id`
     - `corp_id = sender.corp_id`
     - Payload `{ message, from_character_id, corp_id, sent_at }`.
  5. Because recipients were snapshotted, only members at send time receive the event; RLS enforces visibility via `event_character_recipients`.
- Clients reuse existing corp chat UI; no new websocket topics are needed because the changefeed already carries these rows.

## 7. Client Authentication & Consumption
1. **JWT issuance** – New edge RPC `get_character_jwt` validates the API token, takes a `character_id`, and returns a signed JWT with:
   - `sub = character_id`
   - `role = authenticated`
   - Optional claims (`is_admin`, corp, etc.) for future policy hooks.
2. **AsyncGameClient updates** – `utils/supabase_client.py`:
   - Calls `get_character_jwt` during `connect()` and instantiates the Supabase JS/Python client with that token (not the service-role key).
   - Subscribes to `postgres_changes` on `public.events` filtered to `event = 'INSERT'`.
   - Reuses existing `.on('event_type')` handlers by dispatching changefeed payloads.
3. **Backfill / replay** – `event_query` already SELECTs from `public.events`; adjust to query `public.visible_events` so RLS applies automatically.
4. **Migration toggle** – removed. All clients now subscribe exclusively to `postgres_changes` on `public.events`; no broadcast fallback remains.
5. **Client handling for new scopes** –
   - `gm.broadcast` events show `payload.from_display_name` and ignore `actor_character_id` (since it’s null). Clients should treat `scope = 'gm_broadcast'` as high-priority system messages and optionally colorize by `payload.priority`.
   - `gm.direct_message` events arrive via the same changefeed but only for listed recipients. UI should surface them in the inbox/notifications panel with the arbitrary `from_display_name` and mark them as system messages (actor is null).
   - `corp.chat.message` events route into the corp chat panel; UI shows sender display name from the payload but RLS already guarantees the viewer is/was in the corp at send time.

## 8. Migration & Rollout Plan
| Phase | Goals | Key Tasks | Exit Criteria |
| --- | --- | --- | --- |
| **1. Schema + Dual Write** | Land schema, start populating recipients while keeping broadcast | Apply migration (`events` columns, recipient tables, helper functions, view, RLS), update `logEvent/record_event` to write recipients, keep existing `publishRealtime` calls for redundancy | Recent events show populated recipient rows; broadcast still functioning; integration tests green |
| **2. Enable postgres_changes** | Wire clients + changefeed while keeping broadcast for safety | Ship `get_character_jwt`, update AsyncGameClient to subscribe to changefeed (behind flag), enable RLS, run edge/integration tests comparing broadcast vs changefeed payloads | For a sampled move loop, counts of events via broadcast == counts via changefeed; no unauthorized access observed |
| **3. Remove broadcast path** | Delete HTTP fan-out logic | Remove `publishRealtime`, per-topic loops, retry env vars; drop observer envelope code; flip feature flag default to changefeed | Load tests (move loop, corp spam, broadcast chat) run without 429s for 24h; monitoring shows zero HTTP broadcast calls |
| **4. Cleanup & optimize** | Tighten schema, add telemetry | Remove unused env vars/scripts, add Supabase dashboard checks, ensure retention job purges recipient tables | CLAUDE/AGENTS docs updated; ops runbook documents JWT issuance + troubleshooting |

Validation hooks per phase:
- SQL sanity queries (recipient counts, sample scopes).
- Load tests measuring move latency and verifying no 429s.
- Dual-subscription harness comparing payload equality during Phase 2.
- **Backfill strategy:** no backfill. Once the new pipeline is deployed we regenerate world/universe fixtures (and static test data) so every persisted event was produced under the new schema.

## 9. Performance & Storage Considerations
- `event_character_recipients` stores one row per actual character recipient (uuid + reason text), so we only pay storage for people who truly saw the event. Typical row size stays ≈40 bytes before indexes, which keeps growth predictable even when sectors are crowded.
- `event_character_recipients(character_id, event_id)` index keeps `event_query` fast; typical lookup (`character_id = ? AND inserted_at > now() - interval '1 hour'`) remains sub-5 ms for 1 M rows.
- Scope-level analytics (“how many observers were snapped?”) come from grouping `event_character_recipients` by `reason`, so there’s no separate sector/corp table on the hot path. When heavier reporting is needed we can run offline jobs that fan out from the main table.
- Changefeed throughput: Supabase documents ≥500 events/sec per connection, well above our current ~60 events/sec peak (
`corp loop = 10 ships * 3 events * 2 sectors ≈ 60 inserts/sec`).
- Storage growth per million events projected at <+200 MB; still below Supabase Pro’s 8 GB default quota.

## 10. Testing & Validation Strategy
1. **Unit tests** (Deno):
   - `tests/edge/test_visibility_computation.ts` verifying `computeSectorVisibility`/`record_event` insert the right recipients for ships, garrisons, corp members, and exclusions.
   - `tests/edge/test_corp_visibility.ts` ensuring corp snapshotting freezes membership.
2. **RLS tests**:
   - Helper script that inserts synthetic events + recipients, then queries `visible_events` as different characters to confirm policies (authorized sees ≥1 row; unauthorized sees 0).
   - Negative test verifying a character outside `event_character_recipients` cannot fetch the row even with direct SQL access.
3. **Changefeed tests**:
   - Integration harness subscribing via AsyncGameClient, issuing a move, and asserting payload equality between `postgres_changes` and `event_query` replay for that `request_id`.
   - Add cases for new scopes:
     - `gm.direct_message` → only the listed recipients receive the event; everyone else sees nothing.
     - `gm.broadcast` → every connected client receives the payload and renders `from_display_name`.
     - `corp.chat.message` → sender’s corp members receive the message; a character outside the corp (or after leaving) does not.
4. **Load tests**:
   - Existing corp move loop with SUPABASE logging to confirm zero 429s.
   - Broadcast spam test verifying `emitBroadcastEvent` inserts once and reaches all clients.
5. **Migration validation scripts**:
   - SQL snippets to ensure new columns/tables exist and indexes are used (EXPLAIN on `character_id` lookup, `can_view_sector`).

## 11. Deterministic Test Fixtures & Reset Flow
- **Single source of truth fixtures.** Canonical JSON lives under `tests/test-world-data/` (`characters.json`, `universe_structure.json`, `sector_contents.json`). Add `uv run scripts/rebuild_test_fixtures.py` that regenerates these files from the current `world-data/` + deterministic namespaces so test data drifts are reviewable.
- **Edge `test_reset` as only entrypoint.** Ensure every test run (CI + local) resets via `supabase/functions/test_reset`. Remove divergent SQL fallbacks by having the helper import the same fixture JSON and deterministic UUID generators. The RPC returns `{cleared_tables, inserted_characters, inserted_ships, sectors_seeded}` plus a `state_hash` so we can log/compare start and end states.
- **Scenario hooks.** Extend `test_reset` to accept `scenario` (e.g., `"two_player"`, `"corp_combat"`) which appends scenario-specific fixture slices before seeding. Tests request scenarios via a pytest marker, and the RPC logs which scenario ran.
- **Pytest visibility.** Autouse fixtures already invoke `test_reset`; update them to log the RPC response to `logs/test-reset.log` and capture the universe checksum both before/after suites. Fail fast if the response hash differs from the committed fixture hash.
- **AsyncGameClient helpers.** Expose `tests/helpers/supabase_reset.invoke_test_reset(scenario='default')` so other harnesses (load tests, local scripts) can reuse the same call.

## 12. Core Code Touchpoints
- `supabase/functions/_shared/events.ts` — introduce `record_event` helper that logs the event and writes normalized recipients; remove HTTP broadcast helpers once Phase 3 completes.
- `supabase/functions/_shared/movement.ts` and `observers.ts` — reuse payload builders but swap fan-out loops for recipient inserts + metrics.
- `supabase/functions/_shared/corporations.ts`, `combat.ts`, etc. — add `emitCorporationEvent`, `emitCombatEvent` helpers that snapshot corp/combat participants into recipient tables.
- `_shared/characters.ts` — add helpers like `getCharacterCorpId(supabase, characterId)` (single `SELECT corp_id FROM characters`) and `listActorCorpRecipients(supabase, characterId)` (loads/validates active corp membership via `corporation_members`). Every RPC that previously read `world.character_to_corp` calls these once, caches the result within the handler, and shares it with event emitters so we never duplicate lookups.
- `supabase/functions/get_character_jwt` — new RPC to mint per-character JWTs (HS256) for realtime access.
- `supabase/functions/admin_broadcast_message` — new service-role endpoint implementing §6.2.
- `supabase/functions/corp_chat_send` — authenticated endpoint implementing §6.3, including membership validation.
- `utils/supabase_client.py` — add JWT fetch, changefeed subscription, dual-mode flag for rollout.
- `tests/edge/helpers/realtime.py` — connect to postgres changefeed for assertions.

## 13. Admin trim endpoint & retention
- Add `supabase/functions/admin_trim_events` (service-role only) that accepts `cutoff_timestamp` (ISO string) and deletes:
  1. `DELETE FROM event_character_recipients WHERE event_id IN (SELECT id FROM events WHERE inserted_at < cutoff)`
  2. `DELETE FROM event_broadcast_recipients ...` (same cutoff)
  3. `DELETE FROM events WHERE inserted_at < cutoff`
- Expose it behind API-token auth so ops can invoke `uv run scripts/admin_trim_events.py 2025-01-01T00:00:00Z` when storage nears quota or during routine retention runs.
- Default retention horizon is 7 days; ops automation (future work) will invoke this endpoint with `cutoff = now() - interval '7 days'` so all tables stay in sync. Longer retention (e.g., staging reproductions) can override the parameter manually. The cron/orchestration implementation is out of scope for this plan; delivering the endpoint + CLI/script is sufficient.

## 14. Next Actions
1. Draft migration SQL (`20251110_events_rls.sql`) with tables, functions, indexes, policies; circulate for review. Apply locally via `set -a && source .env.supabase && set +a && npx supabase db push --local` (the `.env.supabase` file already carries the required Supabase URL/service keys). Use `--linked false --db-url ...` for remote pushes.
2. Implement `record_event` + recipient-writer helpers and update `move` edge function as the pilot RPC.
3. Ship `get_character_jwt` and AsyncGameClient changefeed subscription behind a feature flag; run dual-delivery tests.
4. Remove HTTP broadcast helpers/env once full suite passes and monitoring shows 0 changefeed gaps for ≥24 h.
5. Land deterministic test fixture tooling: `scripts/rebuild_test_fixtures.py`, enhanced `test_reset` (scenario support + hashes), and pytest logging of reset responses.
# Payload Parity Snapshot
See `planning-files/payload-parity-plan.md` for the double-run harness, status of the `tests/helpers/payload_assertions.py` comparers, and instructions for capturing legacy vs Supabase events. Future TODO: consider wiring that comparer into pytest fixtures so tests can request legacy+Supabase runs inline instead of relying solely on the shell harness.
