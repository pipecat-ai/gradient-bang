# Combat

Initiates a combat encounter for testing. Calls the `combat_initiate` edge function to start combat in the sector of a given character/ship.

## Parameters

- **target** (required): Either a character name (e.g. `JOETRADER`) or a ship UUID to initiate combat from that ship's character.

If not provided, ask the user for a character name or ship ID.

## Steps

### 1. Source environment variables

```bash
set -a && source .env.supabase && set +a
```

### 2. Resolve the character and ship

**If target is a character name:**

Look up the character by name:

```bash
curl -s "${SUPABASE_URL}/rest/v1/characters?name=eq.<character_name>&select=character_id,name,current_ship_id,corporation_id" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}"
```

If no result, report that the character was not found and stop. Save `character_id` and `current_ship_id`.

Then look up the ship to get the sector:

```bash
curl -s "${SUPABASE_URL}/rest/v1/ship_instances?ship_id=eq.<current_ship_id>&select=ship_id,ship_type,ship_name,current_sector,current_fighters,current_shields" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}"
```

**If target is a ship UUID:**

Look up the ship and its associated character:

```bash
curl -s "${SUPABASE_URL}/rest/v1/ship_instances?ship_id=eq.<ship_id>&destroyed_at=is.null&select=ship_id,ship_type,ship_name,current_sector,owner_type,owner_character_id,owner_corporation_id" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}"
```

For `owner_type = "character"`, use `owner_character_id` as the character_id.
For `owner_type = "corporation"`, the pseudo-character has `character_id = ship_id`.

Then look up the character:

```bash
curl -s "${SUPABASE_URL}/rest/v1/characters?character_id=eq.<character_id>&select=character_id,name,current_ship_id" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}"
```

Verify the character exists and `current_ship_id` matches the ship. If not, report the mismatch and stop.

### 3. Show sector context

Before initiating, show what's in the sector so the user knows what opponents are present:

```bash
curl -s "${SUPABASE_URL}/rest/v1/ship_instances?current_sector=eq.<sector>&destroyed_at=is.null&in_hyperspace=eq.false&select=ship_id,ship_type,ship_name,owner_type,owner_character_id,current_fighters,current_shields,is_escape_pod" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}"
```

Display a summary table of ships in the sector (name, type, fighters, shields). Highlight the initiating ship.

### 4. Call combat_initiate

```bash
curl -s -X POST "${SUPABASE_URL}/functions/v1/combat_initiate" \
  -H "Content-Type: application/json" \
  -H "x-api-token: ${EDGE_API_TOKEN}" \
  -d '{
    "character_id": "<character_id>",
    "admin_override": true
  }'
```

If `EDGE_API_TOKEN` is not set in the environment, omit the `x-api-token` header (local dev without JWT verification allows all requests).

### 5. Report the result

Show the user:
- Initiating character name and ship
- Sector where combat started
- Combat ID from the response
- Number of ships in sector (potential participants)
- Any error messages if combat initiation failed (e.g., no opponents, already in combat, federation space)

## Important notes

- This calls the real `combat_initiate` edge function, which creates a full combat encounter with deadlines and round timers
- Combat will auto-resolve via `combat_tick` if no actions are submitted before the deadline
- The initiating character must have fighters > 0 and not be in hyperspace or federation space
- There must be at least one targetable opponent in the sector (not same corp, not an escape pod, has fighters)
- If combat already exists in the sector, the character joins the existing encounter
- Edge functions must be running: `npx supabase functions serve --workdir deployment --no-verify-jwt --env-file .env.supabase`
