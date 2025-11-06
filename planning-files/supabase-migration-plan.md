# Supabase Migration Plan - Server-Only Architecture

**Last Updated:** 2025-10-24

## Executive Summary

This document outlines a 7-week plan (including Week 0 preparation) to move Gradient Bang from its file-based storage to Supabase PostgreSQL with Edge Functions. The architecture is **server-only**: all requests come from trusted servers (voice bot, admin CLI) using service role keys, with no public user authentication. Instead of migrating legacy data, every environment is rebuilt using deterministic "universe bang" scripts, and rollback is handled by keeping the Supabase work in a dedicated worktree.

**Key Architecture Principles:**
- Server-to-server authentication only (service role key from .env)
- Token-protected edge functions (X-API-Token header validation)
- No RLS policies (all requests are trusted)
- Rate limiting for defensive programming (prevent bugs/loops)
- Supabase Python SDK for voice bot integration
- Realtime Broadcast for event delivery (replaces WebSocket firehose)
- Deterministic Supabase seeding (“universe bang”) instead of legacy data migration

## Timeline Overview

**Total Duration:** 7 weeks (Week 0 preparation + 6 execution weeks)

- **Week 0:** Preparation (environment setup, templates, design sessions, TypeScript/Deno refresher)
- **Week 1:** Database setup and core tables
- **Week 2:** Edge function framework + per-endpoint event delivery with passing unit & integration tests
- **Week 3:** Event system hardening, multi-channel Realtime validation, and cross-cutting telemetry
- **Week 4:** Universe/data seeding and validation (fresh Supabase "bang" scripts)
- **Week 5:** Testing, performance benchmarking, and Python SDK integration
- **Week 6:** Cutover preparation and deployment (in separate worktree)

## Week 0: Preparation & Design (Week 0)

### Goals
- Stand up local Supabase tooling and fresh-worktree workflow
- Create reusable edge-function templates and Supabase “bang” scripts
- Align on event, combat, and rate-limiting designs before writing code
- Schedule design/POC sessions so the Week 1 build hits the ground running

### Tasks

#### 0.1 Environment + Tooling Setup (Days 1-2)
- Ensure Supabase CLI + Docker are installed and `supabase start` works locally.
- Create a dedicated worktree/branch for the Supabase implementation so rollback is handled by branch switching, not production data changes.
- Stub `.env.supabase` with `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_API_TOKEN`.

#### 0.2 Edge Function Templates (Days 2-3)
- Add `supabase/functions/_templates/readonly.ts` and `mutation.ts` scaffolds covering auth, rate-limit call, structured logging, and error handling.
- Document in CLAUDE.md how to copy the templates when creating new functions (saves ~30–45 minutes/function).

#### 0.3 Design Sessions (Days 3-4)
- **Session 1 – Events:** confirm per-character Realtime channels, events table usage, catch-up strategy (event_query).
- **Session 2 – State & Combat:** finalize combat state machine responsibilities, hyperspace timers, and how garrisons participate.
- **Session 3 – Data Model:** confirm nullable state columns for preregistered characters and how planets are stored.
- **Session 4 – Testing & Benchmarks:** agree on Supabase test fixture strategy and p50/p95 targets for join/move/trade.
- Capture outcomes in planning notes.

#### 0.4 Week 1.5 Proof of Concept (Scheduling)
- Book time during Week 1 to deliver a join → event → client round-trip (see Week 1.5 milestone in Phase 2). Define explicit success criteria (<200 ms join, event delivered, drop-in AsyncGameClient call).

## Phase 1: Database Setup (Week 1)

### Goals
- Set up Supabase project
- Create all database tables and functions
- Test database operations locally
- Fix Python package naming

### Tasks

#### 1.1 Keep `game-server` directory name (Day 1 - Morning)
**Why:** Existing tooling (`tests/conftest.py`, CLI helpers, docs) already place `game-server` on `sys.path`, so a repo-wide rename provides little value and risks churn.

**Tasks:**
- Confirm the `sys.path` shim remains in `tests/conftest.py` and other helpers.
- Update CLAUDE.md to note that imports rely on the shim instead of renaming.
- Run `uv run python -m game-server.server` to validate the module still imports cleanly.

#### 1.2 Supabase Project Setup (Day 1 - Afternoon)

**Create Remote Project:**
- Create Supabase project at https://supabase.com (free tier for development, Pro for production)
- Note your project URL and service role key

**Set Up Local Development Environment:**

```bash
# Install Supabase CLI (requires Docker)
npm install -g supabase

# Verify Docker is running
docker --version

# Initialize Supabase in your project
cd /path/to/gradient-bang
supabase init

# This creates:
# supabase/
#   config.toml          - Supabase configuration
#   seed.sql             - Seed data (optional)
#   functions/           - Edge functions directory
#     _shared/           - Shared utilities

# Start local Supabase (runs in Docker)
supabase start

# This starts:
# - PostgreSQL database (port 54322)
# - PostgREST API (port 54321)
# - Supabase Studio (port 54323) - web UI for browsing database
# - Edge Functions runtime

# Note: Local Supabase URL will be http://localhost:54321
# Service role key will be displayed in terminal output
```

**Link to Remote Project (Optional):**
```bash
# Link local project to remote
supabase link --project-ref your-project-ref

# Pull remote schema to local
supabase db pull

# Push local changes to remote
supabase db push
```

**Environment Variables:**
```bash
# .env.local (for local development)
SUPABASE_URL=http://localhost:54321
SUPABASE_SERVICE_ROLE_KEY=<shown in supabase start output>
SUPABASE_API_TOKEN=local-dev-token

# .env.production (for remote)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<from supabase dashboard>
SUPABASE_API_TOKEN=<generate with: openssl rand -hex 32>
```

See Appendix B for the full environment variable reference so we only maintain these values in one place.

#### 1.3 Create Core Schema (Days 2-3)

**Apply Schema to Local Database:**

```bash
# Copy schema file to supabase/migrations/
cp planning-files/supabase-schema-server-only.sql supabase/migrations/20250101000000_initial_schema.sql

# Apply to local database
supabase db reset

# Verify tables created
supabase db diff

# View in Supabase Studio
# Open http://localhost:54323 in browser
```

**Schema creates 13 tables:**
- universe_config (singleton)
- universe_structure (5000 rows)
- ports (~200 rows)
- sector_contents (5000 rows, includes `planets` JSONB for static metadata)
- garrisons (dynamic)
- ship_definitions (~5 types)
- ship_instances (player and corporation owned ships)
- characters (player + autonomous ship metadata)
- corporations (name, founder, invite code state)
- corporation_members (membership history)
- corporation_ships (ownership + audit data)
- events (event log)
- rate_limits (request tracking)

**Key Foreign Key Constraints:**
```sql
-- Ship ownership may reference characters or corporations
ALTER TABLE ship_instances
  ADD CONSTRAINT fk_ship_owner_character
  FOREIGN KEY (owner_character_id) REFERENCES characters(character_id)
  ON DELETE CASCADE;

ALTER TABLE ship_instances
  ADD CONSTRAINT fk_ship_owner_corporation
  FOREIGN KEY (owner_corporation_id) REFERENCES corporations(corp_id)
  ON DELETE CASCADE;

-- Corporation membership + ship registries
ALTER TABLE corporation_members
  ADD CONSTRAINT fk_corporation_members_corp
  FOREIGN KEY (corp_id) REFERENCES corporations(corp_id)
  ON DELETE CASCADE;

ALTER TABLE corporation_members
  ADD CONSTRAINT fk_corporation_members_character
  FOREIGN KEY (character_id) REFERENCES characters(character_id)
  ON DELETE CASCADE;

ALTER TABLE corporation_ships
  ADD CONSTRAINT fk_corporation_ships_corp
  FOREIGN KEY (corp_id) REFERENCES corporations(corp_id)
  ON DELETE CASCADE;

ALTER TABLE corporation_ships
  ADD CONSTRAINT fk_corporation_ships_ship
  FOREIGN KEY (ship_id) REFERENCES ship_instances(ship_id)
  ON DELETE CASCADE;

-- Existing constraints retained
ALTER TABLE garrisons
  ADD CONSTRAINT fk_garrison_owner
  FOREIGN KEY (owner_id) REFERENCES characters(character_id)
  ON DELETE CASCADE;

ALTER TABLE characters
  ADD CONSTRAINT fk_characters_current_ship
  FOREIGN KEY (current_ship_id) REFERENCES ship_instances(ship_id);
```

**Corporation-aware columns to model in the schema:**
- `ship_instances.owner_type` (`character`/`corporation`/`unowned`) with paired `owner_character_id` and `owner_corporation_id`
- `ship_instances.became_unowned` + `former_owner_name` for salvage history
- `characters.corporation_id`, `characters.corporation_joined_at`, and `characters.credits_in_bank`
- `corporations` table fields: `corp_id`, `name`, `founder_id`, invite metadata, timestamps
- `corporation_members` join table with `joined_at`, optional `left_at`
- `corporation_ships` association table storing `added_at`, `added_by`, and active flag

#### 1.4 Load Initial Data (Days 4-5)

**Option 1: Procedural generator outputs SQL**
```bash
# Write a generator that emits INSERT/UPSERT statements
uv run python scripts/seed_universe.py --sql > supabase/migrations/20250101000001_seed_universe.sql

# This generates:
# INSERT INTO universe_config VALUES (1, 5000, <seed>, <params>);
# INSERT INTO universe_structure VALUES (0, 0, 0, 'core', '[...]');
# INSERT INTO universe_structure VALUES (1, 10, 5, 'core', '[...]');
# ... (5000 rows)
# INSERT INTO ports VALUES (DEFAULT, 42, 'BSS', 3, 100, 100, 100, 50, 50, 50);
# ... (200 port rows)

# Apply to local database
supabase db reset
```

**Option 2: Direct seeding script**
```python
# scripts/seed_universe.py
from supabase import create_client

client = create_client(supabase_url, service_key)

# Insert universe_config and sectors programmatically
client.table('universe_config').upsert({
    'sector_count': 5000,
    'generation_seed': 1234,
    'generation_params': {'sector_count': 5000, 'seed': 1234},
}).execute()

# Generate sectors in memory and insert in batches
# ... (implementation details)
```

**Load Ship Definitions:**
```sql
-- Add to migration file
INSERT INTO ship_definitions (ship_type, display_name, cargo_holds, warp_power_capacity, turns_per_warp, shields, fighters, base_value)
VALUES
  ('kestrel_courier', 'Kestrel Courier', 20, 100, 1, 100, 50, 1000),
  ('hawk_trader', 'Hawk Trader', 60, 200, 2, 150, 75, 5000);
  -- Add more ship types as needed
```

#### 1.5 Validation Testing (Days 6-7)
- Browse database in Supabase Studio (http://localhost:54323)
- Verify table row counts match expectations
- Test sample queries for performance
- Validate foreign key constraints work

```sql
-- Test queries
SELECT COUNT(*) FROM universe_structure; -- Should be 5000
SELECT COUNT(*) FROM ports;              -- Should be ~200
SELECT * FROM universe_config;           -- Should be 1 row

-- Test CASCADE delete
INSERT INTO characters (name) VALUES ('Test Character');
INSERT INTO ship_instances (owner_character_id, owner_type, ship_type, current_sector, current_warp_power, current_shields, current_fighters)
  SELECT character_id, 'character', 'kestrel_courier', 0, 100, 100, 50
  FROM characters WHERE name = 'Test Character';

DELETE FROM characters WHERE name = 'Test Character';
-- Ship should be auto-deleted via CASCADE
SELECT COUNT(*) FROM ship_instances WHERE owner_character_id NOT IN (SELECT character_id FROM characters);
-- Should return 0
```

**Deliverables:**
- Working local Supabase database with full schema
- Universe data loaded (5000 sectors, ports)
- Indexes created and validated
- Foreign key constraints tested

---

## Phase 2: Edge Functions + Event Delivery (Week 2)

### Goals
- Set up edge function infrastructure
- Implement shared utilities (auth, rate limiting, **event fanout helpers**) once and reuse everywhere
- Port every critical RPC endpoint **together with its event payloads** so AsyncGameClient keeps working unchanged
- Build/port all related unit tests and re-run existing integration tests per endpoint before marking it complete
- Stand up the Supabase-fixture workflow (seed + reset) needed for those tests during the same sprint
- Master local edge function development workflow (Deno + Supabase CLI)

**Reminder:** RPC responses stay intentionally thin (success/error). All meaningful state is conveyed through events, so event emission must be implemented simultaneously with the endpoint logic—there is no “later” event pass.

### Definition of Done (applies to **every** endpoint)
1. Edge function implemented with auth + rate-limit + validation wrappers.
2. Associated event emissions (sector + character fanout via `_shared/events.ts`) match the legacy payload schema; logging proves they fire before responding.
3. Supabase test fixtures for the data that endpoint touches are created/updated in the same PR (e.g., starter ships for `ship.purchase`, port inventory for `trade`).
4. All relevant unit tests from `tests/unit` are ported to run against the new code path (using adapters described in §5.1a) and must pass.
5. All existing integration tests from `tests/integration` that cover the endpoint are run unchanged with the Supabase backend and must pass; failures mean the endpoint is not done.
6. AsyncGameClient contract verified via `utils/api_client.AsyncGameClient` (legacy) hitting the new infrastructure, ensuring no API drift.

No endpoint ships unless all six boxes are checked.

### Edge Function Development Workflow

**Directory Structure:**
```
gradient-bang/
  supabase/
    functions/
      _shared/           # Shared utilities
        auth.ts          # Token validation
        rate_limiting.ts # Rate limit helpers
        events.ts        # Event emission
      move/
        index.ts         # Move edge function
      trade/
        index.ts         # Trade edge function
      join/
        index.ts         # Join edge function
```

**Development Cycle:**

1. **Create Function:**
```bash
# Create new edge function
supabase functions new my_function

# This creates: supabase/functions/my_function/index.ts
```

2. **Write Function Code:**
```typescript
// supabase/functions/my_function/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

serve(async (req) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  const { name } = await req.json()

  const { data } = await supabase
    .from('characters')
    .select('*')
    .eq('name', name)
    .single()

  return new Response(
    JSON.stringify(data),
    { headers: { 'Content-Type': 'application/json' } }
  )
})
```

3. **Serve Locally:**
```bash
# Start local edge function runtime
supabase functions serve my_function

# Function runs at: http://localhost:54321/functions/v1/my_function

# Watch for changes (auto-reload)
supabase functions serve my_function --watch
```

4. **Test Function:**
```bash
# Test with curl
curl -i --location --request POST 'http://localhost:54321/functions/v1/my_function' \
  --header 'Authorization: Bearer <ANON_KEY>' \
  --header 'Content-Type: application/json' \
  --data '{"name":"Test"}'

# Or with Python
import requests
response = requests.post(
    'http://localhost:54321/functions/v1/my_function',
    headers={'Authorization': 'Bearer <ANON_KEY>'},
    json={'name': 'Test'}
)
print(response.json())
```

5. **Run Unit + Integration Tests:**
```bash
# Category 2 unit tests (ported to Supabase adapters)
uv run pytest tests/unit -k <endpoint>

# Category 1 integration tests (AsyncGameClient unchanged)
uv run pytest tests/integration/test_<endpoint_suite>.py -v
```
- Update fixtures (`tests/helpers`, Supabase seed data) until both suites pass without editing the legacy tests.
- Log results in the PR checklist; no endpoint is "done" until both suites are green.

6. **Debug Function:**
```typescript
// Add console.log statements
console.log('Request received:', req)
console.log('Data:', data)

// Logs appear in terminal running supabase functions serve
```

7. **Deploy to Local Supabase:**
```bash
# Edge functions are auto-served when using supabase functions serve
# No separate deploy needed for local development
```

8. **Deploy to Remote:**
```bash
# Deploy single function
supabase functions deploy my_function

# Deploy all functions
supabase functions deploy

# Set environment variables (secrets)
supabase secrets set API_TOKEN=your-token-here
```

**Environment Variables in Edge Functions:**
```typescript
// Access environment variables
const apiToken = Deno.env.get('API_TOKEN')
const supabaseUrl = Deno.env.get('SUPABASE_URL')
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

// For local development, these are auto-set by supabase start
// For production, set with: supabase secrets set KEY=value
```

**Common Debugging Issues:**

```bash
# Function not updating?
# Kill and restart serve:
Ctrl+C
supabase functions serve my_function --watch

# Check function logs
supabase functions logs my_function

# Check what functions are deployed
supabase functions list

# Inspect local database while debugging
psql postgresql://postgres:postgres@localhost:54322/postgres
```

### Tasks

#### 2.1 Shared Utilities (Days 1-2)
Create reusable modules in `supabase/functions/_shared/`:

**auth.ts** - Token validation
```typescript
export function validateApiToken(req: Request): boolean
export function unauthorizedResponse(): Response
export function errorResponse(message: string, status: number): Response
export function successResponse(data: any): Response
```

**rate_limiting.ts** - Per-character rate limits
```typescript
export const RATE_LIMITS: Record<string, { max: number; window: number }>
export async function checkRateLimit(
  supabase: SupabaseClient,
  character_id: string,
  endpoint: string
): Promise<boolean>
```

**Rate-limiting behavior:** Edge functions use **Option A (immediate rejection)**. If `checkRateLimit` returns `false`, the handler responds with HTTP 429 and does **not** queue the request. Document this in CHANGELOG and leave hooks for a future queued implementation (e.g., optional `queue=true` flag) if we see too many throttled requests.

**events.ts** - Event emission
```typescript
export async function emitSectorEvent(...)
export async function emitCharacterEvent(...)
```

Reference: `planning-files/edge-function-examples.md`

#### 2.2 Critical RPC Endpoints (Days 3-5)
Implement and deploy core game mechanics:

**Priority 1 (Day 3):**
- `join` - Session initialization
- `my_status` - Character state query
- `move` - Sector movement
- `character_create` - New character creation
- `character_delete` - Character deletion

**Priority 2 (Day 4):**
- `trade` - Port trading with optimistic locking
- `plot_course` - Pathfinding
- `local_map_region` - Local exploration
- `list_known_ports` - Port discovery filtering
- `path_with_region` - Region-aware path helper

**Priority 3 (Day 5):**
- `recharge_warp_power` - Refuel at sector 0
- `transfer_warp_power` - Transfer fuel
- `dump_cargo` - Flush ship cargo holds
- `transfer_credits` - Real-time ship credit transfers
- `bank_transfer` - Deposit/withdraw to Megaport bank
- `ship.purchase` - Acquire personal or corporation ships

**Priority 4 (Day 6):**
- `corporation.create` - Found a corporation
- `corporation.join` - Join via invite code
- `corporation.regenerate_invite_code` - Rotate invite tokens
- `corporation.leave` - Leave a corporation
- `corporation.kick` - Remove a member
- `corporation.info` - Detailed corporation view
- `corporation.list` - Discover corporations
- `my.corporation` - Quick membership lookup

For every endpoint above:
- Write/port the necessary unit tests (Category 2) in the same PR and ensure they exercise the Supabase-backed logic, not the deprecated in-memory world objects.
- Re-run the matching integration files (Category 1) without editing the tests; success proves that events + RPC payloads match the legacy contract.
- Create/update Supabase seed data needed for those tests (characters, ships, ports, corporations) as part of the implementation, rather than deferring to a later "data" phase.

#### 2.3 Week 1.5 Proof of Concept (Day 7)
- Deploy `join` plus shared utilities to the local Supabase stack.
- Wire the Supabase-backed `AsyncGameClient` into a single integration test that performs `join` → `move` and validates that a Realtime event arrives via `RealtimeEventListener`.
- Success criteria: `join` completes <200 ms (p95) locally, event delivery works, and API surface remains identical to the legacy client.

#### 2.4 Integration Testing (Day 7)
- Test edge functions locally with `supabase functions serve`
- Verify token authentication works
- Test rate limiting behavior
- Validate error handling

**Deliverables:**
- All critical edge functions deployed
- Shared utilities tested and documented
- Environment secrets configured

---

## Phase 3: Event System Hardening & Realtime QA (Week 3)

### Goals
- Finish wiring the Supabase Realtime broadcast stack that every Week 2 edge function already depends on
- Guarantee event logging + replay parity with the legacy FastAPI server
- Validate multi-client delivery (AsyncGameClient, diagnostics tools, firehose viewer) without changing existing consumer code
- Capture metrics/telemetry around event lag, retries, and dropped connections

Week 3 assumes every endpoint already emits events (Week 2 DoD). These tasks focus on scaling, observability, and failure-handling so that when we continue implementing additional RPCs they inherit a hardened event pipeline.

### Tasks

#### 3.1 Realtime Broadcast Setup (Days 1-2)
- Enable/verify Realtime in Supabase project settings (already running from Week 2 but double-check secrets, anon keys, service role scope)
- Lock down the canonical channel matrix: `character:{character_id}`, `sector:{sector_id}`, and `firehose` broadcast streams, documenting which endpoints publish where
- Smoke-test channel subscription from Python SDK and from `AsyncGameClient`’s websocket shim so we know every consumer can attach without code changes

**Python Client Example:**
```python
from supabase import create_client

client = create_client(supabase_url, service_key)

# Subscribe to character events
channel = client.channel(f'character:{character_id}')

def handle_event(payload):
    event_type = payload['event']
    data = payload['payload']
    print(f"Received {event_type}: {data}")

channel.on_broadcast(event='*', callback=handle_event).subscribe()
```

#### 3.2 Event Fidelity & Load Regression (Days 2-3)
- Run an automated parity harness that replays the legacy FastAPI event logs for `join`, `move`, `trade`, `combat`, `garrison`, `bank`, and compares payloads against Supabase emissions (field-by-field, including ordering where applicable)
- Execute multi-subscriber load tests (e.g., >50 `AsyncGameClient` listeners + firehose) to ensure broadcasts stay <200 ms p95 and no clients miss events under churn
- Validate that every emission writes to the `events` table exactly once (idempotency) and that event replay over 24h windows matches historical counts

#### 3.3 Event Query Endpoint (Day 4)
Implement `event_query` edge function (replacement for today’s `event.query` RPC):
- Query events table for character
- Support filtering by event_type, time range
- Paginate results (limit 100 per query)

```typescript
// supabase/functions/event_query/index.ts
serve(async (req) => {
  const { character_id, event_type, since_timestamp, limit = 100 } = await req.json();

  let query = supabase
    .from('events')
    .select('*')
    .eq('character_id', character_id)
    .order('timestamp', { ascending: false })
    .limit(limit);

  if (event_type) query = query.eq('event_type', event_type);
  if (since_timestamp) query = query.gte('timestamp', since_timestamp);

  const { data } = await query;
  return successResponse({ events: data });
});
```

#### 3.4 Firehose Viewer Migration & Telemetry (Days 5-7)
- Migrate diagnostics tooling (`tools/firehose_viewer.py`, any ops dashboards) to Supabase Realtime so they observe the same channels the tests use
- Add OpenTelemetry / Supabase metrics hooks for event lag, dropped connections, retry counts, and channel backlog; publish Grafana (or Supabase dashboard) panels consumed during Week 2 regression testing and CI
- Implement alerting thresholds (e.g., event lag >500 ms for 3 mins, dropped event % >0.1) so issues surface automatically once we scale traffic

**Deliverables:**
- Channel matrix + docs validated; all consumers subscribe without code changes
- Event parity harness + load reports showing Supabase broadcasts match legacy payloads and performance targets
- `event_query` edge function deployed with unit/integration coverage
- Firehose viewer + telemetry dashboards live, with automated alerts for lag/drops

---

## Phase 4: Data Tooling & Validation (Week 4)

### Goals
- Automate creation of **fresh** seed data for every environment (no legacy data migration)
- Validate schema relationships and sample content
- Prepare reset scripts for future iterations

### Tasks

#### 4.1 Seed Script Development (Days 1-3)
- Implement `scripts/supabase_universe_bang.py` that recreates the existing universe-bang logic but writes directly to Supabase tables (or emits SQL suitable for `supabase db reset`). Each test/deploy run starts from a **fresh** deterministic universe; no legacy data migration is needed.
- Implement `scripts/seed_universe.py` to populate universe_config, universe_structure, ports, sector_contents (calls into the Supabase bang helper)
- Implement `scripts/seed_ships_and_characters.py` to create starter characters, ships, and ship state
- Implement `scripts/seed_corporations.py` (optional) for baseline corp + corp ship data
- Ensure scripts can target local Supabase via env vars and idempotently reset tables

#### 4.2 Seed Execution & Verification (Day 4)
```bash
uv run python scripts/seed_universe.py
uv run python scripts/seed_ships_and_characters.py
# Optional
uv run python scripts/seed_corporations.py
```

#### 4.3 Data Validation (Day 5)
- Verify row counts against seed expectations
- Check foreign key integrity and ownership splits (character vs corporation)
- Validate JSONB structures (sector contents, ship state, character map knowledge placeholders)
- Run representative queries required by edge functions (movement, corporations, trade)

**Validation Queries:**
```sql
-- Universe coverage
SELECT COUNT(*) FROM universe_structure;

-- Port availability
SELECT COUNT(*) FROM ports;

-- Character/ship linkage
SELECT c.name, s.ship_type, s.owner_type, s.current_sector
FROM characters c
JOIN ship_instances s ON c.current_ship_id = s.ship_id;

-- Corporation sanity checks (if seeded)
SELECT corp.name, COUNT(DISTINCT m.character_id) AS members, COUNT(DISTINCT cs.ship_id) AS ships
FROM corporations corp
LEFT JOIN corporation_members m ON corp.corp_id = m.corp_id
LEFT JOIN corporation_ships cs ON corp.corp_id = cs.corp_id
GROUP BY corp.name;

-- Garrisons
SELECT sector_id, owner_id, fighters, mode FROM garrisons ORDER BY sector_id;
```

#### 4.4 Reset & Documentation (Days 6-7)
- Document seed script usage and environment variables
- Provide a `scripts/reset_supabase.py` helper to truncate and reseed tables
- Capture validation results in docs/ or planning notes for future reference

**Deliverables:**
- Seed scripts for universe, ships/characters, and optional corporations
- Verified schema with sample data loaded from scratch
- Reset/runbook documentation for recreating the environment

---

## Phase 5: Testing & Optimization (Week 5)

### Goals
- Comprehensive integration testing
- Performance optimization
- Python SDK integration for voice bot

### Tasks

#### 5.1 Integration Testing (Days 1-2)
- Run existing test suite against Supabase backend
- Update `tests/conftest.py` fixtures to spin up a Supabase test project (via `supabase start`) and tear it down after the session
- Build a pytest fixture that invokes the Supabase bang + seed scripts before tests and truncates afterward to guarantee deterministic data
- Test multi-character scenarios (combat, trading)

```bash
# Update test configuration
export SUPABASE_URL=http://localhost:54321
export SUPABASE_SERVICE_ROLE_KEY=...
export SUPABASE_API_TOKEN=...

# Run test suite
uv run pytest tests/ -v
```

#### 5.1a AsyncGameClient Compatibility & Test Data Strategy (Days 1-3)
**Category 1 – tests that ONLY require `AsyncGameClient` and must run unchanged:**
- All suites in `tests/integration/`, including: `test_async_game_client.py`, `test_bank_operations.py`, `test_cargo_salvage.py`, `test_cargo_salvage_capacity.py`, `test_combat_system.py`, `test_concurrency.py`, `test_corporation_events.py`, `test_corporation_errors.py`, `test_corporation_lifecycle.py`, `test_corporation_offline.py`, `test_corporation_queries_integration.py`, `test_corporation_ships.py`, `test_corporation_ui.py`, `test_corporation_validation.py`, `test_credit_transfers.py`, `test_event_corporation_filter.py`, `test_event_system.py`, `test_friendly_fire.py`, `test_game_server_api.py`, `test_knowledge_loading.py`, `test_movement_system.py`, `test_persistence.py`, `test_ship_purchase_integration.py`, `test_ship_refactor.py`, and `test_trading_system.py`. These suites will continue to target the drop-in Supabase-backed `AsyncGameClient` with no code changes beyond pointing to the new base URL.
- Supporting helpers that also remain untouched: `tests/helpers/event_capture.py`, `tests/helpers/corporation_utils.py`, `tests/helpers/character_setup.py`, and `tests/helpers/server_fixture.py` (the latter only swaps out server boot logic for Supabase bootstrap scripts).

**Category 2 – tests that access world data/engine internals and need new adapters:**
- Everything under `tests/unit/` (API handlers, combat math, locks, tooling CLIs) plus `tests/diagnostics/test_combat_event_payloads.py`. These suites currently import `game-server` modules directly or mutate the JSON world files, so they will be reworked to use in-memory fakes that mimic the Supabase schema.

**Execution plan:**
- **Supabase-backed fixtures:** Replace the FastAPI server fixture in `tests/conftest.py` with a session-scoped harness that runs `supabase start`, exports `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`/`SUPABASE_API_TOKEN`, and exposes a `supabase_admin` helper (psycopg or Supabase client) for direct resets. `AsyncGameClient` continues to read `server_url`, but behind the scenes the “server” is the Edge Function gateway hitting Supabase.
- **Deterministic seed data:** Reproduce `tests/test-world-data` via SQL instead of filesystem copies. Add `scripts/supabase_seed_test_data.py` (wraps the existing universe bang + character registry JSON) that truncates mutable tables, inserts the fixed 10-sector map, registers every character from `tests/helpers/character_setup.py:TEST_CHARACTER_IDS`, and seeds ships/corporations/knowledge exactly once per test session. Re-run this seeder (or a stored procedure) before each test module to keep data identical to today’s setup.
- **Per-test reset:** Replace the `test.reset` RPC dependency with a direct database reset fixture. Options: wrap each test in a transaction and rollback, or call a lightweight SQL procedure that truncates `characters_runtime`, `combats`, `salvage`, `garrisons`, `events`, etc., then replays only the incremental data required for that test. Provide helpers (e.g., `supabase_reset_state()` in `tests/helpers/server_fixture.py`) so both integration and unit suites share the same cleanup logic.
- **Unit-test adapters:** Introduce a `SupabaseTestWorld` module that loads fixture rows from JSON (same files already used) into simple dataclasses so unit tests can keep instantiating handler functions without needing a real database. Update Category 2 suites to depend on this adapter rather than the legacy file-backed “world” dicts.
- **Documentation:** Append these compatibility rules and fixtures to `docs/testing.md` and keep this planning document updated so everyone understands which tests rely on the unchanged `AsyncGameClient` surface and which ones exercise internal Supabase adapters.

#### 5.2 Performance Optimization (Days 3-4)

**Database Optimization:**
- Add missing indexes if queries are slow
- Optimize JSONB queries for map_knowledge
- Configure connection pooling (Supabase defaults are good)

**Edge Function Optimization:**
- Minimize round-trips to database
- Use batch operations where possible
- Cache ship definitions (rarely change)

**Monitoring:**
- Enable Supabase metrics dashboard
- Monitor query performance
- Track rate limit hit rates
- Configure billing alerts (50/75/90%) via Supabase dashboard

#### 5.3 Python SDK Integration (Day 5)

Create **new, separate client** `utils/supabase_client.py` that implements `AsyncGameClient` using Supabase backend:

**Key Points:**
- This is a **new file**, not a modification of existing `api_client.py`.
- Constructor signature, keyword-only args, and public methods MUST stay byte-for-byte compatible with the current `AsyncGameClient` so every caller (voice bot, NPCs, tests) keeps working.
- Both clients can coexist during rollout; switch by changing a single import.

Create `utils/supabase_client.py`:
```python
# utils/supabase_client.py
from supabase import create_client, Client
from typing import Optional, Dict, Any, Callable
import asyncio
import os

class AsyncGameClient:
    """Supabase-backed implementation that preserves the legacy API surface."""

    def __init__(
        self,
        base_url: str | None = None,
        *,
        character_id: str,
        transport: str = "websocket",
        actor_character_id: Optional[str] = None,
        entity_type: str = "character",
        allow_corp_actorless_control: bool = False,
    ) -> None:
        self._supabase_url = base_url or os.getenv("SUPABASE_URL")
        self._service_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
        self._api_token = os.getenv("SUPABASE_API_TOKEN")

        self._client: Client = create_client(self._supabase_url, self._service_key)
        self._character_id = character_id
        self._actor_character_id = actor_character_id
        self._transport = transport
        self._entity_type = entity_type
        self._allow_corp_actorless_control = allow_corp_actorless_control
        self._event_handlers: Dict[str, list[Callable[[dict], Any]]] = {}

    def on(self, event_name: str):
        def decorator(callback: Callable[[dict], Any]):
            self._event_handlers.setdefault(event_name, []).append(callback)
            return callback
        return decorator

    def _call_edge_function(self, function_name: str, params: dict):
        response = self._client.functions.invoke(
            function_name,
            invoke_options={
                "body": params,
                "headers": {"X-API-Token": self._api_token},
            },
        )
        return response.json()

    async def join(self, character_id: Optional[str] = None):
        target = character_id or self._character_id
        result = self._call_edge_function("join", {"character_id": target})
        return result

    async def move(self, to_sector: int, character_id: Optional[str] = None):
        target = character_id or self._character_id
        return self._call_edge_function("move", {
            "character_id": target,
            "to_sector": to_sector,
        })

    # ... implement every existing API method (see planning-files/python-sdk-integration.md)
```

**Full implementation:** See `planning-files/python-sdk-integration.md` for complete code.

#### 5.4 Voice Bot Integration (Days 6-7)
- **Change one import line** in files that use AsyncGameClient
- Test real-time event delivery to voice bot
- Verify task agent can execute all game actions

**Update imports in:**
- `utils/tools_schema.py`
- `npc/run_npc.py`
- Any test files

```python
# FROM:
from utils.api_client import AsyncGameClient

# TO:
from utils.supabase_client import AsyncGameClient

# Everything else stays EXACTLY the same!
```

**Deliverables:**
- All integration tests passing
- Performance benchmarks documented
- Python SDK client fully functional
- Voice bot successfully migrated

#### 5.5 Performance Benchmarking (Days 5-6)
- Instrument the Supabase-backed `AsyncGameClient` integration tests to capture p50/p95/p99 latencies for `join`, `move`, `trade`, and `my_status`.
- Record baseline metrics from the legacy FastAPI server for comparison.
- Define target SLOs: p95 <200 ms for `join`/`move`, p99 <500 ms for every RPC.
- Add Grafana/Supabase dashboard panels surfacing these metrics for ongoing monitoring.

---

## Phase 6: Cutover & Deployment (Week 6)

### Goals
- Final validation and testing
- Deploy to production
- Monitor and resolve issues

### Tasks

#### 6.1 Pre-Cutover Validation (Days 1-2)
- Run full test suite one final time
- Verify all edge functions deployed
- Test backup/restore procedures
- Validate monitoring and alerting

**Pre-Flight Checklist:**
- [ ] All 37 edge functions deployed
- [ ] Database schema matches specification
- [ ] Seed scripts executed and validated
- [ ] Python SDK tested with all endpoints
- [ ] Realtime Broadcast working
- [ ] Rate limiting configured
- [ ] Secrets properly set
- [ ] Backup procedures tested
- [ ] Supabase billing alerts configured at 50%, 75%, and 90% of monthly limits

#### 6.2 Production Deployment (Day 3)

**Morning:**
- Capture git tag for pre-Supabase baseline (`pre-supabase`)
- Deploy updated voice bot code

**Afternoon:**
- Switch environment variables to production Supabase
- Monitor error logs closely
- Test critical paths (join, move, trade, combat)

```bash
# Update production .env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_API_TOKEN=...

# Restart voice bot
systemctl restart gradient-bang-voice-bot
```

#### 6.3 Monitoring & Validation (Days 4-5)
- Monitor Supabase dashboard for errors
- Check rate limit metrics
- Validate event delivery
- Track database query performance

**Key Metrics:**
- Edge function invocation count
- Average response time
- Error rate (should be <1%)
- Database connection pool usage
- Events table growth rate

#### 6.4 Documentation & Cleanup (Days 6-7)
- Document new architecture
- Update CLAUDE.md with Supabase details
- Retire legacy filesystem notes (mark as deprecated, keep for reference)
- Create runbook for common operations

**Updated CLAUDE.md sections:**
```markdown
## Supabase Architecture

The game server now runs on Supabase with:
- PostgreSQL database for all game state
- Edge Functions for all RPC endpoints
- Realtime Broadcast for event delivery

### Environment & Operations
Reference Appendix B for environment variables and Section 2.1’s “Shared Utilities” block for the standard Supabase CLI workflow (start, deploy, migrate, logs). Keeping those details centralized avoids copy/paste drift.

**Deliverables:**
- Production system fully operational
- Monitoring and alerting configured
- Documentation updated
- Team trained on new architecture

---

## Risk Mitigation

### High-Risk Areas

**1. Seed Data Integrity**
- **Risk:** Incorrect or incomplete seed data compromises gameplay
- **Mitigation:**
  - Comprehensive validation scripts
  - Idempotent Supabase "bang" + reset tooling (always start fresh)
  - Automated smoke tests that run immediately after seeding

**2. Performance Degradation**
- **Risk:** Database queries slower than legacy operations
- **Mitigation:**
  - Benchmark critical paths before cutover
  - Proper indexing strategy
  - Connection pooling configured

**3. Event Delivery Reliability**
- **Risk:** Events not reaching all intended recipients
- **Mitigation:**
  - Dual-write events (both table + broadcast) for redundancy
  - Event query endpoint allows clients to catch up
  - Comprehensive testing of fan-out logic

**4. Rate Limiting False Positives**
- **Risk:** Legitimate requests blocked by rate limits
- **Mitigation:**
  - Conservative initial limits (can tighten later)
  - Monitor rate limit hit rates
  - Per-endpoint configuration allows fine-tuning

### Rollback Plan

- No production rollback scripts are required because all Supabase work occurs in a separate worktree/branch. If we need to revert, we simply deploy the current main branch with the existing filesystem backend.

---

## Success Criteria

### Technical Metrics
- [ ] All edge functions operational (100% success rate)
- [ ] `join`/`move` p95 latency <200 ms and p99 <500 ms (tracked in dashboards)
- [ ] Event delivery latency <1s
- [ ] Seed + production data validated with zero integrity issues
- [ ] Rate limiting prevents runaway loops (validated in testing)

### Functional Requirements
- [ ] Voice bot can execute all game actions
- [ ] Admin CLI tools work with Supabase backend
- [ ] Realtime events visible in firehose viewer
- [ ] Character creation/deletion works
- [ ] Trading system with optimistic locking functional
- [ ] Combat system operational
- [ ] Map knowledge persists correctly

### Operational Requirements
- [ ] Team trained on Supabase operations
- [ ] Documentation complete and accurate
- [ ] Monitoring and alerting configured
- [ ] Backup/restore procedures tested
- [ ] Supabase worktree kept isolated from production branch (documented cutover steps)

---

## Post-Migration Enhancements

### Phase 2 Features (Future)
Once server-only architecture is stable, consider:

1. **Multi-Ship Support** (2 weeks)
   - Add ship_id parameter to edge functions
   - Ship switching endpoint
   - Fleet management UI

2. **Event Partitioning** (1 week)
   - Monthly partitions for events table
   - Automated partition maintenance
   - Archive old partitions to cold storage

3. **Advanced Leaderboards** (1 week)
   - Materialized views for rankings
   - Wealth leaderboard (credits + ship value)
   - Territory leaderboard (garrisons by sector)

4. **Analytics Dashboard** (2 weeks)
   - Grafana + Supabase integration
   - Player activity metrics
   - Economy tracking (trade volume, commodity prices)

5. **Public API (Optional)**
   - If you ever want to expose read-only data publicly
   - Would add RLS policies for public tables
   - OAuth for user authentication
   - Rate limiting per API key

---

## Appendix

### A. File-Based to Supabase Mapping (Legacy Reference)

| Legacy Source (optional) | Supabase Table | Notes |
|--------------------------|----------------|-------|
| universe-generation-parameters.json | universe_config | Singleton row |
| universe_structure.json | universe_structure | 5000 rows |
| port-states/sector_*.json | ports | ~200 rows |
| sector_contents.json | sector_contents | Includes combat + salvage JSONB |
| ships.json | ship_instances | Includes owner_type + corp ownership columns |
| characters.json | characters | Player data + corp ship profiles |
| character-map-knowledge/*.json | characters.map_knowledge | JSONB column |
| corporation_registry.json | corporations | Name → corp_id mapping |
| corporations/*.json | corporation_members & corporation_ships | Membership lists + corp ship associations |
| garrison files | garrisons | Separate table |

### B. Environment Variables Reference

**Supabase Project:**
```bash
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=eyJ... # Not used (no public access)
SUPABASE_SERVICE_ROLE_KEY=eyJ... # Used by all servers
```

**Edge Functions:**
```bash
API_TOKEN=... # X-API-Token header value
```

**Voice Bot:**
```bash
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_API_TOKEN=...
OPENAI_API_KEY=... # Unchanged
```

**Admin CLI:**
```bash
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_API_TOKEN=...
```

### C. Cost Estimation

**Supabase Pricing (as of 2024):**

**Free Tier:**
- 500 MB database
- 2 GB bandwidth
- 500,000 edge function invocations/month
- Suitable for development and early testing

**Pro Tier ($25/month):**
- 8 GB database (can upgrade)
- 50 GB bandwidth
- 2 million edge function invocations/month
- Suitable for production with moderate usage

**Estimated Production Costs:**
- Voice bot: ~10,000 requests/day = 300k/month → **Free tier sufficient**
- Database size: Universe (5000 sectors) + characters + events → **~500 MB initially, grow to ~2 GB** → **Pro tier recommended**
- Bandwidth: Minimal (JSON responses, no media) → **Well under limits**

**Recommendation:** Start with **Pro tier** for production ($25/month) for reliability and growth headroom.

---

## Complete Implementation Checklist

This section provides a comprehensive checklist of every component that needs to be created for the Supabase migration. Check off items as you complete them.

### Phase 1: Database Schema

#### Core Tables (13 total)
- [ ] `universe_config` table definition
- [ ] `universe_structure` table definition
- [ ] `ports` table definition
- [ ] `sector_contents` table definition (including `planets JSONB DEFAULT '[]'`)
- [ ] `garrisons` table definition
- [ ] `ship_definitions` table definition
- [ ] `ship_instances` table definition
- [ ] `characters` table definition
- [ ] `corporations` table definition
- [ ] `corporation_members` table definition
- [ ] `corporation_ships` table definition
- [ ] `events` table definition
- [ ] `rate_limits` table definition

#### Indexes (20 total)
- [ ] `idx_universe_structure_region` on universe_structure(region)
- [ ] `idx_ports_sector` on ports(sector_id)
- [ ] `idx_ports_updated` on ports(last_updated)
- [ ] `idx_sector_contents_updated` on sector_contents(updated_at)
- [ ] `idx_sector_contents_port` on sector_contents(port_id)
- [ ] `idx_garrisons_sector` on garrisons(sector_id)
- [ ] `idx_garrisons_owner` on garrisons(owner_id)
- [ ] `idx_ship_instances_owner_character` on ship_instances(owner_character_id) WHERE owner_character_id IS NOT NULL
- [ ] `idx_ship_instances_owner_corporation` on ship_instances(owner_corporation_id) WHERE owner_corporation_id IS NOT NULL
- [ ] `idx_ship_instances_sector` on ship_instances(current_sector)
- [ ] `idx_ship_instances_hyperspace` on ship_instances(in_hyperspace, hyperspace_eta)
- [ ] `idx_characters_name` on characters(name)
- [ ] `idx_characters_ship` on characters(current_ship_id)
- [ ] `idx_characters_active` on characters(last_active)
- [ ] `idx_characters_npc` on characters(is_npc) WHERE is_npc = TRUE
- [ ] `idx_corporations_lower_name` UNIQUE on (lower(name))
- [ ] `idx_corporation_members_character` on corporation_members(character_id)
- [ ] `idx_corporation_members_corp` on corporation_members(corp_id)
- [ ] `idx_corporation_ships_corp` on corporation_ships(corp_id)
- [ ] `idx_corporation_ships_ship` on corporation_ships(ship_id)

#### Foreign Key Constraints (11 total)
- [ ] ship_instances.owner_character_id → characters(character_id) ON DELETE CASCADE
- [ ] ship_instances.owner_corporation_id → corporations(corp_id) ON DELETE CASCADE
- [ ] corporations.founder_id → characters(character_id)
- [ ] corporations.invite_code_generated_by → characters(character_id)
- [ ] corporation_members.corp_id → corporations(corp_id) ON DELETE CASCADE
- [ ] corporation_members.character_id → characters(character_id) ON DELETE CASCADE
- [ ] corporation_ships.corp_id → corporations(corp_id) ON DELETE CASCADE
- [ ] corporation_ships.ship_id → ship_instances(ship_id) ON DELETE CASCADE
- [ ] garrisons.owner_id → characters(character_id) ON DELETE CASCADE
- [ ] characters.current_ship_id → ship_instances(ship_id)
- [ ] sector_contents.port_id → ports(port_id)

#### Database Function (1 optional)
- [ ] `get_characters_aware_of_sector(sector_id)` - Returns characters with ships or garrisons in sector

### Phase 2: Initial Data Seeding

#### Universe Generation
- [ ] Build SQL or Python seeding script to create baseline universe_config row
- [ ] Generate deterministic universe_structure data set (target 5,000 sectors)
- [ ] Populate ports with starter inventory (≈200 rows)
- [ ] Populate sector_contents with default state (trade inventories, salvage arrays empty)

#### Ship & Character Seeds
- [ ] Define ship_definitions entries for launch ship types (`kestrel_courier`, `hawk_trader`, etc.)
- [ ] Insert starter characters (e.g., admin/test accounts) with associated ship_instances
- [ ] Seed initial credits, cargo, and warp states consistent with game balance

#### Corporation Seeds (Optional)
- [ ] Insert sample corporations with founder metadata and invite codes
- [ ] Populate corporation_members with joined_at timestamps for seeded players
- [ ] Associate corporation_ships where applicable and ensure owner metadata is coherent

#### Data Validation
- [ ] Verify universe_config row count (1)
- [ ] Verify universe_structure row count (target 5,000)
- [ ] Verify ports row count matches seed design
- [ ] Verify sector_contents row count matches sector count
- [ ] Verify ship_definitions loaded correctly
- [ ] Confirm seeded corporations, members, and ships match expected totals

### Phase 3: Edge Functions - Shared Utilities

#### Shared Modules (3 files in `supabase/functions/_shared/`)
- [ ] `auth.ts` - Token validation utilities
  - [ ] `validateApiToken(req)` function
  - [ ] `unauthorizedResponse()` function
  - [ ] `errorResponse(message, status)` function
  - [ ] `successResponse(data)` function

- [ ] `rate_limiting.ts` - Rate limit helpers
  - [ ] `RATE_LIMITS` configuration object
  - [ ] `checkRateLimit(supabase, character_id, endpoint)` function

- [ ] `events.ts` - Event emission helpers
  - [ ] `emitSectorEvent(supabase, event_type, sector_id, payload, sender_id)` function
  - [ ] `emitCharacterEvent(supabase, event_type, character_id, payload, sender_id)` function

### Phase 4: Edge Functions - Character Management (5 functions)

All character management RPCs reuse the shared auth + rate-limiting helpers and log results to the `events` table. Each function returns the same payloads expected by the legacy FastAPI endpoints.

- `join`: Load the requesting character/ship/sector, emit `character.joined`, and return the full session state.
- `my_status`: Fetch current ship stats plus ship definition caps and return the status payload.
- `character_create`: Validate name uniqueness, create the character + starter ship, link `current_ship_id`, and return both IDs.
- `character_delete`: Delete the character with cascading ships/garrisons and report the counts removed.
- `character_modify`: Update mutable metadata fields and return the updated record.

### Phase 5: Edge Functions - Movement & Navigation (4 functions)

Movement endpoints enforce adjacency, warp capacity, and event emissions, while read-only helpers expose navigation data.

- `move`: Validate adjacency + warp costs, transition through hyperspace, update `ship_instances`, and emit departure/arrival/map events.
- `plot_course`: BFS between sectors and return hops + route metadata.
- `local_map_region`: Run constrained BFS around the player and return sector/port summaries.
- `path_with_region`: Provide region-aware paths with optional hop/region filters to support NPC routing.

### Phase 6: Edge Functions - Trade & Economy (7 functions)

- Shared behavior: token auth, optimistic locking on ports, and consistent emissions of `trade.*`/`status.*` events.
- `list_known_ports`: Filter the caller’s map knowledge by commodity, type, and hop constraints.
- `trade`: Perform buy/sell operations with port row-locking, ship capacity checks, and stock/version updates.
- `dump_cargo`: Zero out requested cargo keys (permitted ships only) and emit status updates.
- `transfer_credits`: Lock both ships, enforce corp restrictions, transfer credits, and emit dual events.
- `bank_transfer`: Move funds between ship and `characters.credits_in_bank`, enforcing corp rules.
- `recharge_warp_power`: Validate Megaport access, charge credits, and refill warp power.
- `transfer_warp_power`: Move warp units between ships in the same sector with validation + events.

### Phase 7: Edge Functions - Ship Acquisition (1 function)

`ship.purchase` handles both personal and corporation purchases: verify funding source, optional trade-ins, ship definition validity, new `ship_instance` creation, `characters.current_ship_id` updates, corporation ship registry updates, and the relevant status/corporate events.

### Phase 8: Edge Functions - Combat (5 functions)

- `combat_initiate`: Ensure the sector has no active encounter, create the combat JSONB payload, and broadcast `combat.initiated`.
- `combat_action`: Validate participation, record the player’s action, and when all actions are present resolve the round synchronously (load/modify/save JSONB + emit events).
- `combat_leave_fighters`: Move fighters into a sector garrison record and emit deployment events.
- `combat_collect_fighters`: Pull fighters back from the garrison into the ship and emit collection events.
- `combat.set_garrison_mode`: Update garrison behavior/tolling metadata and notify the sector.

**Combat State Manager Notes:**
- Implement `supabase/functions/_shared/combat_state.ts` that loads/saves the encounter JSONB, resolves rounds, and enforces timeouts.
- Auto-garrison logic runs opportunistically whenever an edge function touches combat data—before returning, each function checks for expired timers and advances the encounter if needed (no cron job required).
- Hyperspace timers remain authoritative in `ship_instances`, so combat functions always confirm the participant is still present before applying damage/outcomes.

### Phase 9: Edge Functions - Corporations (8 functions)

- `corporation.create`: Validate eligibility, deduct the creation fee, create corp + founder membership, and emit `corporation.created` with invite metadata.
- `corporation.join`: Verify invite codes, add the new member, and inform the roster.
- `corporation.regenerate_invite_code`: Rotate invite tokens with auditing and broadcast the change.
- `corporation.leave`: Remove the member (or disband if last) and emit the appropriate events.
- `corporation.kick`: Allow admins to remove another member with corresponding notifications.
- `corporation.info`: Return detailed info for members, limited info for non-members.
- `corporation.list`: Provide paginated summaries for discovery.
- `my.corporation`: Fast membership lookup including invite and roster metadata.

### Phase 10: Edge Functions - Salvage & Events (3 functions)

- `salvage_collect`: Remove a salvage entry from `sector_contents`, transfer loot to the ship, and emit character + sector events.
- `event_query`: Return paginated, optionally filtered rows from the `events` table so clients can catch up after reconnecting.
- `send_message`: Allow admins to post a broadcast by inserting per-character events and publishing via Realtime.

### Phase 11: Python Client Implementation

Implement `utils/supabase_client.AsyncGameClient` as a drop-in replacement for `utils/api_client.AsyncGameClient`. Keep the constructor signature, context-manager hooks, event handler registration, and every public coroutine exactly aligned with the legacy client (character, movement, trade, ship, corporation, combat APIs, etc.). Reuse helper methods where possible rather than duplicating method-by-method checklists; the single source of truth for supported calls remains `utils/api_client.py`.

#### Salvage & Events Methods
- [ ] `async salvage_collect(salvage_index, character_id)` - Collect salvage
- [ ] `async event_query(character_id, event_type, since_timestamp, limit)` - Query events

### Phase 12: Realtime Event Subscriptions

Build `utils/supabase_realtime.RealtimeEventListener`, matching the legacy event subscription API (`on`, `on_any`, `start`, `stop`) while internally subscribing to `character:{character_id}` broadcast channels.

### Phase 13: Helper Scripts & Tools

#### Seeding & Maintenance
- Port the existing universe/ship/corporation seed scripts so they target Supabase tables, plus a `reset_supabase.py` helper that truncates and reruns them.

#### Testing & Validation Utilities
- Lightweight scripts for validating seeds, smoke-testing edge functions, and auditing corporation data should be added or updated as needed.

#### Admin Tools
- Update CLI helpers (e.g., `character_lookup.py`, `character_modify.py`) to call Supabase; add small admin utilities for corp invite rotation and Supabase maintenance tasks.

### Phase 14: Testing

#### Testing Scope
- Unit coverage for the Supabase client, Realtime listener, and representative edge functions.
- Integration passes covering end-to-end flows (character lifecycle, movement/trade, combat, corporation actions, bank/transfer flows, salvage, event fan-out, rate limiting, optimistic locking).
- Seed validation and lightweight load tests to prove deterministic seeding + reset tooling.

### Phase 15: Documentation Updates

#### Code Documentation
- Update `CLAUDE.md`/README with Supabase architecture, local dev steps, client usage, deployment workflow, and env var references (linking back to Appendix B to avoid drift).

#### Developer Guides
- [ ] Create Supabase local development guide
- [ ] Document edge function debugging techniques
- [ ] Create troubleshooting guide for common issues

### Phase 16: Import Statement Updates

#### Change Imports to Use Supabase Client
- [ ] `utils/tools_schema.py` - Change AsyncGameClient import
- [ ] `npc/run_npc.py` - Change AsyncGameClient import
- [ ] `npc/simple_tui.py` - Change AsyncGameClient import
- [ ] `tools/firehose_viewer.py` - Update to use Realtime subscriptions
- [ ] `tools/character_viewer.py` - Change AsyncGameClient import
- [ ] All test files - Change AsyncGameClient imports

### Phase 17: Deployment

#### Local Deployment
- [ ] Start local Supabase: `supabase start`
- [ ] Apply migrations: `supabase db reset`
- [ ] Serve edge functions: `supabase functions serve`
- [ ] Test all endpoints locally
- [ ] Verify Realtime broadcasts work

#### Remote Deployment
- [ ] Create production Supabase project
- [ ] Apply database migrations to production
- [ ] Deploy all edge functions: `supabase functions deploy`
- [ ] Set production secrets: `supabase secrets set`
- [ ] Update production environment variables
- [ ] Run smoke tests against production

#### Cutover
- [ ] Snapshot Supabase schema/data prior to go-live
- [ ] Update production .env files
- [ ] Restart voice bot server
- [ ] Monitor error logs
- [ ] Verify event delivery working
- [ ] Test critical paths (join, move, trade, combat)

### Phase 18: Monitoring & Validation

#### Post-Deployment Checks
- [ ] Monitor Supabase dashboard for errors
- [ ] Check edge function invocation counts
- [ ] Verify database query performance
- [ ] Monitor rate limit hit rates
- [ ] Check event table growth rate
- [ ] Validate Realtime broadcast latency

#### Performance Validation
- [ ] Measure average response times for critical endpoints
- [ ] Establish new Supabase performance baseline
- [ ] Identify and optimize slow queries
- [ ] Verify connection pooling working correctly

---

## Total Deliverables Summary

**Database Components:** 13 tables, 20 indexes, 11 foreign keys, 1 optional function
**Edge Functions:** 30+ functions across 8 categories (incl. corporations & maintenance)
**Python Code:** 1 client class with 25+ methods, 1 realtime listener class
**Helper Scripts:** 8+ utility scripts (universe, ships, corporations)
**Tests:** 12+ test files covering unit, integration, and migration
**Documentation:** 3+ documentation updates
**Deployment:** Local + remote deployment procedures

---

## Conclusion

This 7-week plan (Week 0 prep + 6 execution weeks) keeps the migration structured without duplicating effort. The server-only Supabase architecture keeps auth simple while unlocking ACID storage, Realtime events, and cleaner tooling.

**Key Success Factors:**
1. Comprehensive testing at each phase
2. Deterministic seeding + validation before cutover
3. Separate worktree to keep rollback as simple as redeploying the current filesystem backend
4. Team training on new architecture
5. Monitoring, billing alerts, and performance dashboards from day 1

With this approach we can modernize the infrastructure while preserving existing gameplay, setting the stage for future enhancements like multi-ship support and analytics.
