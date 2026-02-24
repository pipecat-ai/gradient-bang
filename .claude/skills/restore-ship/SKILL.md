# Restore Ship

Restores a ship to a healthy state for testing. Clears the `destroyed_at` flag, restocks fighters/shields/warp power to max values from the ship definition, and re-adds corporation ships to `corporation_ships` if missing.

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

Save the `ship_type` and `owner_corporation_id` for subsequent steps.

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

### 6. Report the result

Show the user:
- Ship details: ship_id, ship_type, ship_name, sector
- Whether `destroyed_at` was cleared
- Restored stats: fighters, shields, warp power
- Whether it was re-added to `corporation_ships`

## Important notes

- This is a database-only operation — no events are emitted to clients
- Connected clients will NOT see the ship reappear until they refresh or receive another event
- The ship's cargo, credits, and other state are not modified — only combat-related stats are restored
- For corporation ships that were destroyed, the pseudo-character record may have been deleted. This skill does not recreate it. If the ship needs to be fully functional for combat, you may need to recreate the pseudo-character manually
