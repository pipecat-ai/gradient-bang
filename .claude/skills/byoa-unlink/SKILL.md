---
name: byoa-unlink
description: Release a Gradient Bang corp ship from BYOA — logs in with email/password (or reuses a JWT), nulls the ship's stored `source_url` and `wake_secret` via `ship_byoa_configure { action: "set" }`, then calls `{ action: "clear" }` to null `byoa_owner_character_id`. Frees the ship completely for someone else to claim. Inverse of `/byoa-link`. Usage `/byoa-unlink [env]`.
---

# BYOA unlink

Releases a corp ship that was claimed via `/byoa-link`, in two server calls:

1. `set` with `{ wake_secret: null, source_url: null }` — wipes the per-ship wake config while we still own the ship (the `set` action is owner-only).
2. `clear` — nulls `byoa_owner_character_id` and resets `byoa_mode` to `private`.

After both succeed the ship has no owner, no `source_url`, and no `wake_secret`, and goes back into the pool for any corp member to claim. Idempotent (re-running on an already-cleared ship returns success without error — the `set` call is skipped automatically).

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

### 3a. POST set (null wake config)

Wipe the stored `source_url` and `wake_secret` while we still own the ship. The `set` action is owner-only, so this must run before `clear`.

```bash
SET_RESPONSE=$(curl -s -X POST "${SUPABASE_URL}/functions/v1/ship_byoa_configure" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -d "{
    \"character_id\": \"$CHARACTER_ID\",
    \"ship_id\": \"$SHIP_ID\",
    \"action\": \"set\",
    \"wake_secret\": null,
    \"source_url\": null
  }")
```

Expected success: `{"success":true,"action":"set","wake_secret_updated":true,"source_url_updated":true,...}`.

If the response is `403 Only the current BYOA owner can set wake config`, the ship is already unowned (or owned by someone else) — skip to step 3b, which will either succeed idempotently or surface the real ownership mismatch with its own 403. Don't treat this 403 as fatal here.

For any other non-2xx (500, network error, etc.): surface the body and stop. Don't proceed to `clear` if the wipe genuinely failed — leaving a stale `source_url` / `wake_secret` on an unowned ship is the failure mode this whole change is meant to prevent.

### 3b. POST clear (release ownership)

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
- `source_url`: cleared (or "skipped — ship already unowned" if step 3a was bypassed)
- `wake_secret`: cleared (or "skipped — ship already unowned")
- `.env.byoa`: kept / removed (per `--clear-env`)
- Next steps: any corp member can now claim this ship via `/byoa-link <env> --ship-id <ship_id>`. Operator-side cleanup (`vercel project rm`, killing `byoa --serve`, etc.) is the operator's call.

## Failure modes

- **`.env.byoa` missing AND no `--ship-id`**: nothing to unlink — point operator at `/byoa-link` to claim a ship first, or supply `--ship-id`.
- **403 `Only the current BYOA owner can set wake config`** (on step 3a): expected when the ship is already unowned. The skill falls through to `clear` automatically. If `clear` then also 403s with "Only the current BYOA owner can clear BYOA", the ship is genuinely owned by someone else — see below.
- **403 `Only the current BYOA owner can clear BYOA`**: the JWT belongs to a different operator. Either log in as the right account, supply `--access-token` from the right account, or have a corp admin override at the DB level.
- **403 `Only corp members can configure BYOA on this ship`**: the caller isn't in the ship's corp. Same remediation as above.
- **404 `ship_not_found`**: bad `--ship-id`. Confirm it matches what `/byoa-link list` showed.
- **409 `ship_busy`**: the ship has an active task in flight. The server refuses to flip ownership mid-task to avoid task-attribution ambiguity. Wait for the task to finish (or cancel it from the bot side), then re-run.
- **401 from `/login`**: bad credentials. Don't retry; surface the body and stop.
- **`changed: false` in the success response**: ship was already unowned. Treat as success — the operator might have previously cleared it manually or via a separate session.

## What this skill does NOT do

- Tear down operator-owned infrastructure (Vercel deployment, local `byoa --serve` daemon, ngrok tunnel, etc.). The skill releases the database link and wipes the server-side wake config; the operator decides whether to keep their wake receiver standing for a future re-claim.
- Touch `.env.bot`, `.env.supabase`, or any other env file. Only `.env.byoa` is in scope, and only when `--clear-env` is passed.
- Notify other corp members that the ship is now claimable. The ship just appears as `claimable_by_me: true` on their next `/byoa-link list` call.
