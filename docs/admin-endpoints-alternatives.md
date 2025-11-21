# Admin Endpoints - Supabase Alternatives

**Last Updated:** 2025-11-16 20:15 UTC
**Status:** Out of scope for initial Supabase migration

## Summary

Six admin endpoints from the legacy game-server are **intentionally not implemented** as Supabase Edge Functions. These endpoints manipulate complex in-memory state that doesn't exist in Supabase's database architecture. Instead, use the alternatives below.

---

## Missing Endpoints & Alternatives

### 1. `character_create` - Create Character

**Legacy Endpoint**: `POST /api/character_create`
- **Parameters**: `admin_password`, `name`, `player` (credits, player_type), `ship` (ship_type, cargo, fighters, shields, warp_power)
- **Purpose**: Create characters with custom stats for testing/admin

**Supabase Alternative**: **Direct SQL**

```sql
-- 1. Insert character record
INSERT INTO characters (character_id, name, created_at, last_active)
VALUES (
  gen_random_uuid(),
  'Character Name',
  NOW(),
  NOW()
);

-- 2. Insert ship_instance
INSERT INTO ship_instances (
  ship_id,
  owner_character_id,
  ship_type,
  name,
  current_sector,
  current_fighters,
  current_shields,
  current_warp_power,
  cargo_quantum_foam,
  cargo_retro_organics,
  cargo_neuro_symbolics,
  credits_in_hold
)
VALUES (
  gen_random_uuid(),
  '<character_id_from_step_1>',
  'kestrel_courier',  -- or 'atlas_hauler'
  'Ship Name',
  0,  -- starting sector
  50,  -- fighters
  100,  -- shields
  500,  -- warp power
  0,  -- quantum_foam
  0,  -- retro_organics
  0,  -- neuro_symbolics
  10000  -- credits
);
```

**Or use**: `tests/helpers/combat_helpers.py::create_test_character_knowledge()` for test scenarios

---

### 2. `character_delete` - Delete Character

**Legacy Endpoint**: `POST /api/character_delete`
- **Parameters**: `admin_password`, `character_id`
- **Purpose**: Remove character and clean up corporation membership

**Supabase Alternative**: **Direct SQL**

```sql
-- Delete character (cascades to ship_instances via FK)
DELETE FROM characters WHERE character_id = '<character_id>';

-- If in corporation, remove membership
DELETE FROM corporation_members WHERE character_id = '<character_id>';

-- Clean up orphaned corporations
DELETE FROM corporations
WHERE id NOT IN (SELECT DISTINCT corporation_id FROM corporation_members WHERE corporation_id IS NOT NULL);
```

**Or use**: Supabase Studio > Table Editor > Delete row

---

### 3. `character_modify` - Modify Character

**Legacy Endpoint**: `POST /api/character_modify`
- **Parameters**: `admin_password`, `character_id`, `name`, `player`, `ship`
- **Purpose**: Update character stats/name

**Supabase Alternative**: **Direct SQL**

```sql
-- Update character name
UPDATE characters
SET name = 'New Name'
WHERE character_id = '<character_id>';

-- Update ship stats
UPDATE ship_instances
SET
  current_fighters = 500,
  current_shields = 200,
  credits_in_hold = 50000,
  cargo_quantum_foam = 10
WHERE owner_character_id = '<character_id>';
```

**Or use**: Supabase Studio > Table Editor > Edit row

---

### 4. `reset_ports` - Reset Port Inventories

**Legacy Endpoint**: `POST /api/reset_ports`
- **Parameters**: None (admin only)
- **Purpose**: Reset all ports to default inventory/prices

**Supabase Alternative**: **SQL Script**

```sql
-- Reset all port inventories to defaults
UPDATE ports
SET
  quantum_foam_quantity = CASE port_class WHEN 'S' THEN 1000 ELSE 0 END,
  retro_organics_quantity = CASE port_class WHEN 'S' THEN 1000 ELSE 0 END,
  neuro_symbolics_quantity = CASE port_class WHEN 'S' THEN 1000 ELSE 0 END,
  -- Add price resets as needed
  last_updated = NOW()
WHERE id IS NOT NULL;
```

---

### 5. `regenerate_ports` - Regenerate Port Locations

**Legacy Endpoint**: `POST /api/regenerate_ports`
- **Parameters**: None (admin only)
- **Purpose**: Regenerate random port locations in universe

**Supabase Alternative**: **Migration Script**

Run the universe generation script to create new port placements:

```bash
# Re-run universe generation
npx supabase db reset  # WARNING: Destroys all data
# Then re-seed with new port locations
```

**Or**: Use SQL to randomly reassign ports to sectors (preserve existing ports, change locations):

```sql
-- Reassign ports to random sectors (example)
UPDATE ports
SET sector_id = (SELECT id FROM sectors ORDER BY RANDOM() LIMIT 1)
WHERE id IS NOT NULL;
```

---

### 6. `leaderboard_resources` - Get Leaderboard

**Legacy Endpoint**: `GET /leaderboard/resources`
- **Parameters**: `force_refresh` (optional)
- **Purpose**: Return resource leaderboard (calls rebuild script + file cache)

**Supabase Alternative**: **Database View + Query**

Create a materialized view or query:

```sql
-- Option 1: Real-time query
SELECT
  c.name,
  c.character_id,
  s.credits_in_hold + COALESCE(c.credits_in_bank, 0) AS total_credits,
  s.cargo_quantum_foam + s.cargo_retro_organics + s.cargo_neuro_symbolics AS total_cargo,
  s.current_fighters
FROM characters c
JOIN ship_instances s ON s.owner_character_id = c.character_id
ORDER BY total_credits DESC
LIMIT 100;

-- Option 2: Materialized view (for performance)
CREATE MATERIALIZED VIEW leaderboard_snapshot AS
SELECT
  c.name,
  c.character_id,
  s.credits_in_hold + COALESCE(c.credits_in_bank, 0) AS total_credits,
  s.cargo_quantum_foam + s.cargo_retro_organics + s.cargo_neuro_symbolics AS total_cargo,
  s.current_fighters,
  NOW() AS snapshot_time
FROM characters c
JOIN ship_instances s ON s.owner_character_id = c.character_id
ORDER BY total_credits DESC;

-- Refresh periodically via cron
REFRESH MATERIALIZED VIEW leaderboard_snapshot;
```

**Then create edge function** that queries this view (simpler than legacy).

---

## Why Not Implement These?

### 1. **Architecture Mismatch**

Legacy endpoints manipulate `world` object (in-memory state):
- `world.knowledge_manager`
- `world.ships_manager`
- `world.characters` (dict)
- `world.character_registry`
- `world.corporation_manager`

Supabase uses **database-first architecture** - no in-memory state to manipulate.

### 2. **Supabase Has Better Tools**

- **Supabase Studio**: Visual table editor, SQL editor
- **SQL Direct Access**: More powerful than RPC endpoints
- **Postgres Functions**: Can write stored procedures if needed

### 3. **Test Infrastructure Works Without Them**

Tests use `create_test_character_knowledge()` and direct database setup, not these endpoints.

### 4. **Not Player-Facing**

These are admin-only tools. Players never call them. No impact on gameplay.

---

## Recommendation

**Mark Phase 8 (API Parity) as COMPLETE for gameplay.**

- ✅ 35/35 player-facing endpoints implemented
- ✅ 100% gameplay functionality
- ❌ 6 admin tools - use Supabase Studio / SQL instead

**Future Work** (if needed):

Create simplified Supabase Edge Functions for these, but they'll be simple SQL wrappers, not ports of the complex legacy code.

---

## Migration Impact

**Before Supabase**:
- Admin uses `scripts/character_create.py` → calls `/api/character_create`
- Admin uses `scripts/character_modify.py` → calls `/api/character_modify`

**After Supabase**:
- Admin uses Supabase Studio → direct table edits
- OR admin runs SQL scripts → direct database access
- OR rewrite scripts to use Supabase client library

**No player impact** - these are admin-only operations.
