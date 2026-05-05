---
name: character-create
description: Create a new game character with optional custom ship, credits, and onboarding skip. Usage `/character-create [env] <name> <email> <password> [credits <N>] [ship <type>] [skip-onboarding]`.
---

# Create Character

Creates a new game character for an authenticated user via the public `user_character_create` edge function, then optionally customizes ship, credits, and onboarding state via direct SQL.

## Parameters

The user specifies the environment and options as arguments. If not provided, default to `local` and ask for any missing required params.

```
/character-create [env] <name> <email> <password> [credits <N>] [ship <ship_type>] [skip-onboarding]
```

- **env**: `local` (default) or `dev`
  - `local` → `.env.supabase`
  - `dev` → `.env.cloud.dev`
- **name**: character name (required, 3-20 chars)
- **email**: user email (required)
- **password**: user password (required)
- **credits**: optional, number of starting credits (default: 12000)
- **ship**: optional, ship type as snake_case (default: `sparrow_scout`). Convert display names to snake_case (e.g., "Kestrel Courier" → `kestrel_courier`)
- **skip-onboarding**: optional flag. If absent, ask the user if they want to skip onboarding.

### Valid ship types

`sparrow_scout`, `kestrel_courier`, `parhelion_seeker`, `wayfarer_freighter`, `pioneer_lifter`, `atlas_hauler`, `corsair_raider`, `pike_frigate`, `bulwark_destroyer`, `aegis_cruiser`, `sovereign_starcruiser`

## Steps

### 1. Source environment variables

```bash
set -a && source <env-file> && set +a
```

### 2. Login and obtain access token

Call the `login` edge function to authenticate and get an access token and user ID.

```bash
curl -s -X POST "${SUPABASE_URL}/functions/v1/login" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "<email>",
    "password": "<password>"
  }'
```

Extract `session.access_token` and `user.id` from the response. If login fails, report the error and stop.

### 3. Create the character

Call the `user_character_create` edge function using the access token.

```bash
curl -s -X POST "${SUPABASE_URL}/functions/v1/user_character_create" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <access_token>" \
  -d '{
    "name": "<character_name>"
  }'
```

Extract `character_id` and `ship.ship_id` from the response. If creation fails, report the error and stop.

### 4. Customize via SQL (if needed)

If the user specified custom credits, a custom ship, or skip-onboarding, run SQL to apply those changes. Use the appropriate SQL method for the environment:

**Local:**
```bash
docker exec -e PGPASSWORD=postgres supabase_db_gb-world-server \
  psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -c "<sql>"
```

**Dev (cloud):**
```bash
psql "${POSTGRES_POOLER_URL}" -v ON_ERROR_STOP=1 -c "<sql>"
```

#### 4a. Custom credits

```sql
UPDATE ship_instances SET credits = <credits> WHERE ship_id = '<ship_id>';
```

#### 4b. Custom ship type

Look up the ship definition, then update the ship instance with the new type and its stats:

```sql
UPDATE ship_instances SET
  ship_type = '<ship_type>',
  current_warp_power = sd.warp_power_capacity,
  current_shields = sd.shields,
  current_fighters = sd.fighters
FROM ship_definitions sd
WHERE ship_instances.ship_id = '<ship_id>'
  AND sd.ship_type = '<ship_type>';
```

#### 4c. Skip onboarding

Two things need to happen:

1. Set `first_visit` to the past so the join endpoint does not flag `is_first_visit`:

```sql
UPDATE characters SET first_visit = NOW() - INTERVAL '1 day' WHERE character_id = '<character_id>';
```

2. Remove any auto-assigned onboarding quests:

```sql
DELETE FROM player_quests
WHERE player_id = '<character_id>'
  AND quest_id IN (
    SELECT id FROM quest_definitions WHERE assign_on_creation = true
  );
```

You can combine multiple SQL statements in a single psql call separated by semicolons.

### 5. Report the result

Show the user:
- `character_id`, `name`
- Ship: `ship_id`, `ship_type`, `current_sector`
- Credits (final value after any customization)
- Whether onboarding was skipped

### 6. Update .env.bot (optional)

After reporting the result, check whether `BOT_TEST_CHARACTER_ID` exists in `.env.bot`. If it does, ask whether to update the bot's dev session to this new character.

If yes, write **both** of these (the bot's `/start` requires a real Supabase Auth JWT for the owning user — needed even in polling mode, because per-character endpoints check the JWT instead of falling back to `EDGE_API_TOKEN`):

- `BOT_TEST_CHARACTER_ID` → the new `character_id`
- `BOT_TEST_ACCESS_TOKEN` → the `session.access_token` from step 2's login response

If `BOT_TEST_ACCESS_TOKEN` is not present in `.env.bot`, append it. If present, replace the value.

Note: access tokens currently last 24h (Supabase Auth JWT expiry). When it expires, re-run this skill or call `/login` again to refresh.

## Defaults

The `user_character_create` edge function applies these defaults:
- **Credits**: 12,000
- **Ship type**: `sparrow_scout`
- Ship stats (warp power, shields, fighters) from ship definition
- Starting sector: random fedspace sector
- Tutorial quest auto-assigned if enabled
- Max 5 characters per user
