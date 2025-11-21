# Join Edge Function Refactor Plan

**Date:** 2025-11-09
**Goal:** Remove implicit character creation from join edge function and establish proper test seeding

---

## Current State

**Join edge function** (`supabase/functions/join/index.ts`):
- Lines 97-104: Auto-creates character if not found
- Lines 235-274: `createCharacterRow()` creates character with default values
- **Problem:** Tests depend on this side effect instead of proper fixtures

**Test reset function** (`supabase/functions/test_reset/index.ts`):
- ✅ Exists and seeds characters from `fixtures/characters.json`
- ✅ Uses UUID v5 to convert legacy string IDs to deterministic UUIDs
- ✅ Seeds ships, map knowledge, universe structure
- **Problem:** Edge tests use raw UUIDs (`00000000-0000-0000-0000-000000000001`) that don't match fixture character IDs

---

## Changes Required

### 1. Update Join Edge Function

**Remove auto-creation logic:**
```typescript
// BEFORE (lines 97-104):
let character = await loadCharacterRow(supabase, characterId);
if (!character) {
  character = await createCharacterRow({
    supabase,
    characterId,
    displayName: payload.name ?? characterId,
  });
}

// AFTER:
const character = await loadCharacterRow(supabase, characterId);
if (!character) {
  throw new JoinError('character not found', 404);
}
```

**Remove unused function:**
- Delete `createCharacterRow()` function (lines 235-274)
- Delete `loadOrCreateShip()` call (replace with direct `loadShipRow()`)

### 2. Update Edge Tests

**Current state:**
- Tests use raw UUID: `'00000000-0000-0000-0000-000000000001'`
- This UUID doesn't match any fixture character

**Options:**

**Option A: Map test UUIDs to fixture character names**
- Add mapping to `test_reset/index.ts`:
  ```typescript
  const TEST_UUID_MAPPINGS: Record<string, string> = {
    '00000000-0000-0000-0000-000000000001': 'test_edge_char1',
    '00000000-0000-0000-0000-000000000002': 'test_edge_char2',
    // etc.
  };
  ```
- Update test_reset to seed these as aliases

**Option B: Use existing fixture character names in tests** (RECOMMENDED)
- Update edge tests to use: `test_2p_player1`, `test_2p_player2`, etc.
- Leverage existing UUID v5 canonicalization in tests
- Add helper in Python: `utils/legacy_ids.py:canonicalize_character_id()`

**Option C: Add dedicated edge test characters to fixtures**
- Add new entries to `test_reset/fixtures/characters.json`:
  ```json
  {
    "test_edge_char1": { ... },
    "test_edge_char2": { ... }
  }
  ```
- Update edge tests to use these names

**Recommendation:** Use **Option B** - reuse existing fixture characters. This keeps fixture count manageable and reuses the same characters across edge and integration tests.

### 3. Update Test Reset to Seed Edge Test Characters

**Current test_reset character sources:**
1. `fixtures/characters.json` - Large fixture with integration test characters
2. `EXTRA_CHARACTERS` set - Currently just `['test_reset_runner']`

**Add edge test characters to default seed:**
```typescript
const EXTRA_CHARACTERS = new Set([
  'test_reset_runner',
  'test_edge_char1',      // For basic edge tests
  'test_edge_char2',      // For multi-character tests
]);
```

OR use Option B and rely on existing fixture characters.

---

## Implementation Steps

### Step 1: Update Join Edge Function (15 minutes)

```bash
# Edit supabase/functions/join/index.ts
# - Remove auto-creation logic (lines 97-104)
# - Remove createCharacterRow() function
# - Replace loadOrCreateShip() with loadShipRow()
# - Handle 404 error when character not found
```

### Step 2: Add Edge Test Character Helper (10 minutes)

```python
# utils/test_character_ids.py (new file)

EDGE_TEST_CHARACTERS = {
    'char1': 'test_2p_player1',  # Reuse existing fixture
    'char2': 'test_2p_player2',
    'trader': 'test_trader',     # If exists in fixture
}

def get_edge_test_char_id(alias: str) -> str:
    """Get character name for edge tests."""
    name = EDGE_TEST_CHARACTERS.get(alias)
    if not name:
        raise ValueError(f"Unknown edge test character: {alias}")
    return name
```

### Step 3: Update Edge Tests to Use Fixture Characters (30 minutes)

```python
# tests/edge/test_join.py
from utils.test_character_ids import get_edge_test_char_id

def test_join_returns_character_snapshot():
    char_id = get_edge_test_char_id('char1')  # Returns 'test_2p_player1'
    resp = _call_join(char_id, token=_expected_token())
    # ...
```

**OR** simpler - just use the names directly:

```python
def test_join_returns_character_snapshot():
    resp = _call_join('test_2p_player1', token=_expected_token())
    # ...
```

### Step 4: Verify Test Reset Seeds Required Characters (5 minutes)

```bash
# Check that test_reset fixtures include all characters used by edge tests
grep -E "test_2p_player|test_trader" supabase/functions/test_reset/fixtures/characters.json
```

### Step 5: Run Edge Tests (10 minutes)

```bash
# Reset database and run tests
npx supabase db reset --yes
uv run pytest tests/edge/test_join.py -xvs
uv run pytest tests/edge/test_move_and_map.py -xvs
uv run pytest tests/edge/test_trade.py -xvs
# ... etc
```

---

## Expected Test Failures (Before Fixes)

### test_join.py
- `test_join_not_found()` - Currently expects auto-creation, should now expect 404 ✅

### All other tests
- May fail if using UUID `00000000-0000-0000-0000-000000000001` which doesn't exist after reset

---

## Verification Checklist

- [ ] Join edge function returns 404 for missing characters
- [ ] `createCharacterRow()` function removed
- [ ] Edge tests updated to use fixture character names
- [ ] Test reset successfully seeds all required characters
- [ ] All edge tests pass after update
- [ ] Integration tests still pass (they already use proper fixtures)

---

## Benefits

1. **Explicit fixture management** - No hidden character creation
2. **Test isolation** - Each test run starts with known state
3. **Matches production behavior** - Join doesn't create characters implicitly
4. **Simpler debugging** - All characters come from fixtures, not auto-creation
5. **Parity with FastAPI** - FastAPI join also expects pre-existing characters

---

## Timeline

- **Step 1-2:** 25 minutes (update join, add helper)
- **Step 3:** 30 minutes (update edge tests)
- **Step 4-5:** 15 minutes (verify and test)
- **Total:** ~70 minutes (1.2 hours)

---

**End of Plan**
