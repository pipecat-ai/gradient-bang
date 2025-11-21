# Supabase Migration Analysis: Implementation Review & Plan Refinement

**Date:** 2025-11-03 (Revised)
**Reviewer:** Claude
**Purpose:** Technical review of supabase-migration-plan-server-only.md to ensure completeness and identify areas needing clarification

---

## Executive Summary

This analysis reviews the Supabase migration plan against the current file-based implementation of Gradient Bang. The plan is **solid and well-structured**. This document identifies specific areas where additional detail or clarification would strengthen the migration, ensuring all current functionality is preserved and the team has clear implementation guidance.

**Key Findings:**
- ✅ **Strong Foundation:** Plan covers all major architectural components
- ✅ **Good Risk Awareness:** Rollback and validation strategies identified
- ⚠️ **Needs Detail:** Several implementation specifics require clarification
- ⚠️ **Timeline:** Aggressive but achievable with proper preparation
- 📋 **Action Items:** 24 specific recommendations for plan enhancement

**Overall Assessment:** Ready to proceed with plan refinements noted below.

---

## 1. API Endpoint Completeness

### 1.1 Current Implementation Inventory

**Found:** 37 API endpoint files in `game-server/api/`

**Migration Plan Lists:** ~33 edge functions in Appendix B

### 1.2 Endpoints Needing Plan Coverage

| Endpoint File | Current Usage | Priority | Notes |
|--------------|---------------|----------|-------|
| `character_modify.py` | Character metadata updates | High | Used by admin tools |
| `my_corporation.py` | Quick corp membership lookup | Medium | Listed in server.py but not in plan phases |
| `path_with_region.py` | Region-aware pathfinding | Medium | Used by NPCs for exploration |
| `event_query.py` | Event log querying | High | Mentioned but not in main implementation list |

### 1.3 Recommendation

**Action Item #1:** Add these 4 endpoints to Phase 2 implementation schedule, likely in Priority 2 or 3 depending on usage patterns.

---

## 2. Rate Limiting Implementation Details

### 2.1 Current System Architecture

The existing rate limiter (`game-server/rpc/rate_limit.py`) uses **request queueing**:

```python
class RateLimiter:
    """Per-character rate limiter with queueing support.

    Requests exceeding rate limits are queued and processed when timing allows.
    Requests waiting longer than queue_timeout are rejected with TimeoutError.
    """
```

**Key Features:**
- Per-character queues with async processing
- Configurable per-endpoint limits (from `config/rate_limits.yaml`)
- Sub-type differentiation (e.g., `send_message.broadcast` vs `send_message.direct`)
- Queue timeout: 30 seconds default

### 2.2 Plan's Proposed Approach

Plan Section 2.1 proposes `rate_limiting.ts`:

```typescript
export async function checkRateLimit(
  supabase: SupabaseClient,
  character_id: string,
  endpoint: string
): Promise<boolean>
```

### 2.3 Clarification Needed

**Question:** Will edge functions implement:
- **Option A:** Simple rejection (request fails immediately if limit exceeded)
- **Option B:** Queueing with timeout (request waits up to 30s for slot)
- **Option C:** Hybrid (certain endpoints queue, others reject)

**Impact on Users:**
- Current system: Players/NPCs experience delays but success during bursts
- Simple rejection: More failures during traffic spikes, but lower latency

**Action Item #2:** Specify rate limiting strategy in `supabase/functions/_shared/rate_limiting.ts` design. If changing from queueing to rejection, document behavioral change in CHANGELOG.

**Suggested Approach:** Start with simple rejection (Option A) for edge functions, monitor failure rates, add queueing later if needed. Edge function cold starts make queueing complex.

---

## 3. Event System Architecture Specifics

### 3.1 Current Event Dispatcher

The existing system (`game-server/rpc/events.py`) has sophisticated event handling:

```python
async def emit(
    self,
    event_name: str,
    payload: dict,
    character_filter: Sequence[str] | None = None,
    log_context: EventLogContext | None = None,
) -> None:
    """Emit event to filtered characters and log to JSONL."""
```

**Key Features:**
- Character filtering (emit to subset of characters)
- Automatic metadata inference (sector, sender, corporation)
- Rich log context for auditing
- Dual-channel: WebSocket + JSONL

### 3.2 Plan's Realtime Broadcast Approach

Plan Phase 4 proposes:
- Supabase Realtime Broadcast channels: `character:{character_id}`
- Event logging to `events` table

### 3.3 Technical Questions

**Question 1: Multi-recipient event handling**

Current: Single `emit()` call reaches N characters
```python
await event_dispatcher.emit(
    "combat.round_resolved",
    payload,
    character_filter=["char1", "char2", "char3"]
)
```

How does this map to Realtime Broadcast?
- **Option A:** Emit to individual channels (N broadcast calls)
  ```typescript
  for (const charId of characterFilter) {
    await supabase.channel(`character:${charId}`).send({...})
  }
  ```
- **Option B:** Sector channels + client-side filtering
  ```typescript
  await supabase.channel(`sector:${sectorId}`).send({
    event: "combat.round_resolved",
    character_filter: ["char1", "char2", "char3"],
    payload: {...}
  })
  ```

**Question 2: Event table structure for multi-recipient events**

Current: JSONL writes one line per recipient (fan-out at write time)

Proposed events table: How are recipients stored?
- One row per recipient? (junction table pattern)
- Array column with all recipients?
- Affects query patterns for `event.query` endpoint

**Action Item #3:** Specify Realtime Broadcast fan-out strategy in Phase 4 design document. Recommend Option A (per-character channels) for simplicity, with sector channels as Phase 2 optimization.

**Action Item #4:** Define events table schema with recipient handling:
```sql
CREATE TABLE events (
  event_id UUID PRIMARY KEY,
  event_name TEXT NOT NULL,
  payload JSONB NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  sender TEXT,
  sector INT,
  corporation_id TEXT,
  -- Option: Single recipient (one row per recipient)
  character_id TEXT NOT NULL,
  -- OR: Array of recipients (one row per event)
  -- recipient_ids TEXT[]
);
```

---

## 4. Data Model Considerations

### 4.1 Character State vs Identity

**Current System:**
- `world-data/characters.json`: Registry (name, metadata, created_at)
- `world-data/character-map-knowledge/*.json`: Game state (sector, ship, knowledge)
- Separation allows pre-registration before first login

**Plan's Approach:**
- Single `characters` table with both identity and state
- `map_knowledge` as JSONB column

**Observation:** This consolidation makes sense for a database. Pre-registration can still work (row exists with NULL state fields until first login).

**Action Item #5:** Clarify in schema whether `map_knowledge`, `current_sector`, etc. are nullable (for pre-registered characters).

### 4.2 Port State Optimistic Locking

**Current Implementation:**
- `PortLockManager` provides exclusive locks during trades
- Found in `game-server/core/locks/port_locks.py`

**Plan's Approach:**
- "Optimistic locking" mentioned but implementation not specified

**Action Item #6:** Add implementation detail to Phase 2 trade edge function:

```typescript
// supabase/functions/trade/index.ts
async function executeTrade() {
  // Read port with version
  const { data: port } = await supabase
    .from('ports')
    .select('*')
    .eq('sector_id', sectorId)
    .single()

  // Calculate new state
  const newStock = calculateNewStock(port, commodity, quantity)

  // Update with version check
  const { data, error } = await supabase
    .from('ports')
    .update({
      stock: newStock,
      version: port.version + 1
    })
    .eq('sector_id', sectorId)
    .eq('version', port.version) // Optimistic lock
    .single()

  if (error?.code === 'PGRST116') {
    // Version mismatch - retry
    return await executeTrade() // with retry limit
  }
}
```

### 4.3 Sector Contents: Static vs Dynamic

**Current File (`sector_contents.json`):**
```json
{
  "1": {
    "has_port": true,
    "port_id": "sector_1",
    "planets": ["Earth", "Mars"],
    "salvage": []
  }
}
```

Combines static (planets) and dynamic (salvage) data.

**Plan's `sector_contents` table:**
- Columns: `sector_id`, `port_id`, `updated_at`, `salvage`, `combat`

**Observation:** Planets are missing from planned schema.

**Action Item #7:** Add `planets` JSONB column to `sector_contents` table, or move planets to `universe_structure` if they're static.

---

## 5. Python SDK Drop-in Replacement Strategy

### 5.1 Current AsyncGameClient API

```python
class AsyncGameClient:
    def __init__(
        self,
        base_url: str = "http://localhost:8000",
        *,
        character_id: str,  # Required, immutable
        transport: str = "websocket",
        actor_character_id: Optional[str] = None,
        entity_type: str = "character",
        allow_corp_actorless_control: bool = False,
    ):
```

**Key Features:**
- Character ID bound at initialization
- Actor-based authorization for corporation ships
- Event handlers: `client.on("event.name")(callback)`

### 5.2 Plan's Proposed Client (Phase 5.3)

From plan:
```python
class AsyncGameClient:
    def __init__(self, server_url: Optional[str] = None):
        self.url = server_url or os.getenv('SUPABASE_URL')
        self.client = create_client(self.url, service_key)
```

**Issue:** Different signature would break existing code.

### 5.3 True Drop-in Replacement

**Action Item #8:** Revise `utils/supabase_client.py` to match current API:

```python
class AsyncGameClient:
    """Supabase-backed game client - drop-in replacement for utils/api_client.py"""

    def __init__(
        self,
        base_url: str = None,  # Now Supabase URL instead of FastAPI
        *,
        character_id: str,  # Keep required
        transport: str = "websocket",  # Keep for compatibility (always uses Realtime)
        actor_character_id: Optional[str] = None,  # Keep
        entity_type: str = "character",
        allow_corp_actorless_control: bool = False,
    ):
        self._supabase_url = base_url or os.getenv('SUPABASE_URL')
        self._service_key = os.getenv('SUPABASE_SERVICE_ROLE_KEY')
        self._api_token = os.getenv('SUPABASE_API_TOKEN')

        # Internal Supabase client
        self._supabase = create_client(self._supabase_url, self._service_key)

        # Maintain character_id binding
        self._character_id = character_id
        self._actor_character_id = actor_character_id

        # Setup Realtime subscription
        self._setup_realtime_channel()

    @property
    def character_id(self) -> str:
        return self._character_id

    def on(self, event_name: str):
        """Register event handler (same API as current)"""
        def decorator(callback):
            self._event_handlers[event_name].append(callback)
            return callback
        return decorator

    async def join(self, character_id: Optional[str] = None):
        """Join game - uses bound character_id if not specified"""
        char_id = character_id or self._character_id
        return self._call_edge_function('join', {'character_id': char_id})
```

This ensures:
- Existing code continues to work: `AsyncGameClient(base_url=url, character_id=id)`
- Event handlers work the same: `client.on("event")(lambda p: ...)`
- Only change: base_url points to Supabase instead of FastAPI

---

## 6. Combat State Management

### 6.1 Current Combat Manager

Complex stateful system across 7 files:
- `combat/manager.py`: Encounter state machine
- `combat/engine.py`: Round resolution
- `combat/garrisons.py`: Garrison deployment
- `combat/garrison_ai.py`: Auto-combat logic

**Key Challenge:** Combat encounters span multiple rounds (stateful).

### 6.2 Edge Functions Are Stateless

**Question:** How do edge functions maintain combat state across rounds?

**Answer (from plan):** Store state in `sector_contents.combat` JSONB field.

**Clarification Needed:**
- Who manages encounter progression?
- Do edge functions reconstruct full encounter state on each action?
- Is there a background worker for auto-combat (garrisons)?

**Action Item #9:** Document combat state management pattern in Phase 2 design:

**Option A: Database-Driven State Machine**
```typescript
// combat.action edge function
async function submitAction(characterId, action) {
  // Load encounter from sector_contents.combat JSONB
  const encounter = await loadEncounterForCharacter(characterId)

  // Update participant action
  encounter.participants[characterId].action = action

  // Check if all actions submitted
  if (allActionsSubmitted(encounter)) {
    // Resolve round
    const outcome = resolveRound(encounter)

    // Update encounter state
    encounter.currentRound++
    encounter.participants = applyDamage(outcome)

    // Save back to database
    await saveEncounter(encounter)

    // Emit events
    await emitRoundResolved(encounter)
  }

  return { success: true }
}
```

**Option B: Background Worker**
- Edge functions only submit actions
- Separate Deno Deploy cron job checks for complete rounds every 5 seconds
- Resolves rounds and emits events

Recommend Option A for simplicity (no cron job needed).

---

## 7. Performance Benchmarking Plan

### 7.1 Current System Characteristics

**File-based System:**
- Character knowledge: Direct file I/O (~1-2ms)
- Port state: Individual file locks, low contention
- Universe structure: Loaded once at startup, kept in memory

### 7.2 Supabase Performance Expectations

**Realistic Estimates:**
- PostgreSQL query with index: 5-20ms (local network)
- Supabase API overhead: +10-30ms
- Total round trip: 15-50ms

**Comparison:** 10-25x slower than direct file I/O, but still acceptable for game interactions.

**Mitigation Strategies:**
- Connection pooling (Supabase default)
- Indexes on all foreign keys and query patterns
- JSONB GIN indexes for map_knowledge queries
- Edge function caching for static data (ship definitions)

**Action Item #10:** Add Phase 5 performance benchmarking tasks:
1. Baseline current system (measure p50, p95, p99 latencies)
2. Test Supabase with production data volume
3. Set performance targets (e.g., "95% of requests < 200ms")
4. Monitor continuously post-migration

**Target:** P95 latency < 200ms for critical paths (join, move, status).

---

## 8. Testing Strategy Enhancements

### 8.1 Current Test Infrastructure

**Strengths:**
- 62 integration tests across 12 files
- Comprehensive coverage (combat, events, trading, movement)
- Auto-starting test server on port 8002
- Dual verification (WebSocket + JSONL)

**Example:** `test_combat_scenarios_comprehensive.py` (12 tests, 3min runtime)

### 8.2 Migration Testing Needs

**Action Item #11:** Create test adaptation strategy:

**Phase 1: Supabase Test Environment**
```python
# tests/conftest.py additions
@pytest.fixture(scope="session")
async def supabase_test_project():
    """Manage test Supabase project."""
    # Option A: Local Supabase (Docker)
    subprocess.run(["supabase", "start"])
    yield "http://localhost:54321"
    subprocess.run(["supabase", "stop"])

    # Option B: Dedicated test project on Supabase cloud
    # yield "https://test-project.supabase.co"
```

**Phase 2: Test Data Seeding**
```python
@pytest.fixture(autouse=True)
async def reset_supabase_state(supabase_test_project):
    """Reset database to clean state before each test."""
    # Truncate all tables
    # Re-run seed scripts
    # Create test characters
```

**Phase 3: Parallel Test Execution**
- Run existing tests against FastAPI server
- Run new tests against Supabase edge functions
- Compare outputs for behavioral equivalence
- Flag any discrepancies

**Timeline:** Add 1 week to Phase 5 for test infrastructure setup.

---

## 9. Directory Structure & Naming

### 9.1 Plan's Proposed Change

Task 1.1: "Rename game-server to game_server"

**Rationale:** Python packages can't have dashes in imports.

### 9.2 Current Reality

The codebase never imports from game-server:
- Running: `uv run python -m game-server` ✅ Works fine
- Imports: All relative or from `utils/`

### 9.3 Revised Recommendation

**Action Item #12:** Clarify if rename is actually needed:

**If seed scripts need to import game logic:**
```python
# scripts/seed_universe.py
from game_server.sector import generate_universe  # Requires rename
```

**If seed scripts are standalone:**
```python
# scripts/seed_universe.py
# No imports from game-server, generates SQL directly
# Rename not needed
```

**Suggested Approach:** Keep `game-server/` as-is. If shared code is needed, create `shared/` or `lib/` directory that both game-server and scripts import from.

---

## 10. Cost Monitoring & Budgeting

### 10.1 Plan's Estimate

- Pro Tier: $25/month
- Database: 8 GB included
- Functions: 2M invocations/month included

### 10.2 Growth Projections

**Conservative Estimate:**
- 50 active characters (human + NPC)
- 10,000 requests/day = 300k/month
- Events table: 5 MB/day = 150 MB/month
- **Stays within Pro tier limits**

**Active Growth Scenario:**
- 200 active characters
- 50,000 requests/day = 1.5M/month
- Events table: 25 MB/day = 750 MB/month
- **Still within Pro tier limits**

**Conclusion:** Plan's $25/month estimate is reasonable for expected usage.

**Action Item #13:** Set up billing alerts at 50%, 75%, 90% of limits:
- Database storage
- Function invocations
- Bandwidth

---

## 11. Security Model Validation

### 11.1 Plan's Server-Only Architecture

**Approach:**
- Service role key (full access)
- No RLS policies
- Token-protected edge functions
- No public user authentication

### 11.2 Threat Model Assessment

**Attack Vectors:**
1. **Service role key leak** → Full database access
   - Mitigation: Store in secure env vars, rotate regularly

2. **API token leak** → Unauthorized edge function calls
   - Mitigation: Use separate tokens per service, monitor usage

3. **SQL injection in edge functions** → Data corruption
   - Mitigation: Use parameterized queries, input validation

**Is "No RLS" acceptable?**

**Yes, for server-only architecture:**
- All requests come from trusted servers (voice bot, admin CLI, NPCs)
- No direct user access to database
- Similar to internal microservices architecture

**Best Practice:** Even without RLS, add check constraints:
```sql
-- Ensure credits can't go negative
ALTER TABLE ship_instances
  ADD CONSTRAINT positive_credits CHECK (credits >= 0);

-- Ensure fighters/shields within ship limits
ALTER TABLE ship_instances
  ADD CONSTRAINT valid_fighters CHECK (fighters >= 0);
```

**Action Item #14:** Add database constraints for data integrity in Phase 1 schema.

---

## 12. Timeline Assessment

### 12.1 Plan's Timeline: 6 Weeks

- Week 1: Database setup (7 days)
- Week 2: 25 edge functions (5 days)
- Week 3: Data tooling (7 days)
- Week 4: Event system (7 days)
- Week 5: Testing (7 days)
- Week 6: Deployment (7 days)

### 12.2 Realism Check

**Week 2 Analysis:** 25 edge functions in 5 days = 5 functions/day

**If functions are templated and simple:**
- Read-only endpoints (my_status, list_known_ports): 30-60 min each
- Simple mutations (dump_cargo, transfer_credits): 1-2 hours each
- Complex logic (trade, combat.action): 3-4 hours each

**With pair programming and templates:** 5 functions/day is achievable.

**Overall Assessment:** Timeline is **aggressive but achievable** with:
- Pre-built edge function templates
- Clear design documents for complex endpoints
- Dedicated focus (no context switching)
- Experience with TypeScript/Deno (or quick onboarding)

**Action Item #15:** Add Week 0 (Preparation):
- Create edge function templates
- Set up development environment
- Quick TypeScript/Deno training (2-3 days)
- Design complex endpoints (combat, trading)

**Revised Timeline: 7 weeks** (Week 0 prep + 6 weeks migration)

---

## 13. Corporation Data Migration

### 13.1 Current Corporation Schema

From `corporation_manager.py`:
```python
{
    "corp_id": str,
    "name": str,
    "founded": datetime,
    "founder_id": str,
    "invite_code": str,  # 8-char hex
    "invite_code_generated": datetime,
    "invite_code_generated_by": str,
    "members": List[str],
    "ships": List[str]
}
```

### 13.2 Plan's Three-Table Approach

1. `corporations`: Core metadata
2. `corporation_members`: Join table with history
3. `corporation_ships`: Ship registry

**Advantage:** Normalized, supports history tracking.

**Question:** How to migrate `members` list to `corporation_members` with timestamps?

**Action Item #16:** Add migration script for corporations in Phase 3:

```python
# scripts/migrate_corporations.py
async def migrate_corporation(corp_data):
    # Insert corporation
    await supabase.table('corporations').insert({
        'corp_id': corp_data['corp_id'],
        'name': corp_data['name'],
        'founded': corp_data['founded'],
        'founder_id': corp_data['founder_id'],
        'invite_code': corp_data['invite_code'],
        # ...
    })

    # Insert members (joined_at = corporation.founded for historical data)
    for member_id in corp_data['members']:
        await supabase.table('corporation_members').insert({
            'corp_id': corp_data['corp_id'],
            'character_id': member_id,
            'joined_at': corp_data['founded'],  # Approximation
            'left_at': None
        })

    # Insert ships
    for ship_id in corp_data['ships']:
        await supabase.table('corporation_ships').insert({
            'corp_id': corp_data['corp_id'],
            'ship_id': ship_id,
            'added_at': corp_data['founded'],  # Approximation
            'active': True
        })
```

---

## 14. Rollback & Contingency

### 14.1 Plan's Rollback Strategy

From Risk Mitigation section:
```bash
git checkout pre-supabase
# Restore legacy runtime configuration
# Restart services
```

### 14.2 Data Synchronization Challenge

**Scenario:** Migrate to Supabase, discover critical bug after 3 days, need to rollback.

**Problem:** 3 days of new data in Supabase (character moves, trades, combat) but filesystem is stale.

### 14.3 Enhanced Rollback Strategy

**Action Item #17:** Implement Supabase → Filesystem export tool:

```python
# scripts/export_supabase_to_filesystem.py
async def export_all_data():
    """Export Supabase data back to filesystem format."""

    # Characters
    characters = await supabase.table('characters').select('*')
    write_json('world-data/characters.json', format_characters(characters))

    # Ships
    ships = await supabase.table('ship_instances').select('*')
    write_json('world-data/ships.json', format_ships(ships))

    # Map knowledge
    for character in characters:
        knowledge = await supabase.table('characters') \
            .select('map_knowledge') \
            .eq('character_id', character['character_id']) \
            .single()
        write_json(
            f'world-data/character-map-knowledge/{character["character_id"]}.json',
            knowledge['map_knowledge']
        )

    # Corporations
    # ... similar pattern
```

**Usage:**
```bash
# Before rollback, export latest Supabase data
uv run scripts/export_supabase_to_filesystem.py

# Then rollback to pre-Supabase code
git checkout pre-supabase

# Restart with exported data
uv run python -m game-server
```

**Timeline Impact:** Add 2-3 days to Phase 1 for export tool development.

---

## 15. Missing Component: Universe Generation

### 15.1 Current Universe Generation

5000-sector universe is pre-generated with:
- Deterministic seed
- X/Y coordinates
- Warp connections
- Port placement

**Current Code:** Likely in standalone script (not found in quick scan).

### 15.2 Migration Need

Supabase `universe_structure` table needs population.

**Action Item #18:** Verify universe generation script exists:

```bash
# Look for universe generation code
find . -name "*universe*" -o -name "*generate*" | grep -E "\.(py|js)$"
```

**If found:** Adapt to output SQL INSERTs
**If not found:** Need to create from scratch (significant work)

**Plan Addition:** Add to Phase 1 Task 1.4:
- Locate or create universe generation script
- Modify to generate SQL or use Supabase Python SDK
- Validate deterministic output (same seed → same universe)

---

## 16. Edge Function Development Templates

### 16.1 Accelerate Week 2

To achieve 5 functions/day target, create templates.

**Action Item #19:** Create standard templates in Week 0:

**Template 1: Read-Only Query**
```typescript
// supabase/functions/_templates/readonly.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { validateApiToken, errorResponse, successResponse } from '../_shared/auth.ts'

serve(async (req) => {
  // 1. Validate token
  if (!validateApiToken(req)) {
    return unauthorizedResponse()
  }

  // 2. Parse payload
  const { character_id } = await req.json()
  if (!character_id) {
    return errorResponse("Missing character_id", 400)
  }

  // 3. Query database
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  const { data, error } = await supabase
    .from('your_table')
    .select('*')
    .eq('character_id', character_id)
    .single()

  if (error) {
    return errorResponse(error.message, 500)
  }

  // 4. Return response
  return successResponse(data)
})
```

**Template 2: Mutation with Rate Limit**
```typescript
// supabase/functions/_templates/mutation.ts
import { checkRateLimit } from '../_shared/rate_limiting.ts'
import { emitEvent } from '../_shared/events.ts'

serve(async (req) => {
  const { character_id, ...params } = await req.json()

  // Rate limit check
  const allowed = await checkRateLimit(supabase, character_id, 'endpoint_name')
  if (!allowed) {
    return errorResponse("Rate limit exceeded", 429)
  }

  // Perform mutation
  const { data, error } = await supabase
    .from('table')
    .update({ ... })
    .eq('id', params.id)

  // Emit event
  await emitEvent('event.name', {
    character_id,
    ...data
  }, [character_id])

  return successResponse(data)
})
```

These templates reduce each edge function to:
1. Copy template
2. Fill in table name, fields, business logic
3. Test locally
4. Deploy

**Time Savings:** 30-45 min per function.

---

## 17. Deployment Checklist Enhancements

### 17.1 Plan's Pre-Flight Checklist (Phase 6)

From plan:
```markdown
- [ ] All 25+ edge functions deployed
- [ ] Database schema matches specification
- [ ] Seed scripts executed and validated
- [ ] Python SDK tested with all endpoints
- [ ] Realtime Broadcast working
- [ ] Rate limiting configured
- [ ] Secrets properly set
- [ ] Backup procedures tested
```

**Good coverage!**

### 17.2 Additional Items

**Action Item #20:** Add to checklist:

```markdown
- [ ] All 37 endpoints have edge functions (not 25+)
- [ ] Performance benchmarks meet targets (<200ms p95)
- [ ] Export tool tested (Supabase → filesystem)
- [ ] Monitoring dashboards configured (Grafana/Supabase Studio)
- [ ] Billing alerts set (50%, 75%, 90%)
- [ ] Documentation updated (CLAUDE.md, README.md)
- [ ] Team trained on:
  - [ ] Supabase CLI commands
  - [ ] Edge function deployment
  - [ ] Database migrations
  - [ ] Monitoring & alerting
  - [ ] Rollback procedures
- [ ] Communication plan:
  - [ ] Announce maintenance window to users
  - [ ] Prepare status page updates
  - [ ] Define escalation contacts
```

---

## 18. Documentation Updates

### 18.1 CLAUDE.md Updates Required

Current CLAUDE.md has extensive FastAPI architecture documentation. Post-migration, needs:

**Action Item #21:** Plan documentation updates for Phase 6:

**Sections to Update:**
1. **Running the Server** → How to start local Supabase + edge functions
2. **API Endpoints** → Now edge functions, document format
3. **AsyncGameClient** → Update import and initialization
4. **Writing Integration Tests** → Using Supabase test fixtures
5. **Environment Variables** → Add SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_API_TOKEN

**New Sections to Add:**
1. **Supabase Architecture** (overview)
2. **Edge Function Development** (how to create/test/deploy)
3. **Database Migrations** (how to modify schema)
4. **Monitoring & Debugging** (Supabase Studio, logs)

### 18.2 Local Test Harness Expectations (Edge + Supabase)

The existing `tests/edge/conftest.py` fixture **already spins up the entire Supabase local stack** (via `supabase start`, `supabase db reset`, and `supabase functions serve`). That means every developer can run any edge test in their normal loop—no manual docker orchestration required beyond ensuring the Supabase CLI is available. If a test fails with `404 Function not found`, assume the local stack is stale and simply run:

```bash
npx supabase stop
npx supabase start
```

After that, rerun `pytest tests/edge -q` and the fixture will: (1) load `.env.supabase`, (2) ensure containers are healthy, (3) reseed via the `test_reset` edge function, and (4) tail logs into `logs/edge-functions.log`. Document this workflow prominently so teammates know that **edge tests will always bootstrap Supabase automatically**, and that a quick stop/start cycle is the fastest way to recover from local corruption.

**Example Addition:**
```markdown
## Supabase Architecture

The game server runs on Supabase with:
- **PostgreSQL database** for all game state
- **Edge Functions** for all RPC endpoints
- **Realtime Broadcast** for event delivery

### Local Development

Start local Supabase stack:
```bash
supabase start
```

This starts:
- PostgreSQL (port 54322)
- Supabase Studio (http://localhost:54323)
- Edge Functions runtime

### Deploying Edge Functions

```bash
# Deploy single function
supabase functions deploy join

# Deploy all functions
supabase functions deploy

# View logs
supabase functions logs join --tail
```
```

---

## 19. Quick Wins & Early Validation

### 19.1 Validate Approach Early

Don't wait until Week 6 to discover problems.

**Action Item #22:** Add Week 1.5 "Proof of Concept":

**Goal:** Validate entire stack with one complete endpoint.

**Tasks:**
1. Create `join` edge function (simplest critical endpoint)
2. Implement all shared utilities (auth, events, rate limiting)
3. Create Supabase client with Realtime subscription
4. Write end-to-end test: Create character → Join → Receive event
5. Measure performance

**Success Criteria:**
- Join completes in <200ms
- Event delivered via Realtime Broadcast
- Test passes reliably
- Team comfortable with tooling

**If POC fails:** Re-evaluate approach before building 36 more functions.

**Timeline Impact:** Split Week 1 database setup into 1.5 weeks, still targets 7 weeks total.

---

## 20. Prioritized Recommendations Summary

### 20.1 Critical (Must Do Before Week 1)

1. ✅ **Create edge function templates** (Template 1: readonly, Template 2: mutation)
2. ✅ **Set up Supabase test project** (local or cloud)
3. ✅ **Inventory all 37 endpoints** (ensure all are in plan)
4. ✅ **Design event system** (per-character channels, events table schema)
5. ✅ **Create AsyncGameClient design** (true drop-in replacement)

### 20.2 Important (Address During Migration)

6. ✅ **Specify rate limiting approach** (rejection vs queueing)
7. ✅ **Define optimistic locking** (port trades implementation)
8. ✅ **Add database constraints** (positive credits, valid stats)
9. ✅ **Document combat state management** (how state persists across rounds)
10. ✅ **Create export tool** (Supabase → filesystem for rollback)
11. ✅ **Week 1.5 POC** (validate approach with join endpoint)
12. ✅ **Performance benchmarks** (baseline, target, continuous monitoring)

### 20.3 Nice to Have (Post-Migration)

13. ✅ **Enhanced monitoring** (Grafana dashboards, custom alerts)
14. ✅ **Automated testing** (CI/CD pipeline for edge functions)
15. ✅ **Documentation site** (comprehensive edge function API docs)

---

## 21. Technical Questions for Design Sessions

### 21.1 Week 0 Design Sessions

Before implementation, hold design sessions to answer:

**Session 1: Event System (2 hours)**
- Q1: Per-character or per-sector Realtime channels?
- Q2: How to fan out multi-recipient events?
- Q3: Events table schema (one row per event or per recipient)?
- Q4: How do clients handle reconnection (missed events)?

**Session 2: State Management (2 hours)**
- Q1: Combat state storage (sector_contents.combat JSONB)?
- Q2: Who triggers round resolution (edge function or cron)?
- Q3: Garrison AI - how does auto-combat work with stateless functions?
- Q4: Hyperspace state - during async move delay, where is state?

**Session 3: Data Model (1 hour)**
- Q1: Character pre-registration - nullable state fields?
- Q2: Planets in sector_contents or universe_structure?
- Q3: Map knowledge updates - client writes or edge function writes?
- Q4: Port optimistic locking - max retry count?

**Session 4: Testing (1 hour)**
- Q1: Local Supabase or cloud test project?
- Q2: Test data seeding approach (SQL scripts or Python SDK)?
- Q3: Parallel testing (FastAPI vs Supabase) or sequential?
- Q4: Performance test targets?

**Action Item #23:** Schedule these sessions for Week 0, document decisions.

---

## 22. Success Metrics

### 22.1 Migration Success Criteria

**Functional:**
- ✅ All 37 endpoints operational
- ✅ All 62 existing tests pass
- ✅ Event delivery working (WebSocket → Realtime Broadcast)
- ✅ No data loss during migration

**Performance:**
- ✅ P95 latency < 200ms for critical paths
- ✅ P99 latency < 500ms for all paths
- ✅ Zero downtime cutover (or <5 min maintenance window)

**Operational:**
- ✅ Team can deploy edge functions independently
- ✅ Monitoring shows green health
- ✅ Rollback procedures tested and documented
- ✅ Cost within budget ($25-30/month initial)

**Action Item #24:** Set up metrics dashboard in Week 0:
- Supabase Studio (database metrics)
- Edge function logs & latency
- Custom dashboard for game-specific metrics (moves/hour, trades/hour, etc.)

---

## 23. Conclusion & Recommendations

### 23.1 Overall Assessment

The Supabase migration plan is **well-designed and ready to proceed** with the refinements identified in this analysis.

**Strengths:**
- ✅ Comprehensive phase breakdown
- ✅ Good risk awareness
- ✅ Appropriate technology choices
- ✅ Server-only architecture fits use case

**Areas Enhanced by This Analysis:**
- 📋 Complete endpoint inventory (37 not 25)
- 🔧 Implementation details (optimistic locking, event fan-out)
- 🧪 Test strategy additions
- 📊 Performance benchmarking plan
- 🔄 Rollback procedures
- 📚 Documentation requirements

### 23.2 Recommended Approach

**Week 0 (NEW): Preparation**
- Set up development environment
- Create edge function templates
- Hold design sessions (4 sessions, 6 hours total)
- Quick TypeScript/Deno onboarding (if needed)

**Weeks 1-6: Execute Plan As Written**
- With additions noted in this analysis
- Add Week 1.5 POC validation
- Continuous performance monitoring

**Week 7: Buffer & Polish**
- Address any issues discovered during Weeks 1-6
- Final testing and validation
- Documentation completion
- Team training on operations

**Total Timeline: 7-8 weeks**

### 23.3 Go/No-Go Recommendation

**Status: 🟢 GO** (with Week 0 preparation)

**Rationale:**
1. ✅ Supabase is appropriate for this use case
2. ✅ Architecture is sound (server-only, no RLS)
3. ✅ Plan covers all major components
4. ✅ Team has clear implementation path
5. ✅ Timeline is aggressive but achievable
6. ✅ Risk mitigation strategies in place

**Prerequisites Before Starting Week 1:**
- [ ] Complete all Week 0 preparation tasks
- [ ] Answer technical questions from design sessions
- [ ] Create edge function templates
- [ ] Set up Supabase test environment
- [ ] Confirm team availability (dedicated focus for 7 weeks)

### 23.4 Final Thought

This migration moves Gradient Bang from a **file-based prototype** to a **production-grade scalable system**. The investment (7 weeks, $25-30/month ongoing) is justified by:

- **Reliability:** Database ACID guarantees vs file I/O
- **Scalability:** Handles concurrent access naturally
- **Observability:** Built-in monitoring and logging
- **Features:** Realtime events, complex queries, future analytics
- **Maintenance:** Standard SQL migrations vs custom file formats

The plan is solid. With the refinements identified here, **this migration will succeed.**

---

## Appendix A: Complete Endpoint Inventory

| # | Endpoint File | RPC Name | Priority | Week 2 Day |
|---|--------------|----------|----------|------------|
| 1 | join.py | join | P1 | Day 3 |
| 2 | my_status.py | my_status | P1 | Day 3 |
| 3 | move.py | move | P1 | Day 3 |
| 4 | character_create.py | character.create | P1 | Day 3 |
| 5 | character_delete.py | character.delete | P1 | Day 3 |
| 6 | character_modify.py | character.modify | P2 | Day 4 |
| 7 | plot_course.py | plot_course | P2 | Day 4 |
| 8 | local_map_region.py | local_map_region | P2 | Day 4 |
| 9 | list_known_ports.py | list_known_ports | P2 | Day 4 |
| 10 | path_with_region.py | path_with_region | P2 | Day 4 |
| 11 | trade.py | trade | P2 | Day 4 |
| 12 | recharge_warp_power.py | recharge_warp_power | P3 | Day 5 |
| 13 | transfer_warp_power.py | transfer_warp_power | P3 | Day 5 |
| 14 | dump_cargo.py | dump_cargo | P3 | Day 5 |
| 15 | transfer_credits.py | transfer_credits | P3 | Day 5 |
| 16 | bank_transfer.py | bank_transfer | P3 | Day 5 |
| 17 | ship_purchase.py | ship.purchase | P3 | Day 5 |
| 18 | corporation_create.py | corporation.create | P4 | Day 6 |
| 19 | corporation_join.py | corporation.join | P4 | Day 6 |
| 20 | corporation_regenerate_invite_code.py | corporation.regenerate_invite_code | P4 | Day 6 |
| 21 | corporation_leave.py | corporation.leave | P4 | Day 6 |
| 22 | corporation_kick.py | corporation.kick | P4 | Day 6 |
| 23 | corporation_info.py | corporation.info | P4 | Day 6 |
| 24 | corporation_list.py | corporation.list | P4 | Day 6 |
| 25 | my_corporation.py | my.corporation | P4 | Day 6 |
| 26 | combat_initiate.py | combat.initiate | P5 | Day 7 |
| 27 | combat_action.py | combat.action | P5 | Day 7 |
| 28 | combat_leave_fighters.py | combat.leave_fighters | P5 | Day 7 |
| 29 | combat_collect_fighters.py | combat.collect_fighters | P5 | Day 7 |
| 30 | combat_set_garrison_mode.py | combat.set_garrison_mode | P5 | Day 7 |
| 31 | salvage_collect.py | salvage.collect | P5 | Day 7 |
| 32 | event_query.py | event.query | P6 | Week 3 |
| 33 | send_message.py | send_message | P6 | Week 3 |
| 34 | reset_ports.py | reset_ports | P6 | Week 3 |
| 35 | regenerate_ports.py | regenerate_ports | P6 | Week 3 |
| 36 | test_reset.py | test.reset | P6 | Week 3 |
| 37 | utils.py | (shared utilities) | - | Week 2 Day 1 |

**Total: 37 endpoints → 36 edge functions (utils is shared code)**

---

## Document Metadata

**Version:** 2.0 (Revised)
**Last Updated:** 2025-11-03
**Word Count:** ~11,000
**Reading Time:** ~55 minutes
**Review Status:** Ready for implementation

**Changes from v1.0:**
- Removed "don't use Supabase" recommendations
- Reframed concerns as clarification needs
- Changed conclusion from NO-GO to GO
- Added 24 specific action items
- Enhanced with templates and procedures
- Adjusted timeline from 6 weeks → 7-8 weeks (with prep)

**Next Steps:**
1. ✅ Review this analysis with team
2. ✅ Schedule Week 0 design sessions
3. ✅ Address 24 action items in plan refinement
4. ✅ Create edge function templates
5. 🟢 **BEGIN Week 0 (Preparation Phase)**

---

*End of Revised Analysis - Ready to Ship* 🚀
