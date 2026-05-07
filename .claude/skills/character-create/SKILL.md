---
name: character-create
description: Create a new game character with optional custom ship, credits, onboarding skip, and bulk contract completion. Usage `/character-create [env] <name> <email> <password> [credits <N>] [ship <type>] [skip-onboarding] [complete-contracts]`.
---

# Create Character

Creates a new game character for an authenticated user via the public `user_character_create` edge function, then optionally customizes ship, credits, and onboarding state via direct SQL.

## Parameters

The user specifies the environment and options as arguments. If not provided, default to `local` and ask for any missing required params.

```
/character-create [env] <name> <email> <password> [credits <N>] [ship <ship_type>] [skip-onboarding] [complete-contracts]
```

- **env**: `local` (default) or `dev`
  - `local` → `.env.supabase`
  - `dev` → `.env.cloud.dev`
- **name**: character name (required, 3-20 chars)
- **email**: user email (required)
- **password**: user password (required)
- **credits**: optional, number of starting credits (default: 12000)
- **ship**: optional, ship type as snake_case (default: `sparrow_scout`). Convert display names to snake_case (e.g., "Kestrel Courier" → `kestrel_courier`)
- **skip-onboarding**: optional flag. Backdates `first_visit` so the join endpoint won't flag the character as a first-time player and trigger the in-app onboarding flow. Independent of quests. If absent, ask the user.
- **complete-contracts**: optional flag. Assigns every enabled `quest_definition` to the character and marks all steps + the parent quest as `claimed` (the in-game name for quests is "contracts"). Independent of onboarding — can be combined with `skip-onboarding`. If absent, ask the user.

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

Onboarding is the in-app first-run flow gated by `characters.first_visit`. Skipping it means backdating that timestamp so the join endpoint does not flag `is_first_visit`. This does NOT touch quests/contracts — see 4d for that.

```sql
UPDATE characters SET first_visit = NOW() - INTERVAL '1 day' WHERE character_id = '<character_id>';
```

**Note:** `psql -c "<multi-statement>"` runs the whole string in a single implicit transaction — if any statement fails, the prior ones roll back.

#### 4d. Complete all contracts

For every enabled `quest_definition`, ensure the character has a `player_quests` row, mark every step's `player_quest_steps` row complete + claimed, and set the parent quest to `claimed`. This claims the auto-assigned tutorial quest along with the rest, so it is safe to combine with `skip-onboarding`.

Run this against the character (single psql call):

```sql
WITH ins_quests AS (
  INSERT INTO player_quests (player_id, quest_id, status, current_step_index, started_at, completed_at, claimed_at)
  SELECT '<character_id>', qd.id, 'claimed',
         COALESCE((SELECT MAX(step_index) FROM quest_step_definitions s WHERE s.quest_id = qd.id), 1),
         NOW(), NOW(), NOW()
  FROM quest_definitions qd
  WHERE qd.enabled = true
  ON CONFLICT (player_id, quest_id) DO UPDATE
    SET status = 'claimed', completed_at = NOW(), claimed_at = NOW()
  RETURNING id, quest_id
)
INSERT INTO player_quest_steps (player_quest_id, step_id, current_value, completed_at, reward_claimed_at)
SELECT iq.id, sd.id, sd.target_value, NOW(), NOW()
FROM ins_quests iq
JOIN quest_step_definitions sd ON sd.quest_id = iq.quest_id
ON CONFLICT DO NOTHING;
```

This bypasses the `claim_quest_step_reward` RPC, so any `reward_credits` defined on a step are NOT granted. If the user wants the credit rewards too, sum them up and add to `ship_instances.credits` in the same transaction:

```sql
UPDATE ship_instances SET credits = credits + (
  SELECT COALESCE(SUM(sd.reward_credits), 0)
  FROM quest_step_definitions sd
  JOIN quest_definitions qd ON qd.id = sd.quest_id
  WHERE qd.enabled = true AND sd.reward_credits IS NOT NULL
) WHERE ship_id = '<ship_id>';
```

After running, verify with:
```sql
SELECT pq.status, COUNT(*) FROM player_quests pq WHERE pq.player_id = '<character_id>' GROUP BY pq.status;
SELECT COUNT(*) AS step_rows_claimed FROM player_quest_steps pqs
  JOIN player_quests pq ON pq.id = pqs.player_quest_id
  WHERE pq.player_id = '<character_id>' AND pqs.reward_claimed_at IS NOT NULL;
```

### 5. Report the result

Show the user:
- `character_id`, `name`
- Ship: `ship_id`, `ship_type`, `current_sector`
- Credits (final value after any customization)
- Whether onboarding was skipped
- Whether contracts were bulk-completed (and if so, how many quests + steps were claimed, and the credits granted from step rewards if the user opted in)

### 6. Update .env.bot (optional)

After reporting the result, check if `BOT_TEST_CHARACTER_ID` exists in `.env.bot`. If it does, ask the user if they want to update it to the newly created character ID. If yes, replace the value in `.env.bot`.

## Defaults

The `user_character_create` edge function applies these defaults:
- **Credits**: 12,000
- **Ship type**: `sparrow_scout`
- Ship stats (warp power, shields, fighters) from ship definition
- Starting sector: random fedspace sector
- Tutorial quest auto-assigned if enabled
- Max 5 characters per user
