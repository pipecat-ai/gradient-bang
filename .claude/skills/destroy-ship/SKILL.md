# Destroy Ship

Destroys a corporation ship for testing. Performs the full end-to-end flow: database soft-delete, pseudo-character cleanup, and `ship.destroyed` event emission so connected clients update in real-time.

Uses the Supabase REST API and existing `record_event_with_recipients` RPC — no new edge functions required.

## Parameters

Ask the user for:
- **ship_id**: UUID of the ship to destroy (required)

## Steps

### 1. Source environment variables

```bash
set -a && source .env.supabase && set +a
```

### 2. Look up the ship

Fetch the ship from `ship_instances` via the REST API. It must exist and not already be destroyed.

```bash
curl -s "${SUPABASE_URL}/rest/v1/ship_instances?ship_id=eq.<ship_id>&destroyed_at=is.null&select=ship_id,ship_type,ship_name,current_sector,owner_type,owner_character_id,owner_corporation_id" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}"
```

If the result is an empty array, the ship either doesn't exist or is already destroyed. Report this and stop.

Save the ship details for subsequent steps: `ship_type`, `ship_name`, `current_sector`, `owner_type`, `owner_corporation_id`.

### 3. Look up the character name

For corporation ships, the pseudo-character has `character_id = ship_id`. For personal ships, use `owner_character_id`.

```bash
curl -s "${SUPABASE_URL}/rest/v1/characters?character_id=eq.<character_id>&select=character_id,name" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}"
```

Save the character `name` as `player_name` for the event payload.

### 4. Compute event recipients

Query sector occupants and corporation members to build the recipient list.

**Sector occupants** — all non-destroyed ships in the same sector:
```bash
curl -s "${SUPABASE_URL}/rest/v1/ship_instances?current_sector=eq.<sector>&destroyed_at=is.null&select=owner_character_id" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}"
```

**Corporation members** (if the ship is corporation-owned):
```bash
curl -s "${SUPABASE_URL}/rest/v1/corporation_members?corporation_id=eq.<corp_id>&select=character_id" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}"
```

Combine all character IDs, deduplicate, and filter out nulls. Build two parallel arrays:
- `p_recipients`: array of character UUIDs
- `p_reasons`: array of reason strings (`"sector_observer"` for sector occupants, `"corp_member"` for corp members)

### 5. Emit `ship.destroyed` event

Call the existing `record_event_with_recipients` RPC. This must happen BEFORE the destruction steps so the event references valid data.

The payload shape must match what `combat_finalization.ts` emits (lines 383-394):

```bash
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)

curl -s -X POST "${SUPABASE_URL}/rest/v1/rpc/record_event_with_recipients" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "p_event_type": "ship.destroyed",
    "p_direction": "event_out",
    "p_scope": "sector",
    "p_sector_id": <current_sector>,
    "p_ship_id": "<ship_id>",
    "p_actor_character_id": null,
    "p_payload": {
      "source": {
        "type": "rpc",
        "method": "ship.destroyed",
        "request_id": "admin-destroy",
        "timestamp": "<TIMESTAMP>"
      },
      "timestamp": "<TIMESTAMP>",
      "ship_id": "<ship_id>",
      "ship_type": "<ship_type>",
      "ship_name": "<ship_name>",
      "player_type": "corporation_ship",
      "player_name": "<player_name>",
      "sector": { "id": <current_sector> },
      "combat_id": "admin-destroy",
      "salvage_created": false
    },
    "p_recipients": ["<uuid1>", "<uuid2>"],
    "p_reasons": ["sector_observer", "corp_member"],
    "p_is_broadcast": false
  }'
```

For personal (non-corp) ships, set `"player_type": "human"` instead.

### 6. Execute destruction

Perform database cleanup in this exact order (matches `combat_finalization.ts` lines 435-481). Use the REST API with the service role key.

**a. Unlink character's current_ship_id:**
```bash
curl -s -X PATCH "${SUPABASE_URL}/rest/v1/characters?character_id=eq.<character_id>" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"current_ship_id": null}'
```

**b. Delete pseudo-character record** (corporation ships only — the pseudo-character has `character_id = ship_id`):
```bash
curl -s -X DELETE "${SUPABASE_URL}/rest/v1/characters?character_id=eq.<ship_id>" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}"
```

**c. Soft-delete ship instance** (set `destroyed_at`):
```bash
curl -s -X PATCH "${SUPABASE_URL}/rest/v1/ship_instances?ship_id=eq.<ship_id>" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"destroyed_at": "<TIMESTAMP>"}'
```

**d. Remove from corporation_ships** (corporation ships only):
```bash
curl -s -X DELETE "${SUPABASE_URL}/rest/v1/corporation_ships?ship_id=eq.<ship_id>" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}"
```

### 7. Report the result

Show the user:
- Ship details: ship_id, ship_type, ship_name, sector
- Whether the `ship.destroyed` event was emitted (and how many recipients)
- Database changes made (soft-delete, pseudo-character deleted, removed from corporation_ships)

## Important notes

- Works for both corporation ships and personal ships, but the primary use case is corp ships
- Corporation ships: pseudo-character is deleted, ship removed from `corporation_ships`
- Personal ships: only steps a and c apply (unlink and soft-delete)
- The event is emitted BEFORE destruction so it references valid DB state
- The `combat_id` is set to `"admin-destroy"` to distinguish from real combat
- `salvage_created` is always `false` — no salvage is generated
- Ships already destroyed (`destroyed_at IS NOT NULL`) are rejected in step 2

## Reference files

- Event payload shape: `deployment/supabase/functions/_shared/combat_finalization.ts` lines 383-394
- Destruction order: `deployment/supabase/functions/_shared/combat_finalization.ts` lines 435-481
- RPC parameters: `deployment/supabase/functions/_shared/events.ts` lines 80-97
- Client handler: `client/app/src/utils/combat.ts` `applyShipDestroyedState()`
