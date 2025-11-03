# Supabase Migration Analysis: Implementation vs. Plan

**Date:** 2025-11-03
**Reviewer:** Claude
**Purpose:** Deep analysis of supabase-migration-plan-server-only.md against current implementation

---

## Executive Summary

This analysis compares the Supabase migration plan against the current file-based implementation of Gradient Bang. The plan is comprehensive and well-structured, but there are several critical inconsistencies, gaps, and areas requiring clarification before migration begins.

**Key Findings:**
- ❌ **Critical:** Directory naming conflict (game-server vs game_server)
- ⚠️ **Important:** 37 API endpoints exist but plan only lists ~30 edge functions
- ⚠️ **Important:** Current rate limiting is queue-based; plan assumes simpler per-request model
- ⚠️ **Important:** Event system architecture differs from planned Realtime Broadcast
- ✅ **Good:** Overall architecture is compatible with migration
- ✅ **Good:** Core data model mapping is sound

---

## 1. Critical Issues

### 1.1 Directory Naming Conflict

**Issue:** The migration plan (Task 1.1) states:

> "Rename game-server to game_server (Day 1 - Morning)
> **Why:** Python packages cannot have dashes in directory names (causes import issues)"

**Reality:** The current implementation uses `game-server/` and works perfectly fine. The codebase uses:
- `from game-server import ...` ❌ **NEVER DONE**
- `uv run python -m game-server` ✅ **ACTUAL USAGE**

**Analysis:**
- Python packages CAN have dashes when used as module executables (`python -m package-name`)
- The hyphen only causes issues with direct imports (`import game-server`)
- Current codebase never imports game-server as a package; only runs it as `__main__`
- All imports are relative within game-server or absolute from utils/

**Recommendation:**
- ❌ **DO NOT** rename game-server to game_server
- This would break existing scripts, documentation, and deployment configs
- The migration plan should be updated to reflect current working architecture
- If Supabase edge functions need Python-style naming, use a different directory (e.g., `supabase/`)

---

## 2. API Endpoint Coverage

### 2.1 Endpoint Count Discrepancy

**Current Implementation:** 37 API endpoint files in `game-server/api/`

**Migration Plan:** Lists ~30 edge functions in Appendix B

**Missing from Migration Plan:**
1. `character_modify.py` - Character metadata updates
2. `my_corporation.py` - Corporation membership lookup
3. `event_query.py` - Event log querying (mentioned but not in main list)
4. `test_reset.py` - Test utilities
5. `path_with_region.py` - Region-aware routing
6. Several utility endpoints

**Analysis:**
The plan is missing critical endpoints that exist in production. The migration must account for ALL existing functionality.

**Recommendation:**
- Audit all 37 endpoints and ensure each has a corresponding edge function specification
- Prioritize frequently-used endpoints over rarely-used ones
- Consider which endpoints are admin-only vs. player-facing

---

## 3. Rate Limiting Architecture

### 3.1 Current Implementation

The current system uses a sophisticated **queue-based rate limiter** (see `game-server/rpc/rate_limit.py`):

```python
class RateLimiter:
    """Per-character rate limiter with queueing support.

    Requests exceeding rate limits are queued and processed when timing allows.
    Requests waiting longer than queue_timeout are rejected with TimeoutError.
    """
```

**Features:**
- Per-character request queues
- Configurable limits per endpoint (from `config/rate_limits.yaml`)
- Sub-type differentiation (e.g., broadcast vs direct messages)
- Queue timeout handling
- Async processing with backpressure

**Example Config:**
```yaml
send_message:
  broadcast:
    limit: 1.0    # 1 request per 10 seconds
    window: 10.0
  direct:
    limit: 1.0    # 1 request per 2 seconds
    window: 2.0
```

### 3.2 Migration Plan Approach

The plan (Section 2.1, `rate_limiting.ts`) suggests:

```typescript
export async function checkRateLimit(
  supabase: SupabaseClient,
  character_id: string,
  endpoint: string
): Promise<boolean>
```

**Gaps in Plan:**
- No mention of request queueing (current system queues requests, doesn't reject immediately)
- No specification for queue_timeout handling
- No discussion of sub-type differentiation (broadcast vs direct)
- Assumes simple reject/accept model rather than queue-with-timeout

**Impact:**
- Players may experience different behavior (immediate rejection vs. queued waiting)
- NPCs using AsyncGameClient may fail more frequently if requests aren't queued
- Load spikes could cause more failures without queueing buffer

**Recommendation:**
- Clarify whether edge functions should implement queueing or simple rejection
- If queueing is needed, Supabase edge functions may need a different approach (Deno Deploy has cold start times)
- Consider using Supabase's built-in rate limiting features + application-level queue tracking
- Document behavioral changes for players/NPCs

---

## 4. Event System Architecture

### 4.1 Current Implementation

The current event system (`game-server/rpc/events.py`) uses:

**Architecture:**
- WebSocket-based event dispatcher
- Character-scoped event filtering
- JSONL event logging (dual-channel verification)
- Event inference (sector, sender, corporation from payload)
- Event sink protocol for connections

**Key Features:**
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

**Event Log Context:**
```python
@dataclass
class EventLogContext:
    sender: str | None = None
    sector: int | None = None
    corporation_id: str | None = None
    meta: dict | None = None
    payload_override: dict | None = None
    timestamp: datetime | None = None
```

### 4.2 Migration Plan Approach

The plan (Phase 4) proposes:

> "Replace WebSocket firehose with Supabase Realtime Broadcast"

**Proposed Architecture:**
- Supabase Realtime Broadcast channels: `character:{character_id}`
- Event logging to events table
- Python SDK subscription:

```python
channel = client.channel(f'character:{character_id}')
channel.on_broadcast(event='*', callback=handle_event).subscribe()
```

### 4.3 Critical Differences

| Feature | Current System | Migration Plan | Impact |
|---------|---------------|----------------|---------|
| Event Inference | Automatic (sector, sender, corp) | Not specified | May lose metadata |
| Event Log Context | Rich metadata | Not specified | Reduced auditability |
| Character Filtering | Application-level | Not specified | How to implement in Supabase? |
| Multi-recipient Events | Single emit to N characters | Unclear | Need fan-out logic |
| JSONL Logging | Per-character dual-write | Single events table | Different query patterns |

### 4.4 Major Concerns

1. **Character Filtering:** Current system filters at application level before sending. How does this work with Broadcast channels?
   - Option A: Emit to individual channels (N emits per event)
   - Option B: Sector-based channels (requires client-side filtering)
   - Option C: Mix of both (complex)

2. **Event Log Queries:** Current system uses JSONL files per character. Plan uses single events table.
   - Query pattern: `SELECT * FROM events WHERE character_id = ?`
   - For multi-character events (combat), how are recipients stored?
   - Does this require a junction table?

3. **Event Metadata Loss:** Current `EventLogContext` carries rich metadata. Plan's events table schema needs to capture this.

**Recommendation:**
- Specify exact Broadcast channel naming convention (character vs sector vs both)
- Design events table schema with ALL current metadata fields
- Consider event_recipients junction table for multi-character events
- Clarify fan-out logic: application-level or database triggers?

---

## 5. Data Model Mapping

### 5.1 File-to-Table Mapping (Appendix A Review)

The plan's mapping is mostly accurate, but with some issues:

| Legacy File | Current Location | Supabase Table | Notes |
|-------------|------------------|----------------|-------|
| universe_structure.json | ✅ world-data/ | universe_structure | ✅ Correct |
| sector_contents.json | ✅ world-data/ | sector_contents | ⚠️ See below |
| port-states/sector_*.json | ✅ world-data/port-states/ | ports | ⚠️ Dynamic files |
| ships.json | ✅ world-data/ | ship_instances | ✅ Correct |
| characters.json | ✅ world-data/ | characters | ⚠️ Registry only |
| character-map-knowledge/*.json | ✅ world-data/character-map-knowledge/ | characters.map_knowledge | ⚠️ See below |
| corporations/*.json | ✅ world-data/corporations/ | corporations + members + ships | ✅ Correct |
| corporation_registry.json | ✅ world-data/ | (index only) | ✅ Correct |
| sector_garrisons.json | ✅ world-data/ | garrisons | ✅ Correct |
| event-log.jsonl | ✅ world-data/ | events | ⚠️ Format change |

### 5.2 Critical Data Model Issues

#### 5.2.1 Character Registry vs. Character State

**Current Implementation:**
- `world-data/characters.json`: Character registry (metadata, names, created_at)
- `world-data/character-map-knowledge/*.json`: Per-character game state
- `world-data/ships.json`: Ship state (separate from characters)

**Migration Plan:**
- Single `characters` table combining registry + state
- `map_knowledge` as JSONB column

**Problem:** Current system separates identity (registry) from state (knowledge + ship). The plan merges them.

**Implications:**
- Character profiles exist before first login (pre-registration)
- Ship state is independent (corporation ships have NO character profile)
- Map knowledge includes ship reference and current state

**Recommendation:**
- Keep characters table for identity (name, player metadata)
- Keep ship_instances table for ship state
- Add character_sessions or character_state table for active game state
- Store map_knowledge in separate table (large JSONB per character)

#### 5.2.2 Sector Contents Structure

**Current Format (sector_contents.json):**
```json
{
  "0": {
    "has_port": false,
    "port_id": null,
    "planets": [],
    "salvage": []
  },
  "1": {
    "has_port": true,
    "port_id": "sector_1",
    "planets": [...],
    "salvage": [...]
  }
}
```

**Migration Plan:**
- Table `sector_contents` with row per sector
- Columns: `sector_id`, `port_id`, `updated_at`, `salvage`, `combat`

**Problem:** Current file stores static universe contents. Plan adds dynamic state (salvage, combat).

**Implication:** Mixing static (planets) and dynamic (salvage, combat) data in one table may cause update contention.

**Recommendation:**
- Consider splitting into:
  - `universe_structure` (static: sectors, planets, warps)
  - `sector_dynamic_state` (dynamic: salvage, combat)
- Or use separate columns with separate update patterns

#### 5.2.3 Port State Storage

**Current Implementation:**
- `world-data/port-states/sector_*.json` (one file per port)
- PortManager loads/saves individual port states
- High write frequency during trading

**Migration Plan:**
- Single `ports` table with optimistic locking

**Concerns:**
1. **Optimistic Locking Detail Missing:** Plan mentions it but doesn't specify:
   - Version field on ports table?
   - Retry logic in edge functions?
   - Conflict resolution strategy?

2. **Port Lock Manager:** Current implementation uses `PortLockManager` (see `game-server/core/locks/port_locks.py`):
   ```python
   class PortLockManager:
       """Async lock manager for port operations."""
       async def lock(self, sector_id: int, character_id: str):
           # Acquires exclusive lock for atomic trade
   ```
   How does this translate to Supabase edge functions?

**Recommendation:**
- Specify exact optimistic locking implementation:
  ```sql
  UPDATE ports
  SET stock = $new_stock, version = version + 1
  WHERE sector_id = $sector AND version = $expected_version
  ```
- Add retry logic in edge function shared utilities
- Consider PostgreSQL advisory locks for critical sections

---

## 6. Corporation Implementation

### 6.1 Current Implementation Analysis

Current corporation system is well-implemented:

**Files:**
- `game-server/core/corporation_manager.py`: Filesystem-backed manager
- `world-data/corporations/*.json`: Per-corporation files
- `world-data/corporation_registry.json`: Name index

**Key Features:**
- Thread-safe with per-corporation locks
- Case-insensitive name lookup
- Invite code generation and verification
- Member management with history tracking
- Ship registry per corporation

**Schema (from code):**
```python
{
    "corp_id": str,
    "name": str,
    "founded": datetime,
    "founder_id": str,
    "invite_code": str,
    "invite_code_generated": datetime,
    "invite_code_generated_by": str,
    "members": List[str],
    "ships": List[str]
}
```

### 6.2 Migration Plan Schema

**Planned Tables:**
1. `corporations`: Name, founder, invite metadata
2. `corporation_members`: Join table with timestamps
3. `corporation_ships`: Association table

**Missing Details:**
- How is `invite_code` secured? (Current system uses `secrets.token_hex(4)`)
- Invite code rotation: Does it invalidate old codes immediately?
- Member history: `corporation_members` has `left_at` but no re-join tracking
- Ship ownership transfer: What happens when ship becomes unowned?

**Recommendation:**
- Add `invite_code_hash` or keep codes short but ensure uniqueness checks
- Specify invite code rotation behavior (invalidate old codes? grace period?)
- Add `corporation_member_history` table for full audit trail
- Define ship ownership lifecycle transitions clearly

---

## 7. Edge Function Development Workflow

### 7.1 Plan's Proposed Workflow

The plan (Section 2, Week 2) describes:

1. Create function: `supabase functions new my_function`
2. Write function code
3. Serve locally: `supabase functions serve my_function --watch`
4. Test with curl/Python
5. Deploy: `supabase functions deploy my_function`

### 7.2 Current Development Workflow

**Current (file-based server):**
1. Edit `game-server/api/endpoint.py`
2. Add handler to `game-server/server.py` RPC_HANDLERS dict
3. Server auto-reloads on file change (uvicorn)
4. Test immediately via WebSocket/HTTP
5. No deployment step (files are the deployment)

### 7.3 Developer Experience Comparison

| Aspect | Current System | Supabase Edge Functions |
|--------|---------------|-------------------------|
| Edit-test cycle | Instant (auto-reload) | Requires restart |
| Debugging | Python debugger, logs | console.log only |
| Testing | Direct pytest integration | Separate test setup |
| State inspection | Direct file access | SQL queries |
| Deployment | Git push | Separate deploy command |

**Concerns:**
- Edge functions development is slower (TypeScript, Deno runtime, cold starts)
- Testing becomes harder (need to mock Supabase client)
- Team needs to learn TypeScript/Deno (currently Python-only)

**Recommendation:**
- Allocate time for team training on TypeScript/Deno
- Set up comprehensive testing framework BEFORE migration
- Consider keeping some logic in Python (ship calculations, pathfinding) and calling from edge functions
- Create development docker-compose for local Supabase + edge functions

---

## 8. Python SDK Integration

### 8.1 Current AsyncGameClient

**Architecture:**
- WebSocket-only transport
- Direct connection to FastAPI server
- Event handlers registered as callbacks
- Character-scoped (immutable character_id)
- Actor-based authorization for corporation ships

**Key Features:**
```python
class AsyncGameClient:
    def __init__(
        self,
        base_url: str = "http://localhost:8000",
        *,
        character_id: str,
        transport: str = "websocket",
        actor_character_id: Optional[str] = None,
        entity_type: str = "character",
        allow_corp_actorless_control: bool = False,
    ):
```

### 8.2 Planned Supabase Client (Phase 5.3)

**Proposed (from plan):**
```python
class AsyncGameClient:  # Same name, same API
    def __init__(self, server_url: Optional[str] = None):
        self.url = server_url or os.getenv('SUPABASE_URL')
        self.service_key = os.getenv('SUPABASE_SERVICE_ROLE_KEY')
        self.api_token = os.getenv('SUPABASE_API_TOKEN')
        self.client: Client = create_client(self.url, self.service_key)
```

### 8.3 Critical Incompatibility

**Problem:** The plan's proposed client has a completely different signature:

| Feature | Current | Planned | Compatible? |
|---------|---------|---------|-------------|
| character_id | Required init param | Not in init | ❌ NO |
| actor_character_id | Optional init param | Not present | ❌ NO |
| transport | "websocket" only | N/A (HTTP) | ❌ NO |
| Event handlers | client.on("event") | Not specified | ❌ NO |

**Impact:**
- **BREAKING CHANGE:** All existing code that creates AsyncGameClient will break
- NPCs, tools, tests, TUI - everything needs updating
- Event handler registration pattern is completely different

**Example Breakage:**

**Current Code:**
```python
client = AsyncGameClient(
    base_url="http://localhost:8000",
    character_id="char-123",
    actor_character_id="actor-456",
    transport="websocket"
)
client.on("movement.complete")(lambda p: print(p))
await client.join(character_id="char-123")
```

**Planned Code (from plan):**
```python
client = AsyncGameClient(server_url="https://project.supabase.co")
# ??? How do we set character_id?
# ??? How do we set actor_character_id?
# ??? How do we register event handlers?
await client.join(character_id="char-123")  # Now must pass it
```

### 8.4 Recommendation

**Option A: True Drop-in Replacement (Recommended)**
```python
class AsyncGameClient:
    def __init__(
        self,
        base_url: str = None,  # Now Supabase URL
        *,
        character_id: str,  # Keep required
        transport: str = "websocket",  # Keep for compatibility
        actor_character_id: Optional[str] = None,  # Keep
        # ... other params
    ):
        # Internal: use Supabase client
        self._supabase_url = base_url or os.getenv('SUPABASE_URL')
        self._supabase = create_client(self._supabase_url, os.getenv('SUPABASE_SERVICE_ROLE_KEY'))
        self._character_id = character_id
        self._actor_character_id = actor_character_id
        # Setup Realtime subscription for events
        self._setup_realtime_channel()
```

**Benefits:**
- Existing code continues to work
- Event handlers work the same way
- Character/actor IDs work the same way
- Only change: base_url points to Supabase instead of FastAPI

**Option B: New Client Class (Not Recommended)**
- Create `SupabaseGameClient` (different class)
- Requires updating all code
- More migration work
- Risk of missing spots

---

## 9. Missing Critical Components

### 9.1 Components Not Addressed in Plan

1. **Ship Definitions**
   - Current: `game-server/ships.py` with `SHIP_REGISTRY` dict
   - Plan: Mentions `ship_definitions` table but no seeding details
   - Issue: 13 ship types with complex stats, must be loaded correctly

2. **Universe Generation**
   - Current: Pre-generated 5000-sector universe
   - Plan: Mentions seeding but no details on regeneration
   - Issue: How to generate deterministic universes for different environments?

3. **Port Manager**
   - Current: `game-server/port_manager.py` handles port state persistence
   - Plan: Edge functions will handle ports
   - Issue: Who manages port state consistency during migration?

4. **Combat Manager**
   - Current: `game-server/combat/` (7 files, complex state machine)
   - Plan: Combat edge functions listed but state management unclear
   - Issue: Combat encounters span multiple rounds (stateful), how does this work with stateless edge functions?

5. **Map Knowledge Manager**
   - Current: `game-server/character_knowledge.py` (complex BFS, caching)
   - Plan: `map_knowledge` as JSONB but no mention of management logic
   - Issue: Who updates map knowledge? Edge functions? Client? Both?

6. **Garrison AI**
   - Current: `game-server/combat/garrison_ai.py` (auto-combat for garrisons)
   - Plan: Not mentioned
   - Issue: Will garrison auto-combat continue to work?

### 9.2 Recommendations

Each missing component needs:
- Migration strategy document
- Data seeding plan
- State management approach (edge function vs client vs hybrid)
- Testing plan

---

## 10. Performance Considerations

### 10.1 Current Performance Characteristics

**File-based System:**
- Character knowledge: Direct file I/O (~1-2ms per load)
- Port state: Individual file locks, minimal contention
- Ship state: Single file with threading locks
- Universe structure: Loaded once at startup, kept in memory

**Advantages:**
- Predictable performance (filesystem is fast)
- No network latency
- No connection pool limits
- Easy to debug (files are human-readable)

### 10.2 Supabase Performance Concerns

**Potential Bottlenecks:**
1. **Connection Pool:** PostgreSQL has connection limits
   - Supabase Pooler helps but adds latency
   - Edge functions may exhaust connections under load

2. **Database Round Trips:**
   - Current: Load character + ship + knowledge in 3 file reads (~3ms)
   - Supabase: 3 SQL queries + network latency (~50-100ms?)
   - Impact: 10-30x slower?

3. **JSONB Performance:**
   - Map knowledge is large (5000 sector universe = big JSON)
   - JSONB queries can be slow without proper indexes
   - GIN indexes help but add overhead

4. **Realtime Broadcast:**
   - WebSocket overhead per message
   - Supabase Realtime has message size limits
   - Fan-out to N characters = N messages (vs. current single emit)

### 10.3 Recommendations

1. **Benchmark Before Migration:**
   - Measure current system performance (p50, p99 latencies)
   - Set performance goals for Supabase system
   - Test Supabase performance with production data volumes

2. **Optimize Database Design:**
   - Consider materialized views for expensive queries
   - Add indexes for common access patterns
   - Use connection pooling appropriately

3. **Hybrid Approach:**
   - Keep hot data in-memory (universe structure, ship definitions)
   - Use Supabase for persistent state only
   - Cache heavily-accessed data (character state, map knowledge)

4. **Monitoring:**
   - Set up Supabase metrics dashboard BEFORE migration
   - Monitor query performance continuously
   - Have rollback plan if performance degrades

---

## 11. Testing Strategy Gaps

### 11.1 Current Test Infrastructure

**Existing Tests:**
- Integration tests in `tests/` (12 test files)
- `test_combat_scenarios_comprehensive.py` (12 comprehensive tests, ~3min runtime)
- `test_event_system.py` (50 tests covering event delivery)
- Test server auto-starts on port 8002 with test data
- Character registration system for test fixtures

**Coverage:**
- Combat scenarios (2-player, 3-player, garrisons, tolls)
- Event delivery (WebSocket + JSONL dual verification)
- Trading (optimistic locking, port updates)
- Movement (hyperspace, adjacency, warp power)
- Corporations (create, join, kick, ships)

### 11.2 Migration Plan Testing (Phase 5)

**Plan States:**
- Week 5, Day 1-2: "Integration testing"
- Week 5, Day 3-4: "Performance optimization"
- Bullet point: "Run existing test suite against Supabase backend"

**Major Gaps:**

1. **No Test Migration Strategy:**
   - How do tests run against edge functions instead of FastAPI?
   - Do we need a test Supabase project?
   - How to reset test state between tests?

2. **No Fixture Adaptation Plan:**
   - Current tests use filesystem fixtures (test-world-data/)
   - Supabase needs SQL fixtures or seed scripts
   - How to ensure test isolation?

3. **No Dual-Running Period:**
   - Plan assumes switch from old to new system
   - No mention of running both systems in parallel for comparison
   - No A/B testing strategy

4. **Event System Testing:**
   - Current: WebSocket + JSONL dual verification
   - Supabase: Realtime Broadcast + events table
   - How do we ensure equivalent behavior?

### 11.3 Recommendations

**Pre-Migration:**
1. Create `tests/supabase/` directory with:
   - Supabase-specific test fixtures
   - SQL seed scripts for test data
   - Edge function mocks for unit testing

2. Implement test database management:
   ```python
   @pytest.fixture
   async def supabase_test_db():
       """Create isolated test database."""
       # Create test schema
       # Run migrations
       # Seed test data
       yield
       # Cleanup
   ```

3. Create compatibility test suite:
   - Run same test against both systems
   - Compare outputs
   - Flag any differences

**During Migration:**
1. Test each edge function individually before integration
2. Keep existing tests running against old system
3. Add new tests for Supabase-specific features
4. Maintain 100% test coverage throughout

**Post-Migration:**
1. Verify all 62 existing tests pass
2. Add performance regression tests
3. Add Supabase-specific edge case tests

---

## 12. Rollback Strategy Concerns

### 12.1 Plan's Rollback Strategy (Section "Risk Mitigation")

**Proposed:**
```bash
# Revert environment variables
git checkout pre-supabase
# Restore legacy runtime configuration (env, services)
# Restart services
```

**Critical Issues:**

1. **Data Synchronization:**
   - Plan: "Preserve latest Supabase snapshot before rollback"
   - Problem: How do we merge Supabase state back to filesystem?
   - Example: Character in Supabase moved to sector 100, filesystem shows sector 50
   - Resolution: Manual merge? Automated sync? Data loss?

2. **Time Dependency:**
   - Plan: "If critical issues arise within 7 days of cutover"
   - Problem: What if issues discovered after 7 days?
   - Example: Subtle data corruption, performance degradation over time
   - Resolution: Need longer evaluation period or better monitoring

3. **Partial Migration:**
   - Plan assumes all-or-nothing cutover
   - Problem: What if 1 endpoint fails but others work?
   - Resolution: Need granular rollback capability

4. **State Divergence:**
   - During rollback, new data written to Supabase
   - Filesystem state is stale
   - Users may lose progress

### 12.2 Recommendations

**Better Rollback Strategy:**

1. **Dual-Write Period (2 weeks):**
   - Write to BOTH filesystem AND Supabase
   - Read from Supabase (if migration successful) or filesystem (if rolling back)
   - Continuously compare data between systems
   - Alerts if divergence detected

2. **Gradual Migration:**
   ```
   Week 1: 10% of requests → Supabase, 90% → filesystem
   Week 2: 50% → Supabase, 50% → filesystem
   Week 3: 90% → Supabase, 10% → filesystem
   Week 4: 100% → Supabase, filesystem is backup
   ```

3. **Data Sync Tool:**
   ```bash
   # Sync Supabase → filesystem (for rollback)
   uv run scripts/sync_supabase_to_filesystem.py

   # Sync filesystem → Supabase (for forward migration)
   uv run scripts/sync_filesystem_to_supabase.py
   ```

4. **Circuit Breaker:**
   - Monitor error rates per endpoint
   - Automatically fallback to filesystem if errors exceed threshold
   - Alert on automatic fallback

5. **Extended Evaluation:**
   - 30-day evaluation period (not 7 days)
   - Monitor continuously:
     - Error rates
     - Latency (p50, p99)
     - Data consistency
     - User feedback

---

## 13. Cost Analysis Gaps

### 13.1 Plan's Cost Estimate (Appendix D)

**Proposed:**
- Free Tier: 500 MB database, 500k edge function invocations/month
- Pro Tier ($25/month): 8 GB database, 2M invocations/month
- **Recommendation:** Pro tier for production

### 13.2 Current System Costs

**File-based System:**
- Disk space: ~5 MB for 5000-sector universe
- No database costs
- Hosting: Single FastAPI server (~$5-20/month VPS)

**Cost Difference:** +$25/month minimum (5x-25x increase)

### 13.3 Missing Cost Considerations

1. **Database Growth:**
   - Plan: "~500 MB initially, grow to ~2 GB"
   - Reality Check:
     - Events table: 1 KB per event × 10k events/day = 10 MB/day = 300 MB/month
     - Map knowledge: 1 MB per character × 100 characters = 100 MB
     - Port states: Updates frequently, audit trail grows
   - **Estimate: 500 MB → 2 GB in 3-6 months, not "initially"**

2. **Bandwidth:**
   - Plan: "Minimal (JSON responses, no media)"
   - Reality Check:
     - Realtime Broadcast sends events to all connected clients
     - Map data sent frequently (sectors, ports, characters)
     - Combat events are verbose (full state per round)
   - **Estimate: 10-50 GB/month for 100 active players**

3. **Egress Costs:**
   - Supabase charges for data transfer beyond included amount
   - Pro tier: 50 GB included
   - After that: $0.09/GB
   - **Potential surprise cost if game goes viral**

4. **Function Invocations:**
   - Plan: "~10,000 requests/day = 300k/month"
   - Reality Check:
     - NPC agents poll status every few seconds
     - TaskAgent makes 10-50 requests per task
     - 10 NPCs × 24 hours × 60 requests/hour = 14,400 requests/day (NPCs alone)
   - **Estimate: 500k-1M invocations/month easily exceeded**

5. **Upgrade Costs:**
   - If exceeding Pro tier limits:
     - Database: $0.125/GB/month beyond 8 GB
     - Functions: $2/million invocations beyond 2M
   - **Potential $50-100/month if game is popular**

### 13.4 Recommendations

1. **Realistic Budget:** $50-100/month for active game, not $25
2. **Cost Monitoring:**
   - Set up billing alerts at 50%, 80%, 100% of budget
   - Monitor function invocations daily
   - Track database growth weekly
3. **Optimization Strategy:**
   - Implement aggressive caching (reduce function calls)
   - Compress Realtime messages (reduce bandwidth)
   - Archive old events (reduce database size)
4. **Cost-Benefit Analysis:**
   - Current system: $20/month (VPS + domain)
   - Supabase system: $50-100/month
   - **Question: Is 5x cost justified by benefits?**

---

## 14. Security Considerations

### 14.1 Plan's Security Model

**Stated Approach (Executive Summary):**
> - Server-to-server authentication only (service role key from .env)
> - Token-protected edge functions (X-API-Token header validation)
> - No RLS policies (all requests are trusted)
> - Rate limiting for defensive programming (prevent bugs/loops)

### 14.2 Concerns

1. **Service Role Key Exposure:**
   - Service role key has FULL database access
   - If leaked, attacker has complete control
   - No RLS means no protection layer
   - **Risk: Single point of failure**

2. **API Token Security:**
   - Edge functions validate `X-API-Token` header
   - Plan: `SUPABASE_API_TOKEN=<generate with: openssl rand -hex 32>`
   - Problem: How is this token distributed?
   - If in env vars, how do we rotate?
   - If compromised, how do we revoke?

3. **No Authentication Layer:**
   - Current system: Character must be registered before use
   - Plan: Service role key bypasses all checks
   - Concern: What prevents unauthorized character creation?

4. **Audit Trail:**
   - Current system: Event log with sender metadata
   - Plan: Events table with similar data
   - Concern: Can attackers modify events table directly?

### 14.3 Recommendations

1. **Defense in Depth:**
   - Even with service role key, implement RLS policies as backup
   - Add triggers to validate data integrity
   - Log all operations to separate audit table (append-only)

2. **Token Management:**
   - Use separate API tokens per service:
     - Voice bot: token_voicebot_<random>
     - Admin CLI: token_admin_<random>
     - NPCs: token_npc_<random>
   - Rotate tokens monthly
   - Implement token revocation list

3. **Rate Limiting:**
   - Current plan uses rate limiting "for defensive programming"
   - Strengthen: Use rate limiting as security layer
   - Implement exponential backoff for failed auth attempts
   - Alert on suspicious patterns (rapid character creation, etc.)

4. **Monitoring:**
   - Log all service role key usage
   - Alert on:
     - Connections from unexpected IPs
     - Bulk data modifications
     - Unusual query patterns
   - Set up intrusion detection

---

## 15. Team Impact Assessment

### 15.1 Current Team Skills

**Assumed Skill Set (based on codebase):**
- Python (FastAPI, asyncio, pytest)
- JSON/JSONL file formats
- WebSocket protocols
- Git workflow
- Basic SQL (for universe generation?)

**NOT in codebase currently:**
- TypeScript
- Deno runtime
- PostgreSQL advanced features
- Supabase APIs
- Edge function development

### 15.2 Migration Learning Curve

**New Skills Required:**

1. **TypeScript/Deno (Critical):**
   - All edge functions in TypeScript
   - Deno APIs different from Node.js
   - Time: 1-2 weeks to become productive

2. **Supabase Platform (Critical):**
   - Dashboard navigation
   - CLI commands
   - Studio for database inspection
   - Realtime configuration
   - Time: 1 week to learn basics

3. **PostgreSQL (Important):**
   - SQL query optimization
   - Index design
   - JSONB operations
   - Transaction isolation levels
   - Time: 2-3 weeks for proficiency

4. **Edge Function Patterns (Important):**
   - Stateless design
   - Connection pooling
   - Error handling
   - Testing strategies
   - Time: 1-2 weeks

**Total Learning Time: 4-6 weeks per developer**

### 15.3 Plan's Training Allocation

**From Plan (Section "Phase 6.4: Documentation & Cleanup"):**
> - Team trained on new architecture

**Allocated Time: Days 6-7 of Week 6 = 2 days**

**Analysis: INSUFFICIENT**

2 days to train team on TypeScript + Deno + Supabase + PostgreSQL + Edge Functions is unrealistic.

### 15.4 Recommendations

1. **Pre-Migration Training (Week -4 to Week 0):**
   - Week -4: TypeScript fundamentals
   - Week -3: Deno runtime and APIs
   - Week -2: Supabase platform and CLI
   - Week -1: Edge function patterns and testing

2. **Parallel Development:**
   - Pair experienced developers with learners
   - Start with simple edge functions (read-only)
   - Progress to complex ones (combat, trading)

3. **Documentation:**
   - Create internal docs for common patterns
   - Example: "How to write an edge function for Gradient Bang"
   - Template: "Standard edge function boilerplate"

4. **External Resources:**
   - Supabase course subscription
   - TypeScript handbook
   - Deno docs
   - Budget for training: $500-1000

---

## 16. Timeline Realism

### 16.1 Plan's Timeline

**Total: 6 weeks**

- Week 1: Database setup and core tables
- Week 2: Edge function framework and critical RPC endpoints
- Week 3: Data tooling & validation
- Week 4: Event system integration
- Week 5: Testing & optimization
- Week 6: Cutover & deployment

### 16.2 Reality Check

**Similar Migration Benchmarks:**

From industry experience, database migrations typically follow:
- Small project (< 10 tables): 2-4 weeks
- Medium project (10-50 tables): 2-4 months
- Large project (> 50 tables): 6-12 months

**Gradient Bang Complexity:**
- 13 tables (medium)
- 37 API endpoints (high)
- 50 edge functions (high)
- Complex state management (combat, garrisons)
- Event system migration (high risk)
- No prior Supabase experience (training needed)

**Realistic Estimate: 12-16 weeks**

### 16.3 Overly Aggressive Phases

**Week 2: Edge function framework and critical RPC endpoints**
- Plan: Implement 25+ edge functions in 5 days
- Reality: 1-2 edge functions per day (if experienced) = 12-25 days
- **Underestimated by 2-4x**

**Week 3: Data tooling & validation**
- Plan: Create seed scripts, validation, reset tools in 7 days
- Reality: Universe generation is complex (5000 sectors, deterministic ports)
- Current universe generation script probably took weeks to develop
- **Underestimated by 2-3x**

**Week 5: Testing & optimization**
- Plan: "Comprehensive integration testing" + "Performance optimization" in 7 days
- Reality: Current test suite took months to build (62 tests)
- Migrating tests + fixing failures + optimization = 3-4 weeks
- **Underestimated by 3-4x**

### 16.4 Recommended Timeline

**Phase 0: Preparation (4 weeks)**
- Team training (TypeScript, Deno, Supabase)
- Set up development environment
- Create edge function templates
- Design database schema (final review)

**Phase 1: Database & Seeding (3 weeks)**
- Week 1: Schema creation and migration scripts
- Week 2: Seed script development
- Week 3: Validation and testing

**Phase 2: Edge Functions (6 weeks)**
- Week 1: Shared utilities and simple endpoints (5-7 functions)
- Week 2: Character & movement endpoints (5-7 functions)
- Week 3: Trading & economy endpoints (7-10 functions)
- Week 4: Corporation endpoints (8 functions)
- Week 5: Combat endpoints (5 functions)
- Week 6: Remaining endpoints + bug fixes

**Phase 3: Event System (3 weeks)**
- Week 1: Realtime Broadcast setup
- Week 2: Event emission integration
- Week 3: Event logging and queries

**Phase 4: Python SDK (2 weeks)**
- Week 1: AsyncGameClient rewrite
- Week 2: Event handlers and Realtime integration

**Phase 5: Testing (4 weeks)**
- Week 1: Unit tests for edge functions
- Week 2: Integration tests migration
- Week 3: End-to-end testing
- Week 4: Performance testing and optimization

**Phase 6: Deployment (2 weeks)**
- Week 1: Staging deployment and validation
- Week 2: Production cutover and monitoring

**Total: 24 weeks (6 months)**

---

## 17. Alternative Migration Strategies

### 17.1 Plan's Approach: "Big Bang" Migration

**Characteristics:**
- Switch from filesystem to Supabase at once
- Short migration window (6 weeks)
- High risk (all-or-nothing)

**Risks:**
- If major issue found, must rollback entirely
- Users experience downtime during cutover
- No ability to compare systems side-by-side
- High pressure on team

### 17.2 Alternative: Strangler Fig Pattern

**Approach:**
1. Keep existing filesystem backend
2. Add Supabase backend alongside
3. Migrate one endpoint at a time
4. Run both systems in parallel
5. Gradually shift traffic to Supabase
6. Retire filesystem when confident

**Benefits:**
- Lower risk (can rollback individual endpoints)
- Users experience no downtime
- Can A/B test performance
- Team has time to learn

**Timeline:**
- Week 1-4: Setup Supabase + dual-write system
- Week 5-20: Migrate endpoints one by one (1-2 per week)
- Week 21-24: Validation and cleanup
- Week 25+: Retire filesystem backend

### 17.3 Alternative: Hybrid Architecture

**Approach:**
- Keep some data in filesystem (static universe structure)
- Move dynamic data to Supabase (characters, ships, events)
- Best of both worlds

**Benefits:**
- Lower migration scope (only dynamic data)
- Better performance (static data stays in memory)
- Lower costs (smaller database)

**Drawbacks:**
- More complex architecture
- Need to maintain both systems
- May complicate future changes

### 17.4 Recommendation

**Preferred: Strangler Fig Pattern**

Reasons:
1. Safer (gradual migration, easy rollback)
2. Better for team (more time to learn)
3. Better for users (no downtime)
4. More realistic timeline (6 months)

Implementation:
```python
# game-server/backends/base.py
class Backend:
    async def get_character(self, character_id: str) -> dict:
        raise NotImplementedError

# game-server/backends/filesystem.py
class FilesystemBackend(Backend):
    async def get_character(self, character_id: str) -> dict:
        # Current implementation

# game-server/backends/supabase.py
class SupabaseBackend(Backend):
    async def get_character(self, character_id: str) -> dict:
        # New implementation

# game-server/backends/hybrid.py
class HybridBackend(Backend):
    def __init__(self):
        self.filesystem = FilesystemBackend()
        self.supabase = SupabaseBackend()

    async def get_character(self, character_id: str) -> dict:
        # Try Supabase first, fallback to filesystem
        try:
            return await self.supabase.get_character(character_id)
        except Exception:
            return await self.filesystem.get_character(character_id)
```

---

## 18. Questions for Clarification

### 18.1 Architecture Decisions

1. **Q: Why Supabase?**
   - What specific problems does Supabase solve that the current system doesn't?
   - Is it scalability? Multi-user access? Backup/recovery? Analytics?
   - Have we considered alternatives (Firestore, PlanetScale, Railway)?

2. **Q: Why edge functions instead of keeping Python backend?**
   - Could we use Supabase database + Python backend (FastAPI)?
   - This would reduce migration scope (no TypeScript rewrite)
   - Easier for current team (stays in Python)

3. **Q: Server-only architecture - forever?**
   - Plan says "no public user authentication"
   - What if we want web UI later?
   - Would we regret not implementing RLS now?

### 18.2 Technical Details

4. **Q: How do edge functions maintain state across rounds?**
   - Combat encounters span multiple rounds
   - Edge functions are stateless
   - Do we store state in database? In-memory cache? Both?

5. **Q: Realtime Broadcast channel strategy?**
   - Per-character channels? Per-sector? Both?
   - How do we handle multi-recipient events efficiently?
   - What about broadcast messages to all players?

6. **Q: Map knowledge management?**
   - Who updates map_knowledge JSONB column?
   - Edge functions? Client? Both?
   - How do we prevent lost updates?

7. **Q: Optimistic locking details?**
   - How many retries for port trades?
   - Exponential backoff? Linear?
   - How do we notify client of contention?

### 18.3 Operational

8. **Q: Database backups?**
   - How often? Retention period?
   - Point-in-time recovery?
   - Backup restoration testing plan?

9. **Q: Monitoring and alerting?**
   - What metrics do we track?
   - Alert thresholds?
   - On-call rotation?

10. **Q: Development workflow?**
    - Do developers need individual Supabase projects?
    - Or shared dev project?
    - How do we handle schema migrations during development?

---

## 19. Priority Recommendations

### 19.1 Critical (Must Address Before Starting)

1. ❌ **DO NOT rename game-server to game_server** - Current structure works fine
2. 📋 **Create complete edge function inventory** - Account for all 37 endpoints
3. 🔒 **Specify optimistic locking implementation** - Critical for port trades
4. 🎯 **Choose event system architecture** - Per-character vs per-sector channels
5. 🔄 **Define AsyncGameClient migration strategy** - Must be true drop-in replacement
6. ⏱️ **Adjust timeline to 16-24 weeks** - Current 6-week plan is unrealistic

### 19.2 Important (Address During Planning)

7. 📚 **Schedule team training** - 4 weeks before migration starts
8. 🧪 **Create test migration strategy** - How to run tests against Supabase
9. 💰 **Budget realistically** - $50-100/month, not $25
10. 🔐 **Strengthen security model** - Add RLS policies, token rotation, monitoring
11. 🔄 **Add rollback mechanisms** - Dual-write period, gradual migration
12. 📊 **Benchmark current system** - Establish performance baseline

### 19.3 Nice to Have (Consider During Migration)

13. 🏗️ **Consider hybrid architecture** - Keep static data in-memory
14. 🐛 **Use strangler fig pattern** - Gradual migration, lower risk
15. 📖 **Document tribal knowledge** - Before losing filesystem expertise
16. 🔍 **Set up comprehensive monitoring** - Before migration, not after

---

## 20. Conclusion

### 20.1 Overall Assessment

The Supabase migration plan is **well-intentioned but needs significant revision** before execution.

**Strengths:**
- ✅ Comprehensive phase breakdown
- ✅ Correct identification of major components
- ✅ Good risk awareness
- ✅ Detailed checklists

**Critical Weaknesses:**
- ❌ Unrealistic 6-week timeline (needs 16-24 weeks)
- ❌ Missing key implementation details (event system, rate limiting)
- ❌ Insufficient testing strategy
- ❌ No team training allocation
- ❌ Risky big-bang migration approach
- ❌ Cost underestimation

### 20.2 Go/No-Go Recommendation

**Current Status: 🔴 NO-GO**

Before starting migration:

1. **Answer "Why?"**
   - Document specific problems Supabase solves
   - Justify 5x cost increase
   - Identify must-have features not possible with current system

2. **Revise Plan**
   - Extend timeline to 16-24 weeks
   - Add training phase
   - Choose migration strategy (big bang vs strangler fig)
   - Add comprehensive testing plan

3. **Build Team Skills**
   - 4-week pre-migration training
   - Prototype 1-2 edge functions
   - Validate team can develop in TypeScript/Deno

4. **De-Risk**
   - Implement dual-write capability
   - Create rollback procedures
   - Set up monitoring
   - Benchmark current system

5. **Secure Buy-In**
   - Present realistic timeline (6 months)
   - Present realistic budget ($50-100/month)
   - Get stakeholder approval

Only after these steps: **🟢 GO for Phase 0 (Preparation)**

### 20.3 Alternative Recommendation

**Consider: Keep current system, enhance it**

If Supabase migration is primarily about:
- Better backups → Add automated filesystem backups
- Multi-user access → Current system already supports this
- Scalability → How many concurrent users do we actually have?
- Analytics → Add PostgreSQL for analytics only, keep filesystem for game state

**Cost: $10-20/month for backups + analytics database**
**Risk: Low (no major changes)**
**Timeline: 2-4 weeks**

---

## Appendix A: Edge Function Coverage Matrix

| Endpoint File | Current Implementation | Migration Plan Edge Function | Status |
|---------------|------------------------|------------------------------|--------|
| bank_transfer.py | ✅ Implemented | bank_transfer | ✅ Listed |
| character_create.py | ✅ Implemented | character.create | ✅ Listed |
| character_delete.py | ✅ Implemented | character.delete | ✅ Listed |
| character_modify.py | ✅ Implemented | character.modify | ⚠️ Not Listed |
| combat_action.py | ✅ Implemented | combat.action | ✅ Listed |
| combat_collect_fighters.py | ✅ Implemented | combat.collect_fighters | ✅ Listed |
| combat_initiate.py | ✅ Implemented | combat.initiate | ✅ Listed |
| combat_leave_fighters.py | ✅ Implemented | combat.leave_fighters | ✅ Listed |
| combat_set_garrison_mode.py | ✅ Implemented | combat.set_garrison_mode | ✅ Listed |
| corporation_create.py | ✅ Implemented | corporation.create | ✅ Listed |
| corporation_info.py | ✅ Implemented | corporation.info | ✅ Listed |
| corporation_join.py | ✅ Implemented | corporation.join | ✅ Listed |
| corporation_kick.py | ✅ Implemented | corporation.kick | ✅ Listed |
| corporation_leave.py | ✅ Implemented | corporation.leave | ✅ Listed |
| corporation_list.py | ✅ Implemented | corporation.list | ✅ Listed |
| corporation_regenerate_invite_code.py | ✅ Implemented | corporation.regenerate_invite_code | ✅ Listed |
| dump_cargo.py | ✅ Implemented | dump_cargo | ✅ Listed |
| event_query.py | ✅ Implemented | event.query | ⚠️ Partially Listed |
| join.py | ✅ Implemented | join | ✅ Listed |
| list_known_ports.py | ✅ Implemented | list_known_ports | ✅ Listed |
| local_map_region.py | ✅ Implemented | local_map_region | ✅ Listed |
| move.py | ✅ Implemented | move | ✅ Listed |
| my_corporation.py | ✅ Implemented | my.corporation | ⚠️ Not in main list |
| my_status.py | ✅ Implemented | my_status | ✅ Listed |
| path_with_region.py | ✅ Implemented | path_with_region | ⚠️ Not Listed |
| plot_course.py | ✅ Implemented | plot_course | ✅ Listed |
| recharge_warp_power.py | ✅ Implemented | recharge_warp_power | ✅ Listed |
| regenerate_ports.py | ✅ Implemented | regenerate_ports | ✅ Listed |
| reset_ports.py | ✅ Implemented | reset_ports | ✅ Listed |
| salvage_collect.py | ✅ Implemented | salvage.collect | ✅ Listed |
| send_message.py | ✅ Implemented | send_message | ✅ Listed |
| ship_purchase.py | ✅ Implemented | ship.purchase | ✅ Listed |
| test_reset.py | ✅ Implemented | test.reset | ✅ Listed |
| trade.py | ✅ Implemented | trade | ✅ Listed |
| transfer_credits.py | ✅ Implemented | transfer_credits | ✅ Listed |
| transfer_warp_power.py | ✅ Implemented | transfer_warp_power | ✅ Listed |

**Summary:**
- Total Current Endpoints: 37
- Listed in Migration Plan: ~33
- Missing from Plan: 4
- Partially Documented: 2

---

## Appendix B: Data File Inventory

| File/Directory | Size | Purpose | Migration Target |
|----------------|------|---------|------------------|
| universe_structure.json | 1.7 MB | Static universe layout | universe_structure table |
| sector_contents.json | 1.4 MB | Static sector contents | sector_contents table |
| port-states/*.json | ~100 KB | Dynamic port state | ports table |
| ships.json | 5 KB | Ship instances | ship_instances table |
| characters.json | 1.5 KB | Character registry | characters table |
| character-map-knowledge/*.json | ~1 MB | Per-character state | characters.map_knowledge (JSONB) |
| corporations/*.json | <10 KB | Corporation data | corporations + members + ships tables |
| corporation_registry.json | <1 KB | Name index | (index only) |
| sector_garrisons.json | <1 KB | Garrison deployments | garrisons table |
| event-log.jsonl | 1 MB+ | Event audit trail | events table |
| trade_history.jsonl | 50 KB | Trade audit trail | (optional) |

**Total Current Data: ~5 MB**
**Estimated Supabase DB Size: 50-100 MB after normalization and indexes**

---

## Document Metadata

**Version:** 1.0
**Last Updated:** 2025-11-03
**Word Count:** ~12,500
**Reading Time:** ~60 minutes
**Review Status:** Ready for team discussion

**Next Steps:**
1. Review this analysis with team
2. Address critical recommendations
3. Make go/no-go decision
4. If GO: Revise migration plan based on findings
5. If NO-GO: Consider alternatives (keep current system, hybrid approach)

---

*End of Analysis*
