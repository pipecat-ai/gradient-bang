# Create Character

Creates a new game character for an authenticated user via the public `user_character_create` edge function.

## Parameters

IMPORTANT: Always ask the user for ALL of these before proceeding. Do NOT assume defaults or use values from CLAUDE.md.

- **Email**: user email (required)
- **Password**: user password (required)
- **Name**: character name (required, 3-20 chars, alphanumeric/underscores/spaces)

## Steps

### 1. Ask the user

Use AskUserQuestion to ask the user for their email, password, and character name. Do not proceed until you have all three values.

### 2. Source environment variables

```bash
set -a && source .env.supabase && set +a
```

### 3. Login and obtain access token

Call the `login` edge function to authenticate and get an access token.

```bash
curl -s -X POST "${SUPABASE_URL}/functions/v1/login" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "<email>",
    "password": "<password>"
  }'
```

Extract the `session.access_token` from the response. If login fails, report the error and stop.

### 4. Create the character

Call the `user_character_create` edge function using the access token from step 2.

```bash
curl -s -X POST "${SUPABASE_URL}/functions/v1/user_character_create" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <access_token>" \
  -d '{
    "name": "<character_name>"
  }'
```

### 5. Report the result

Show the user the `character_id`, `name`, `ship.ship_id`, `ship.ship_type`, `ship.current_sector`, and `ship.credits` from the response.

### 6. Update .env.bot (optional)

After reporting the result, check if `BOT_TEST_CHARACTER_ID` exists in `.env.bot`. If it does, ask the user if they want to update it to the newly created character ID. If yes, replace the value in `.env.bot`.

## Defaults

The edge function applies these defaults:
- **Credits**: 12000
- **Ship type**: `kestrel_courier`
- Ship stats (warp power, shields, fighters) from ship definition
- Starting sector: random fedspace sector
- Tutorial quest auto-assigned if enabled
- Max 5 characters per user
