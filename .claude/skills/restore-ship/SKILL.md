# Restore Ship

Restores a ship to a healthy state for testing. Clears the `destroyed_at` flag, restocks fighters/shields/warp power to max values from the ship definition, re-adds corporation ships to `corporation_ships` if missing, and recreates the pseudo-character record for corp ships so tasks can be issued.

No events are emitted — this is a database-only operation.

## Parameters

Ask the user for:
- **ship_id**: UUID of the ship to restore (required)

## Steps

### 1. Source environment variables

```bash
set -a && source .env.supabase && set +a
```

### 2. Look up the ship

Fetch the ship from `ship_instances` (including destroyed ships).

```bash
curl -s "${SUPABASE_URL}/rest/v1/ship_instances?ship_id=eq.<ship_id>&select=ship_id,ship_type,ship_name,current_sector,owner_type,owner_corporation_id,destroyed_at" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}"
```

If the result is empty, the ship doesn't exist. Report this and stop.

Save the `ship_type`, `owner_type`, `owner_corporation_id`, and `current_sector` for subsequent steps.

### 3. Look up ship definition

Get the max values for fighters, shields, and warp power from `ship_definitions`.

```bash
curl -s "${SUPABASE_URL}/rest/v1/ship_definitions?ship_type=eq.<ship_type>&select=ship_type,fighters,shields,warp_power_capacity" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}"
```

### 4. Restore ship instance

Update the ship to clear destroyed state and restock to full capacity.

```bash
curl -s -X PATCH "${SUPABASE_URL}/rest/v1/ship_instances?ship_id=eq.<ship_id>" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d '{
    "destroyed_at": null,
    "current_fighters": <fighters_from_definition>,
    "current_shields": <shields_from_definition>,
    "current_warp_power": <warp_power_capacity_from_definition>
  }'
```

### 5. Re-add to corporation_ships (corp ships only)

If the ship is corporation-owned (`owner_type = "corporation"`), check if it's in `corporation_ships` and re-add if missing.

```bash
curl -s "${SUPABASE_URL}/rest/v1/corporation_ships?ship_id=eq.<ship_id>&select=ship_id" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}"
```

If the result is empty, re-insert:

```bash
curl -s -X POST "${SUPABASE_URL}/rest/v1/corporation_ships" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d '{
    "corp_id": "<owner_corporation_id>",
    "ship_id": "<ship_id>"
  }'
```

### 6. Recreate pseudo-character record (corp ships only)

If the ship is corporation-owned (`owner_type = "corporation"`), check if the pseudo-character record exists. Combat finalization deletes this record when a corp ship is destroyed, and without it `current_ship_id` is null so no tasks can be issued.

```bash
curl -s "${SUPABASE_URL}/rest/v1/characters?character_id=eq.<ship_id>&select=character_id,current_ship_id" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}"
```

If the result is empty, recreate the pseudo-character. Use the first 6 hex chars of ship_id as the name suffix:

```bash
curl -s -X POST "${SUPABASE_URL}/rest/v1/characters" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d '{
    "character_id": "<ship_id>",
    "name": "Corp Ship [<first_6_hex_of_ship_id>]",
    "current_ship_id": "<ship_id>",
    "credits_in_megabank": 0,
    "map_knowledge": {
      "total_sectors_visited": 0,
      "sectors_visited": {},
      "current_sector": <current_sector>,
      "last_update": "<now_iso_timestamp>"
    },
    "player_metadata": {
      "player_type": "corporation_ship",
      "owner_corp_id": "<owner_corporation_id>"
    },
    "is_npc": true,
    "first_visit": "<now_iso_timestamp>",
    "last_active": "<now_iso_timestamp>",
    "created_at": "<now_iso_timestamp>",
    "corporation_id": "<owner_corporation_id>",
    "corporation_joined_at": "<now_iso_timestamp>"
  }'
```

If the pseudo-character exists but `current_ship_id` is null, update it:

```bash
curl -s -X PATCH "${SUPABASE_URL}/rest/v1/characters?character_id=eq.<ship_id>" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d '{
    "current_ship_id": "<ship_id>"
  }'
```

### 7. Report the result

Show the user:
- Ship details: ship_id, ship_type, ship_name, sector
- Whether `destroyed_at` was cleared
- Restored stats: fighters, shields, warp power
- Whether it was re-added to `corporation_ships`
- Whether the pseudo-character was recreated or its `current_ship_id` was fixed

## Important notes

- This is a database-only operation — no events are emitted to clients
- Connected clients will NOT see the ship reappear until they refresh or receive another event
- The ship's cargo, credits, and other state are not modified — only combat-related stats are restored
