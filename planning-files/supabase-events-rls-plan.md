# Supabase Events + RLS Delivery Plan

## 0. Executive Summary
**Problem.** Movement and corp RPCs currently fan out one HTTP POST per recipient via Supabase Realtime Broadcast. A single move in a 30-character sector emits ~90 POSTs in <200 ms (depart + arrive, sector + observer envelopes, garrison fan-out). With retries every 40 ms, the burst exceeds Supabase’s per-project quota (≈100 msg/s on Free, 500 msg/s on Pro), producing `429 Too Many Requests` and dropping events even though the app-level rate limiter never trips.

**Solution.** Make the `public.events` table the single source of truth for both history (`event_query`) and realtime by:
- Logging every outbound event once, along with normalized recipient rows that encode who may see it.
- Enforcing visibility through Postgres row-level security (RLS) so Supabase’s `postgres_changes` feed delivers only rows the subscriber is allowed to read.
- Subscribing clients to the `visible_events` changefeed with per-character JWTs instead of service-role keys.

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
4. Clients subscribe to `postgres_changes` on `public.visible_events` using per-character JWTs issued by a new `get_character_jwt` RPC.
5. `event_query` runs a normal SELECT over the same view.

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
RLS policies attach to the view so recipients tables stay internal.

## 5. Row-Level Security Policies
Enable `ALTER TABLE public.visible_events ENABLE ROW LEVEL SECURITY;` then add policies that reference only frozen data captured at insert time (no dynamic sector/corp lookups):
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
   - Subscribes to `postgres_changes` on `public.visible_events` filtered to `event = 'INSERT'`.
   - Reuses existing `.on('event_type')` handlers by dispatching changefeed payloads.
3. **Backfill / replay** – `event_query` already SELECTs from `public.events`; adjust to query `public.visible_events` so RLS applies automatically.
4. **Migration toggle** – removed. All clients now subscribe exclusively to `postgres_changes` on `public.visible_events`; no broadcast fallback remains.
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
1. Draft migration SQL (`20251110_events_rls.sql`) with tables, functions, indexes, policies; circulate for review.
2. Implement `record_event` + recipient-writer helpers and update `move` edge function as the pilot RPC.
3. Ship `get_character_jwt` and AsyncGameClient changefeed subscription behind a feature flag; run dual-delivery tests.
4. Remove HTTP broadcast helpers/env once full suite passes and monitoring shows 0 changefeed gaps for ≥24 h.
5. Land deterministic test fixture tooling: `scripts/rebuild_test_fixtures.py`, enhanced `test_reset` (scenario support + hashes), and pytest logging of reset responses.
