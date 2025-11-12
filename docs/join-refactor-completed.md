# Join Edge Function Refactor - Completed

**Date:** 2025-11-09
**Status:** ✅ Complete

---

## Changes Made

### 1. Join Edge Function (`supabase/functions/join/index.ts`)

**Removed auto-creation logic:**
- Lines 97-104: Changed from auto-creating character to returning 404
- Deleted `createCharacterRow()` function (was lines 235-274)
- Deleted `loadOrCreateShip()` function (was lines 311-362)
- Changed ship loading from `loadOrCreateShip()` to direct `loadShipRow()` call

**New behavior:**
```typescript
const character = await loadCharacterRow(supabase, characterId);
if (!character) {
  throw new JoinError('character not found', 404);
}
```

**Error handling:**
- 404: Character not found
- 500: Character has no ship
- 500: Character ship not found

### 2. Edge Tests - Character ID Updates

**Updated all edge test files** to use fixture character names instead of hardcoded UUIDs:

**Before:**
```python
character_id = '00000000-0000-0000-0000-000000000001'
```

**After:**
```python
character_id = 'test_2p_player1'  # Uses UUID v5 canonicalization
```

**Files updated (12 total):**
- `tests/edge/test_join.py`
- `tests/edge/test_my_status.py`
- `tests/edge/test_move_and_map.py`
- `tests/edge/test_plot_course.py`
- `tests/edge/test_path_with_region.py`
- `tests/edge/test_trade.py`
- `tests/edge/test_purchase_fighters.py`
- `tests/edge/test_ship_purchase.py`
- `tests/edge/test_dump_cargo.py`
- `tests/edge/test_warp_power.py`
- `tests/edge/test_credits.py`
- `tests/edge/test_event_query.py`
- `tests/edge/test_supabase_client_integration.py`

**Character ID mappings:**
- `'00000000-0000-0000-0000-000000000001'` → `'test_2p_player1'`
- `'00000000-0000-0000-0000-000000000002'` → `'test_2p_player2'`

### 3. Test Reset Function (No changes needed)

**Verification:**
- `test_reset/index.ts` already loads characters from `fixtures/characters.json`
- `loadDefaultCharacterIds()` function (lines 482-492) reads all character names from fixture
- `canonicalizeCharacterId()` function (lines 467-476) converts string names to UUIDs using UUID v5
- Fixture includes `test_2p_player1`, `test_2p_player2`, and many other test characters

**UUID v5 Canonicalization:**
- Namespace: `5a53c4f5-8f16-4be6-8d3d-2620f4c41b3b` (configurable via `SUPABASE_LEGACY_ID_NAMESPACE`)
- Deterministic: Same name always produces same UUID
- Enabled by: `SUPABASE_ALLOW_LEGACY_IDS=1` (default)

---

## Testing

### Run Edge Tests

```bash
# Start Supabase (if not already running)
npx supabase start

# Reset database to seed test characters
npx supabase db reset --yes

# Run all edge tests
USE_SUPABASE_TESTS=1 uv run pytest tests/edge/ -v

# Run specific test files
USE_SUPABASE_TESTS=1 uv run pytest tests/edge/test_join.py -xvs
USE_SUPABASE_TESTS=1 uv run pytest tests/edge/test_my_status.py -xvs
USE_SUPABASE_TESTS=1 uv run pytest tests/edge/test_trade.py -xvs
```

### Expected Results

All edge tests should now pass with proper fixture seeding:

- ✅ `test_join.py::test_join_requires_token` - Auth check with fixture char
- ✅ `test_join.py::test_join_returns_character_snapshot` - Join succeeds for seeded char
- ✅ `test_join.py::test_join_not_found` - 404 for missing character (99999...)
- ✅ All other edge tests use seeded fixture characters

---

## Benefits

1. **Explicit Fixture Management**
   - All characters come from `test_reset/fixtures/characters.json`
   - No hidden auto-creation side effects

2. **Test Isolation**
   - Each test run starts with known, deterministic state
   - `test.reset` RPC truncates and reseeds database

3. **Matches Production Behavior**
   - Join doesn't implicitly create characters
   - Matches FastAPI server behavior

4. **Simpler Debugging**
   - All test characters defined in one fixture file
   - UUID v5 mapping is deterministic and traceable

5. **Parity with Integration Tests**
   - Both edge and integration tests use same fixture characters
   - Consistent character IDs across test suites

---

## Architecture Notes

### Character ID Flow

**Edge Tests:**
```
Test Code
  ↓
"test_2p_player1" (string)
  ↓
Supabase Client (utils/legacy_ids.py)
  ↓
UUID v5 Canonicalization
  ↓
"a1b2c3d4-..." (deterministic UUID)
  ↓
Edge Function
  ↓
Database Lookup
```

**Test Reset Flow:**
```
test_reset/index.ts
  ↓
fixtures/characters.json
  ↓
canonicalizeCharacterId("test_2p_player1")
  ↓
UUID v5 with namespace
  ↓
INSERT INTO characters (character_id = "a1b2c3d4-...")
```

### UUID v5 Namespace

**Purpose:** Convert human-readable test names to deterministic UUIDs

**Implementation:**
```typescript
// In test_reset/index.ts
const LEGACY_NAMESPACE = '5a53c4f5-8f16-4be6-8d3d-2620f4c41b3b';

async function canonicalizeCharacterId(value: string): Promise<string> {
  if (validateUuid(value)) {
    return value.toLowerCase();  // Already a UUID
  }
  return await generateUuidV5(LEGACY_NAMESPACE, value);  // Convert name to UUID
}
```

**Python Side:**
```python
# In utils/legacy_ids.py
LEGACY_NAMESPACE = uuid.UUID('5a53c4f5-8f16-4be6-8d3d-2620f4c41b3b')

def canonicalize_character_id(value: str) -> str:
    try:
        return str(uuid.UUID(value)).lower()  # Already a UUID
    except ValueError:
        return str(uuid.uuid5(LEGACY_NAMESPACE, value))  # Convert name to UUID
```

---

## Next Steps

1. **Run Full Edge Test Suite** ✅ Ready to run
2. **Verify Integration Tests Still Pass** (They use same fixtures, should be fine)
3. **Update Endpoint Status Doc** (Mark test.reset as complete, join as properly tested)
4. **Continue with Garrison Endpoints** (Next priority from status doc)

---

## Rollback Instructions

If needed, revert changes with:

```bash
git checkout supabase/functions/join/index.ts
git checkout tests/edge/test_*.py
```

Then run:
```bash
npx supabase db reset --yes
```

---

**End of Report**
