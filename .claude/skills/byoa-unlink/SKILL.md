---
name: byoa-unlink
description: Release a Gradient Bang corp ship from BYOA — logs in with email/password (or reuses a JWT) and calls `ship_byoa_configure { action: "clear" }` to null the ship's `byoa_owner_character_id` server-side, freeing the ship for someone else to claim. Inverse of `/byoa-link`. Usage `/byoa-unlink [env]`.
---

# BYOA unlink

Releases a corp ship that was claimed via `/byoa-link`. The server-side `clear` action nulls `byoa_owner_character_id` and resets `byoa_mode` to `private`; the ship goes back into the pool for any corp member to claim. Owner-only, idempotent (re-running on an already-cleared ship returns success without error).

This skill does **not** delete `.env.byoa`, tear down the operator's local daemon, or unprovision the Vercel deployment — those are the operator's own infrastructure to keep or discard. Pass `--clear-env` to also remove `.env.byoa` from the current directory.

## Parameters

```
/byoa-unlink [env] [--ship-id <uuid>] [--character-id <uuid>] [--access-token <jwt>] [--clear-env]
```

- **env**: `prod` (default) or `local`. Picks the game server endpoint:
  - `prod` → `https://api.gradient-bang.com`
  - `local` → sources `SUPABASE_URL` from `.env.supabase`
- **--ship-id**: ship UUID to release. Defaults to `BYOA_SHIP_ID` in `.env.byoa`.
- **--character-id**: caller's character UUID. Defaults to `BYOA_CHARACTER_ID` in `.env.byoa`. Must be the current BYOA owner (server returns 403 otherwise).
- **--access-token**: reuse an existing user JWT instead of prompting for email/password. Token must belong to the same operator who owns the ship.
- **--clear-env**: after a successful unlink, delete `.env.byoa`. Off by default — keep the file if you intend to re-`/byoa-link` the same ship soon (you'll just need a fresh wake secret on re-link anyway, but the IDs are reusable).

## Pre-flight

Stop with a clean error if any of these is true:

- Both `.env.byoa` is missing AND `--ship-id` was not provided. There's nothing to unlink.
- `--ship-id` provided but no `--character-id` AND `.env.byoa` doesn't have one — the server needs to know which character is making the call.
- For `env=local`: `.env.supabase` is missing or `SUPABASE_URL` is unset inside it.

## Steps

### 1. Resolve env + IDs

```bash
# Load .env.byoa if present
[ -f .env.byoa ] && set -a && source .env.byoa && set +a

# Resolve SUPABASE_URL
case "${ENV_ARG:-prod}" in
  prod)  SUPABASE_URL=https://api.gradient-bang.com ;;
  local) set -a && source .env.supabase && set +a ;;
esac

SHIP_ID="${ARG_SHIP_ID:-$BYOA_SHIP_ID}"
CHARACTER_ID="${ARG_CHARACTER_ID:-$BYOA_CHARACTER_ID}"
```

Surface the resolved ship + character IDs (8-char prefixes) to the operator before proceeding so they can catch a wrong-account mistake before the POST.

### 2. Get a user JWT

If `--access-token` was passed, use it directly. Otherwise prompt for email + password:

```bash
LOGIN_RESPONSE=$(curl -s -X POST "${SUPABASE_URL}/functions/v1/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\": \"$EMAIL\", \"password\": \"$PASSWORD\"}")
ACCESS_TOKEN=$(echo "$LOGIN_RESPONSE" | grep -o '"access_token":"[^"]*"' | head -1 | cut -d'"' -f4)
```

On 401 / `success: false`: don't retry. Surface the response body and stop. Never echo `$PASSWORD` or `$ACCESS_TOKEN` to chat.

### 3. POST clear

```bash
curl -s -X POST "${SUPABASE_URL}/functions/v1/ship_byoa_configure" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -d "{
    \"character_id\": \"$CHARACTER_ID\",
    \"ship_id\": \"$SHIP_ID\",
    \"action\": \"clear\"
  }"
```

Expected success: `{"success":true,"ship_id":"...","byoa_owner_character_id":null,"byoa_mode":"private","changed":true}`. The `changed: false` variant is also success — it means the ship was already cleared (idempotent).

### 4. (Optional) Remove `.env.byoa`

Only if `--clear-env` was passed:

```bash
[ -f .env.byoa ] && rm -f .env.byoa && echo "removed .env.byoa"
```

Don't touch other operator-owned state (`.env.supabase`, the Vercel project, the local wake daemon, etc.) — out of scope.

### 5. Report

Print a terse summary:

- Ship released: `<ship_id>` (8-char prefix)
- Mode reset to `private`, owner null
- `.env.byoa`: kept / removed (per `--clear-env`)
- Next steps: any corp member can now claim this ship via `/byoa-link <env> --ship-id <ship_id>`. Operator-side cleanup (`vercel project rm`, killing `byoa --serve`, etc.) is the operator's call.

## Failure modes

- **`.env.byoa` missing AND no `--ship-id`**: nothing to unlink — point operator at `/byoa-link` to claim a ship first, or supply `--ship-id`.
- **403 `Only the current BYOA owner can clear BYOA`**: the JWT belongs to a different operator. Either log in as the right account, supply `--access-token` from the right account, or have a corp admin override at the DB level.
- **403 `Only corp members can configure BYOA on this ship`**: the caller isn't in the ship's corp. Same remediation as above.
- **404 `ship_not_found`**: bad `--ship-id`. Confirm it matches what `/byoa-link list` showed.
- **409 `ship_busy`**: the ship has an active task in flight. The server refuses to flip ownership mid-task to avoid task-attribution ambiguity. Wait for the task to finish (or cancel it from the bot side), then re-run.
- **401 from `/login`**: bad credentials. Don't retry; surface the body and stop.
- **`changed: false` in the success response**: ship was already unowned. Treat as success — the operator might have previously cleared it manually or via a separate session.

## What this skill does NOT do

- Tear down operator-owned infrastructure (Vercel deployment, local `byoa --serve` daemon, ngrok tunnel, etc.). The skill releases the database link only; the operator decides whether to keep their wake receiver standing for a future re-claim.
- Rotate or revoke the per-ship `wake_secret` server-side beyond what `clear` does. (`clear` zeroes ownership; whether `wake_secret` / `source_url` rows are nulled by a server-side trigger is a server concern — re-running `/byoa-link --force` on a fresh claim writes a new secret regardless.)
- Touch `.env.bot`, `.env.supabase`, or any other env file. Only `.env.byoa` is in scope, and only when `--clear-env` is passed.
- Notify other corp members that the ship is now claimable. The ship just appears as `claimable_by_me: true` on their next `/byoa-link list` call.
