# Admin Functions & Universe Loader Implementation Plan

**Last Updated:** 2025-11-16 21:00 UTC
**Status:** APPROVED - Implementation in progress
**Phase:** Phase 8 (API Parity - Admin Endpoints)

---

## Executive Summary

This plan implements the remaining 6 admin endpoints and universe data loading for Supabase:

1. **Universe Data Loader**: Python script to load universe-bang data into Supabase
2. **6 Admin Edge Functions**: character_create, character_delete, character_modify, reset_ports, regenerate_ports, leaderboard_resources
3. **Admin Audit Table**: Security logging for all admin operations

---

## Part 1: Universe Data Loader

### Overview

**Goal**: Load universe-bang generated data (sectors, warp links, ports) into Supabase tables.

**Input Files** (from `scripts/universe-bang.py`):
- `world-data/universe_structure.json` - Sectors, positions, warp connections, regions
- `world-data/sector_contents.json` - Ports, inventories, commodities

**Target Tables**:
- `universe_config` (singleton) - Metadata
- `universe_structure` (5000 rows) - Sector positions and warps
- `ports` (~1900 rows) - Port inventories
- `sector_contents` (5000 rows) - Sector state

### Implementation: Python Script

**File**: `scripts/load_universe_to_supabase.py`

**Why Python**:
- Reuses existing universe-bang.py infrastructure
- Can call universe-bang.py directly
- Uses supabase-py client library
- Familiar to contributors

**Command-line Interface**:
```bash
# Generate universe and load in one step
uv run scripts/load_universe_to_supabase.py --generate --sectors 5000 --seed 12345

# Load existing JSON files
uv run scripts/load_universe_to_supabase.py --from-json world-data/

# Force reload (dangerous!)
uv run scripts/load_universe_to_supabase.py --from-json world-data/ --force

# Dry-run validation
uv run scripts/load_universe_to_supabase.py --from-json world-data/ --dry-run
```

### Data Flow

```
universe-bang.py (--sectors 5000 --seed 12345)
    ↓
world-data/universe_structure.json
world-data/sector_contents.json
    ↓
load_universe_to_supabase.py
    ↓
    1. Parse and validate JSON files
    2. Connect to Supabase (service role key)
    3. Transaction: Insert universe_config
    4. Batch insert universe_structure (500 rows/batch)
    5. Batch insert ports (convert demand → stock)
    6. Batch insert sector_contents
    7. Verify integrity (counts, FKs, warp connections)
    ↓
Supabase Tables (production ready)
```

### Stock Conversion Logic

**Problem**: Legacy uses "demand" for buying ports, Supabase uses unified "stock" model.

**Conversion**:
- **SELL ports** (code="S"): `stock_qf = port.stock.QF`
- **BUY ports** (code="B"): `stock_qf = demand_max.QF - demand.QF`
- **NEUTRAL** (code="N"): No stock for that commodity

**Example**:
```python
# Port code "BSS" = Buys QF, Sells RO/NS
port_data = sector_contents["sectors"][sector_id]["port"]

if port_data["code"][0] == "B":  # Buys quantum_foam
    stock_qf = port_data["demand_max"]["QF"] - port_data["demand"]["QF"]
    max_qf = port_data["demand_max"]["QF"]
elif port_data["code"][0] == "S":  # Sells quantum_foam
    stock_qf = port_data["stock"]["QF"]
    max_qf = port_data["stock_max"]["QF"]
else:  # Neutral
    stock_qf = 0
    max_qf = 0
```

### Error Handling

**Pre-flight Checks**:
1. Verify SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars
2. Check JSON files exist and are valid
3. Validate sector_count matches between files
4. Ensure all port sector_id references exist in universe_structure

**Transaction Rollback**:
- Wrap entire load in try/catch
- Rollback all inserts on any error
- Require --force flag to truncate existing universe

**Post-load Verification**:
1. Count rows in each table match expectations
2. Verify FK integrity (ports.sector_id → universe_structure.sector_id)
3. Check for orphaned sector_contents entries
4. Validate warp connections reference valid sector IDs

### Storage of Initial Port States

**Decision**: Store in `universe_config.generation_params` JSONB field.

**Format**:
```json
{
  "generation_params": {
    "sector_count": 5000,
    "seed": 12345,
    "initial_port_states": {
      "1": {"stock_qf": 1000, "stock_ro": 0, "stock_ns": 1000},
      "5": {"stock_qf": 0, "stock_ro": 500, "stock_ns": 0},
      ...
    }
  }
}
```

This enables `reset_ports` to restore initial state.

---

## Schema Fixes Required

### Overview

After testing the universe loader in dry-run mode, we identified schema mismatches between the JSON data format (from universe-bang) and the Supabase database schema. These must be resolved before real data loading.

### Mismatch 1: Position Columns Data Type

**Problem**:
- **Schema** (`20251108093000_initial_schema.sql`): `position_x INTEGER`, `position_y INTEGER`
- **JSON data** (`universe_structure.json`): FLOAT values (e.g., `0.0`, `1.5`, `-2.0`, `3.14159`)
- **Impact**: PostgreSQL will reject FLOAT inserts into INTEGER columns

**User Directive**: "Fix the initial schema, for the position columns."

**Solution**: Create migration to alter columns from INTEGER to DOUBLE PRECISION

**Migration**: `supabase/migrations/20251117020000_fix_universe_structure_types.sql`
```sql
-- Fix position columns from INTEGER to DOUBLE PRECISION
ALTER TABLE universe_structure
  ALTER COLUMN position_x TYPE DOUBLE PRECISION,
  ALTER COLUMN position_y TYPE DOUBLE PRECISION;

COMMENT ON COLUMN universe_structure.position_x IS 'Sector X coordinate (floating point)';
COMMENT ON COLUMN universe_structure.position_y IS 'Sector Y coordinate (floating point)';
```

**Status**: ✅ Migration ready to create

---

### Mismatch 2: Region Data Type

**Problem**:
- **Schema**: `region TEXT`
- **JSON data**: Integer region IDs (e.g., `0`, `1`, `2`)
- **JSON meta**: Region definitions with `{id: 0, name: "Core Worlds", safe: true}`
- **Impact**: Loader needs to convert integer IDs to text names

**User Directive**: "For the region data type, the loader should look up the region text and insert the text."

**Solution**: Update loader to build region mapping and convert IDs to names

**Loader Changes**:
```python
def load_universe_structure(self, structure: Dict) -> None:
    """Load universe structure (sectors and warps)."""
    print("\n🌌 Loading universe_structure...")

    # Build region ID → name mapping from meta
    region_map = {}
    for region_def in structure["meta"].get("regions", []):
        region_map[region_def["id"]] = region_def["name"]

    print(f"   Region mapping: {region_map}")

    sectors = structure["sectors"]
    batch = []

    for i, sector in enumerate(sectors):
        # Convert region ID to name
        region_id = sector.get("region", 0)
        region_name = region_map.get(region_id, f"Region {region_id}")

        row = {
            "sector_id": sector["id"],
            "position_x": sector["position"]["x"],  # Now DOUBLE PRECISION
            "position_y": sector["position"]["y"],  # Now DOUBLE PRECISION
            "region": region_name,  # TEXT (converted from integer)
            "warps": json.dumps(sector.get("warps", [])),
        }
        batch.append(row)
        # ... batch insert logic ...
```

**Fallback Handling**: If region not found in meta, use `f"Region {region_id}"` as fallback

**Status**: ⏸️ Implementation pending

---

### Mismatch 3: Port Verification Query

**Problem**:
- **Current loader**: Queries `ports` table by `port_id` in verification step
- **Better approach**: Query by `sector_id` since that's the natural key for ports

**User Directive**: "Use the existing schema for ports, but the sanity check lookup should look the port info up by sector."

**Loader Changes**:
```python
def verify_integrity(self, structure: Dict) -> None:
    """Verify data integrity after load."""
    print("\n🔍 Verifying data integrity...")

    if self.dry_run:
        print("   [DRY RUN] Skipping verification")
        return

    # Count rows in each table
    config_count = len(self.supabase.table("universe_config").select("id").execute().data)
    structure_count = len(self.supabase.table("universe_structure").select("sector_id").execute().data)

    # Query ports by sector_id (not port_id)
    ports = self.supabase.table("ports").select("port_id, sector_id, port_code").execute().data
    ports_count = len(ports)

    # Verify each port references valid sector
    port_sectors = {p["sector_id"] for p in ports}
    structure_sectors = {s["sector_id"] for s in self.supabase.table("universe_structure").select("sector_id").execute().data}
    orphaned_ports = port_sectors - structure_sectors

    if orphaned_ports:
        raise ValueError(f"Found {len(orphaned_ports)} ports with invalid sector references: {orphaned_ports}")

    contents_count = len(self.supabase.table("sector_contents").select("sector_id").execute().data)

    expected_sectors = structure["meta"]["sector_count"]

    print(f"   universe_config: {config_count} (expected 1)")
    print(f"   universe_structure: {structure_count} (expected {expected_sectors})")
    print(f"   ports: {ports_count}")
    print(f"   sector_contents: {contents_count} (expected {expected_sectors})")

    # Verify counts
    if config_count != 1:
        raise ValueError(f"Expected 1 universe_config row, got {config_count}")
    if structure_count != expected_sectors:
        raise ValueError(f"Expected {expected_sectors} universe_structure rows, got {structure_count}")
    if contents_count != expected_sectors:
        raise ValueError(f"Expected {expected_sectors} sector_contents rows, got {contents_count}")

    print("✅ Integrity check passed")
```

**Status**: ⏸️ Implementation pending

---

### Updated Data Flow with Type Conversions

```
universe-bang.py (--sectors 5000 --seed 12345)
    ↓
world-data/universe_structure.json
  - position_x/position_y: FLOAT (0.0, 1.5, -2.0)
  - region: INTEGER (0, 1, 2)
  - meta.regions: [{id: 0, name: "Core Worlds"}, ...]
    ↓
world-data/sector_contents.json
  - port.stock, port.demand: commodities
    ↓
load_universe_to_supabase.py
    ↓
    1. Parse JSON files
    2. Build region_map: {0: "Core Worlds", 1: "Trade Federation", ...}
    3. Connect to Supabase
    4. Insert universe_config (with initial_port_states)
    5. Batch insert universe_structure:
       - position_x/y: FLOAT → DOUBLE PRECISION ✅
       - region: INTEGER → TEXT (via region_map) ✅
    6. Batch insert ports:
       - Convert demand → stock for BUY ports ✅
       - Query by sector_id in verification ✅
    7. Batch insert sector_contents (with port_id FK)
    8. Verify integrity (FK checks, orphaned ports)
    ↓
Supabase Tables (production ready)
```

---

### Questions & Considerations

**Q1: What if region definitions are missing from meta?**
- **Answer**: Fallback to `f"Region {region_id}"` as the text name
- **Rationale**: Ensures loader doesn't fail on legacy data
- **Logging**: Warn when using fallback names

**Q2: Should we validate region names against a known list?**
- **Current approach**: No validation, accept any text from meta
- **Alternative**: Define allowed region names in schema (ENUM or CHECK constraint)
- **Recommendation**: Keep flexible for now, add validation later if needed

**Q3: What about existing data in universe_structure?**
- **Current state**: Table likely empty (initial dev migration)
- **Migration safety**: `ALTER COLUMN TYPE` is safe when table is empty
- **Production concern**: If table has data, need to validate all position values are compatible
- **Recommendation**: Since this is Phase 8 and tables are new, proceed with ALTER

**Q4: Should position coordinates have precision/scale limits?**
- **Current**: DOUBLE PRECISION (15-17 significant digits)
- **Universe scale**: Likely -10,000 to +10,000 range
- **Alternative**: NUMERIC(10, 4) for exact precision
- **Recommendation**: DOUBLE PRECISION is fine for spatial coordinates

**Q5: Performance impact of TEXT region vs INTEGER with FK?**
- **Storage**: TEXT uses ~10-20 bytes, INTEGER uses 4 bytes
- **Queries**: Both have same index performance
- **5000 sectors**: TEXT adds ~50KB overhead (negligible)
- **Recommendation**: TEXT is acceptable, matches current schema design

**Q6: Should we store both region ID and name?**
- **Pros**: Enables filtering by ID, preserves source data
- **Cons**: Denormalization, extra column
- **Current schema**: Only has `region TEXT`
- **Recommendation**: Keep single TEXT column for simplicity

**Q7: What about multi-region queries?**
- **Example**: "Find all sectors in Core Worlds"
- **With TEXT**: `WHERE region = 'Core Worlds'` (indexed, fast)
- **With INTEGER**: `WHERE region = 0` (slightly faster but requires lookup)
- **Recommendation**: TEXT is fine, create index if needed

---

### Implementation Order

1. **Create migration** (`20251117020000_fix_universe_structure_types.sql`)
   - Alter position_x/position_y to DOUBLE PRECISION
   - Add column comments

2. **Update loader script**:
   - Add region mapping logic in `load_universe_structure()`
   - Update verification to query ports by sector_id
   - Add warning logs for fallback region names

3. **Test with test universe** (10 sectors):
   - Dry-run validation ✅ (already passed)
   - Real load with fixed schema
   - Verify all data integrity checks

4. **Test with production universe** (5000 sectors):
   - Generate with universe-bang.py
   - Load with loader script
   - Performance benchmarks (<5 minutes target)

---

### Success Criteria for Schema Fixes

✅ Migration successfully alters position columns
✅ Loader maps all region IDs to text names
✅ No fallback region names needed (all defined in meta)
✅ Port verification queries by sector_id
✅ All FK constraints pass verification
✅ Test universe (10 sectors) loads successfully
✅ Production universe (5000 sectors) loads in <5 minutes
✅ No data loss or type coercion errors

---

## Part 2: Admin Edge Functions

### Common Patterns

All 6 admin functions share:

**Admin Password Validation**:
```typescript
import { validateAdminSecret } from '../_shared/auth.ts';

const adminPassword = optionalString(payload, 'admin_password');
const isValid = await validateAdminSecret(adminPassword);
if (!isValid) {
  return errorResponse('Invalid admin password', 403);
}
```

**Environment Variables**:
- `EDGE_ADMIN_PASSWORD` - Plain text (dev only)
- `EDGE_ADMIN_PASSWORD_HASH` - SHA-256 hash (production)

**Response Format**:
```json
{
  "success": true,
  ...
}
```

**Admin Audit Logging** (all operations):
```typescript
await logAdminAction(supabase, {
  action: 'character_create',
  admin_user: 'admin',  // Future: extract from auth
  target_id: character_id,
  payload: payload,
  result: 'success'
});
```

---

### Function 1: character_create

**Endpoint**: `POST /functions/v1/character_create`

**Request Payload**:
```json
{
  "admin_password": "secret",
  "name": "Player Name",
  "player": {
    "credits": 5000,
    "player_type": "human"
  },
  "ship": {
    "ship_type": "kestrel_courier",
    "ship_name": "My Ship",
    "current_warp_power": 300,
    "current_shields": 150,
    "current_fighters": 300,
    "cargo": {
      "quantum_foam": 0,
      "retro_organics": 0,
      "neuro_symbolics": 0
    }
  }
}
```

**Database Operations** (transactional):

1. **Validate ship_type**:
   ```sql
   SELECT ship_type FROM ship_definitions WHERE ship_type = $1
   ```

2. **Check name uniqueness**:
   ```sql
   SELECT character_id FROM characters WHERE name = $1
   ```

3. **Insert character**:
   ```sql
   INSERT INTO characters (character_id, name, current_ship_id, map_knowledge, is_npc)
   VALUES (gen_random_uuid(), $1, NULL, '{"sectors_visited": {}, "total_sectors_visited": 0}', false)
   RETURNING character_id
   ```

4. **Insert ship**:
   ```sql
   INSERT INTO ship_instances (
     ship_id, owner_id, owner_type, owner_character_id, ship_type, ship_name,
     current_sector, credits, cargo_qf, cargo_ro, cargo_ns,
     current_warp_power, current_shields, current_fighters
   ) VALUES (
     gen_random_uuid(), $1, 'character', $1, $2, $3,
     0, $4, $5, $6, $7, $8, $9, $10
   )
   RETURNING ship_id
   ```

5. **Update character with ship reference**:
   ```sql
   UPDATE characters SET current_ship_id = $1 WHERE character_id = $2
   ```

**Response**:
```json
{
  "success": true,
  "character_id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "Player Name",
  "player": {"credits": 5000, "player_type": "human"},
  "ship": {"ship_type": "kestrel_courier", "ship_name": "My Ship", ...}
}
```

**Error Codes**:
- 400: Invalid ship_type, missing name, invalid field types
- 403: Invalid admin password
- 409: Character name already exists
- 500: Database error

---

### Function 2: character_delete

**Endpoint**: `POST /functions/v1/character_delete`

**Request Payload**:
```json
{
  "admin_password": "secret",
  "character_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Database Operations**:

Use existing stored procedure:
```sql
SELECT delete_character_cascade($1)
```

This procedure (lines 629-662 in schema):
1. Counts and deletes all ships owned by character
2. Counts and deletes all garrisons owned by character
3. Deletes character record
4. Returns: `{success: true, ships_deleted: N, garrisons_deleted: M}`

**Additional Cleanup**:
- Delete corporation membership (if in a corporation)
- If last member, delete corporation
- Clear active combat participation (sector_contents.combat JSONB)

**Response**:
```json
{
  "success": true,
  "character_id": "550e8400-e29b-41d4-a716-446655440000",
  "deleted": true,
  "ships_deleted": 3,
  "garrisons_deleted": 5
}
```

**Error Codes**:
- 400: Missing character_id
- 403: Invalid admin password
- 404: Character not found
- 500: Database error

---

### Function 3: character_modify

**Endpoint**: `POST /functions/v1/character_modify`

**Request Payload**:
```json
{
  "admin_password": "secret",
  "character_id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "New Name",
  "player": {
    "credits": 10000
  },
  "ship": {
    "ship_type": "atlas_freighter",
    "current_fighters": 500
  }
}
```

**Database Operations**:

1. **Validate character exists**:
   ```sql
   SELECT character_id, current_ship_id FROM characters WHERE character_id = $1
   ```

2. **Name change** (if provided):
   ```sql
   UPDATE characters SET name = $1 WHERE character_id = $2
   ```

3. **Ship type change** (if provided):
   ```typescript
   // Get current ship
   const currentShip = await supabase
     .from('ship_instances')
     .select('*')
     .eq('ship_id', current_ship_id)
     .single();

   // Create new ship with new type
   const newShip = await supabase
     .from('ship_instances')
     .insert({
       owner_id: character_id,
       owner_type: 'character',
       owner_character_id: character_id,
       ship_type: new_ship_type,
       ship_name: currentShip.ship_name,
       current_sector: currentShip.current_sector,
       credits: currentShip.credits,
       // ... copy other fields
     })
     .select()
     .single();

   // Update character reference
   await supabase
     .from('characters')
     .update({ current_ship_id: newShip.ship_id })
     .eq('character_id', character_id);

   // **HARD DELETE old ship** (APPROVED DECISION)
   await supabase
     .from('ship_instances')
     .delete()
     .eq('ship_id', current_ship_id);
   ```

4. **Ship resource updates** (if provided):
   ```sql
   UPDATE ship_instances SET
     credits = COALESCE($1, credits),
     current_warp_power = COALESCE($2, current_warp_power),
     current_shields = COALESCE($3, current_shields),
     current_fighters = COALESCE($4, current_fighters),
     cargo_qf = COALESCE($5, cargo_qf),
     cargo_ro = COALESCE($6, cargo_ro),
     cargo_ns = COALESCE($7, cargo_ns)
   WHERE ship_id = (SELECT current_ship_id FROM characters WHERE character_id = $8)
   ```

**Response**:
```json
{
  "success": true,
  "character_id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "New Name",
  "player": {"credits": 10000},
  "ship": {"ship_type": "atlas_freighter", "current_fighters": 500, ...}
}
```

**Error Codes**:
- 400: Invalid ship_type, missing character_id
- 403: Invalid admin password
- 404: Character not found
- 409: New name already exists
- 500: Database error

---

### Function 4: reset_ports

**Endpoint**: `POST /functions/v1/reset_ports`

**Request Payload**:
```json
{
  "admin_password": "secret"
}
```

**Database Operations**:

Create stored procedure:
```sql
CREATE OR REPLACE FUNCTION reset_all_ports()
RETURNS INTEGER AS $$
DECLARE
  reset_count INTEGER := 0;
  initial_states JSONB;
  port_record RECORD;
  initial_state JSONB;
BEGIN
  -- Load initial states from universe_config
  SELECT generation_params->'initial_port_states' INTO initial_states
  FROM universe_config WHERE id = 1;

  IF initial_states IS NULL THEN
    RAISE EXCEPTION 'No initial port states found in universe_config';
  END IF;

  -- Reset each port to initial stock levels
  FOR port_record IN SELECT port_id, sector_id FROM ports LOOP
    initial_state := initial_states->port_record.sector_id::text;

    UPDATE ports SET
      stock_qf = (initial_state->>'stock_qf')::INTEGER,
      stock_ro = (initial_state->>'stock_ro')::INTEGER,
      stock_ns = (initial_state->>'stock_ns')::INTEGER,
      version = version + 1,
      last_updated = NOW()
    WHERE port_id = port_record.port_id;

    reset_count := reset_count + 1;
  END LOOP;

  RETURN reset_count;
END;
$$ LANGUAGE plpgsql;
```

**Edge Function Logic**:
```typescript
const result = await supabase.rpc('reset_all_ports');

await logAdminAction(supabase, {
  action: 'reset_ports',
  admin_user: 'admin',
  result: 'success',
  details: { ports_reset: result }
});

return successResponse({
  ports_reset: result,
  message: `Reset ${result} ports to initial state`
});
```

**Response**:
```json
{
  "success": true,
  "message": "Reset 1900 ports to initial state",
  "ports_reset": 1900
}
```

**Error Codes**:
- 403: Invalid admin password
- 500: Database error, missing initial state data

---

### Function 5: regenerate_ports

**Endpoint**: `POST /functions/v1/regenerate_ports`

**Request Payload**:
```json
{
  "admin_password": "secret",
  "fraction": 0.25
}
```

**Database Operations**:

Create stored procedure:
```sql
CREATE OR REPLACE FUNCTION regenerate_ports(fraction FLOAT DEFAULT 0.25)
RETURNS INTEGER AS $$
DECLARE
  regen_count INTEGER := 0;
  port_record RECORD;
  regen_amount INTEGER;
BEGIN
  IF fraction < 0.0 OR fraction > 1.0 THEN
    RAISE EXCEPTION 'Fraction must be between 0.0 and 1.0';
  END IF;

  FOR port_record IN SELECT * FROM ports LOOP
    -- Quantum Foam
    IF SUBSTRING(port_record.port_code, 1, 1) = 'S' THEN
      -- SELL port: increase stock toward max
      regen_amount := FLOOR(port_record.max_qf * fraction);
      UPDATE ports SET stock_qf = LEAST(max_qf, stock_qf + regen_amount)
      WHERE port_id = port_record.port_id;
    ELSIF SUBSTRING(port_record.port_code, 1, 1) = 'B' THEN
      -- BUY port: decrease stock (increase buying capacity)
      regen_amount := FLOOR(port_record.max_qf * fraction);
      UPDATE ports SET stock_qf = GREATEST(0, stock_qf - regen_amount)
      WHERE port_id = port_record.port_id;
    END IF;

    -- Retro Organics (index 2)
    IF SUBSTRING(port_record.port_code, 2, 1) = 'S' THEN
      regen_amount := FLOOR(port_record.max_ro * fraction);
      UPDATE ports SET stock_ro = LEAST(max_ro, stock_ro + regen_amount)
      WHERE port_id = port_record.port_id;
    ELSIF SUBSTRING(port_record.port_code, 2, 1) = 'B' THEN
      regen_amount := FLOOR(port_record.max_ro * fraction);
      UPDATE ports SET stock_ro = GREATEST(0, stock_ro - regen_amount)
      WHERE port_id = port_record.port_id;
    END IF;

    -- Neuro Symbolics (index 3)
    IF SUBSTRING(port_record.port_code, 3, 1) = 'S' THEN
      regen_amount := FLOOR(port_record.max_ns * fraction);
      UPDATE ports SET stock_ns = LEAST(max_ns, stock_ns + regen_amount)
      WHERE port_id = port_record.port_id;
    ELSIF SUBSTRING(port_record.port_code, 3, 1) = 'B' THEN
      regen_amount := FLOOR(port_record.max_ns * fraction);
      UPDATE ports SET stock_ns = GREATEST(0, stock_ns - regen_amount)
      WHERE port_id = port_record.port_id;
    END IF;

    -- Increment version for optimistic locking
    UPDATE ports SET version = version + 1, last_updated = NOW()
    WHERE port_id = port_record.port_id;

    regen_count := regen_count + 1;
  END LOOP;

  RETURN regen_count;
END;
$$ LANGUAGE plpgsql;
```

**Response**:
```json
{
  "success": true,
  "message": "Regenerated 1900 ports with 25.0% of max capacity",
  "ports_regenerated": 1900,
  "fraction": 0.25
}
```

**Error Codes**:
- 400: Fraction not between 0.0 and 1.0
- 403: Invalid admin password
- 500: Database error

---

### Function 6: leaderboard_resources

**Endpoint**: `POST /functions/v1/leaderboard_resources`

**Request Payload**:
```json
{
  "force_refresh": true
}
```

**Database Operations**:

Query existing materialized views (lines 713-780 in schema):

```typescript
// Check cache first
const cached = await supabase
  .from('leaderboard_cache')
  .select('*')
  .eq('id', 1)
  .single();

const cacheAge = Date.now() - new Date(cached.updated_at).getTime();
const isStale = cacheAge > 5 * 60 * 1000; // 5 minutes

if (force_refresh || isStale || !cached) {
  // Refresh materialized views
  await supabase.rpc('refresh_materialized_view', { view_name: 'leaderboard_wealth' });
  await supabase.rpc('refresh_materialized_view', { view_name: 'leaderboard_territory' });
  await supabase.rpc('refresh_materialized_view', { view_name: 'leaderboard_trading' });
  await supabase.rpc('refresh_materialized_view', { view_name: 'leaderboard_exploration' });

  // Query fresh data
  const [wealth, territory, trading, exploration] = await Promise.all([
    supabase.from('leaderboard_wealth').select('*').order('total_wealth', { ascending: false }).limit(100),
    supabase.from('leaderboard_territory').select('*').order('sectors_controlled', { ascending: false }).limit(100),
    supabase.from('leaderboard_trading').select('*').order('total_trade_volume', { ascending: false }).limit(100),
    supabase.from('leaderboard_exploration').select('*').order('sectors_visited', { ascending: false }).limit(100),
  ]);

  // Update cache
  await supabase.from('leaderboard_cache').upsert({
    id: 1,
    wealth: wealth.data,
    territory: territory.data,
    trading: trading.data,
    exploration: exploration.data,
    updated_at: new Date().toISOString()
  });

  return successResponse({ wealth, territory, trading, exploration });
} else {
  // Return cached data
  return successResponse({
    wealth: cached.wealth,
    territory: cached.territory,
    trading: cached.trading,
    exploration: cached.exploration
  });
}
```

**Response**:
```json
{
  "success": true,
  "wealth": [
    {
      "character_id": "...",
      "name": "Player Name",
      "total_wealth": 1000000,
      "bank_credits": 500000,
      "ship_credits": 200000,
      "cargo_value": 100000,
      "ships_owned": 3,
      "ship_value": 200000
    }
  ],
  "territory": [...],
  "trading": [...],
  "exploration": [...]
}
```

**No Admin Password Required** - Read-only operation, but rate-limited.

**Error Codes**:
- 500: Database error
- 503: Leaderboard computation timeout

---

## Part 3: Admin Audit Table

### Table Schema

**Migration**: `supabase/migrations/20251117000000_create_admin_actions.sql`

```sql
CREATE TABLE admin_actions (
  id BIGSERIAL PRIMARY KEY,
  action TEXT NOT NULL,
  admin_user TEXT NOT NULL DEFAULT 'admin',
  target_id UUID,
  payload JSONB,
  result TEXT NOT NULL,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_admin_actions_created_at ON admin_actions (created_at DESC);
CREATE INDEX idx_admin_actions_action ON admin_actions (action);
CREATE INDEX idx_admin_actions_target_id ON admin_actions (target_id);

COMMENT ON TABLE admin_actions IS 'Audit log for all admin operations';
```

### Logging Function

**Shared Helper**: `supabase/functions/_shared/admin_audit.ts`

```typescript
export async function logAdminAction(
  supabase: SupabaseClient,
  action: {
    action: string;
    admin_user?: string;
    target_id?: string;
    payload?: any;
    result: 'success' | 'error';
    error?: string;
  }
) {
  await supabase.from('admin_actions').insert({
    action: action.action,
    admin_user: action.admin_user || 'admin',
    target_id: action.target_id,
    payload: action.payload,
    result: action.result,
    error: action.error,
  });
}
```

### Usage Example

```typescript
try {
  // Perform admin operation
  const character = await createCharacter(...);

  await logAdminAction(supabase, {
    action: 'character_create',
    admin_user: 'admin',
    target_id: character.character_id,
    payload: payload,
    result: 'success',
  });

  return successResponse(character);
} catch (error) {
  await logAdminAction(supabase, {
    action: 'character_create',
    admin_user: 'admin',
    payload: payload,
    result: 'error',
    error: error.message,
  });

  throw error;
}
```

---

## Implementation Checklist

### Phase 1: Universe Data Loader (Current)
- [ ] Create `scripts/load_universe_to_supabase.py`
- [ ] Implement JSON parsing and validation
- [ ] Implement Supabase client connection (service role)
- [ ] Implement stock conversion logic (demand → stock)
- [ ] Implement batch insert (500 rows/batch)
- [ ] Add progress logging
- [ ] Add dry-run mode
- [ ] Add --force flag for reload
- [ ] Store initial port states in universe_config
- [ ] Add pre-flight validation checks
- [ ] Add post-load verification
- [ ] Test with test universe (10 sectors)
- [ ] Test with production universe (5000 sectors)
- [ ] Document usage in README

### Phase 2: Admin Infrastructure
- [ ] Create `admin_actions` table migration
- [ ] Create `_shared/admin_audit.ts` helper
- [ ] Create `leaderboard_cache` table
- [ ] Create stored procedures: `reset_all_ports()`, `regenerate_ports()`

### Phase 3: Character Admin Functions
- [ ] Create `character_create` edge function
- [ ] Create `character_delete` edge function
- [ ] Create `character_modify` edge function
- [ ] Add integration tests for all 3 functions

### Phase 4: Port Admin Functions
- [ ] Create `reset_ports` edge function
- [ ] Create `regenerate_ports` edge function
- [ ] Add integration tests for both functions

### Phase 5: Leaderboard Function
- [ ] Create `leaderboard_resources` edge function
- [ ] Implement caching mechanism
- [ ] Add integration tests

### Phase 6: Documentation & Cleanup
- [ ] Update API documentation
- [ ] Update admin-endpoints-alternatives.md (mark as IMPLEMENTED)
- [ ] Update codex with completion status
- [ ] Deprecate legacy FastAPI admin endpoints

---

## Success Criteria

✅ Universe loader loads 5000-sector universe in <5 minutes
✅ All 6 admin functions pass integration tests
✅ Admin password validation works (plain text + hashed)
✅ Character CRUD maintains data integrity
✅ Port operations match expected behavior
✅ Leaderboard computes in <2 seconds
✅ Admin audit table logs all operations
✅ Zero data loss during migration

---

## Approved Decisions

1. **Initial port states storage**: Store in `universe_config.generation_params` JSONB ✅
2. **Leaderboard caching**: Use materialized views + cache table ✅
3. **Character deletion**: Hard delete ✅
4. **Ship abandonment**: Hard delete old ship (not escape pod) ✅
5. **Admin audit log**: Create `admin_actions` table ✅

---

## Timeline Estimate

- **Phase 1** (Universe Loader): 3-5 days
- **Phase 2** (Admin Infrastructure): 1-2 days
- **Phase 3** (Character Functions): 3-4 days
- **Phase 4** (Port Functions): 2-3 days
- **Phase 5** (Leaderboard): 1-2 days
- **Phase 6** (Documentation): 1 day

**Total**: 11-17 days
