---
name: byoa-setup
description: Onboard a Gradient Bang operator to run a Bring-Your-Own-Agent (BYOA) — logs in with email/password, claims a corp ship as BYOA, mints an HS256 BYOA token, and writes `.env.byoa` for the `uv run byoa` CLI. Usage `/byoa-setup [env]`.
---

# BYOA setup

Walks an operator through everything they need to run `uv run byoa` against a Gradient Bang corp ship. End state: a populated `.env.byoa` in the current directory (mode 0600), a ship claimed as BYOA in `private` mode, and clear next-step instructions for the operator.

## Parameters

```
/byoa-setup [env] [--force] [--ship-id <uuid>] [--out <path>]
```

- **env**: `local` (default), `dev`, or `prod`
  - `local` → `.env.supabase`
  - `dev` → `.env.cloud.dev`
  - `prod` → `.env.cloud`
- **--force**: overwrite an existing `.env.byoa` without prompting
- **--ship-id**: skip the ship picker; use this corp ship directly
- **--out**: write the env file somewhere other than `./.env.byoa`

## Pre-flight

Refuse to proceed if any of these is true. Surface a clean error and stop:

- `${SUBAGENT_BUS_DATABASE_URL}` is unset in the resolved env file.
- `${SUBAGENT_BUS_CHANNEL}` is unset (operator's channel must match the bot's value).
- The operator already has a `.env.byoa` and `--force` was not passed.

## Steps

### 1. Source environment variables

```bash
set -a && source <env-file> && set +a
```

Read `${SUPABASE_URL}`, `${SUBAGENT_BUS_DATABASE_URL}`, `${SUBAGENT_BUS_CHANNEL}` from the loaded env. The bot's own `.env.bot` (or `.env.cloud`) is the source of truth for `SUBAGENT_BUS_DATABASE_URL` and `SUBAGENT_BUS_CHANNEL`; operators copy these from there.

### 2. Authenticate the operator

Prompt for email + password (unless supplied as positional args):

```bash
curl -s -X POST "${SUPABASE_URL}/functions/v1/login" \
  -H "Content-Type: application/json" \
  -d '{"email": "<email>", "password": "<password>"}'
```

Extract `session.access_token` and the character list (`characters`). On any non-success response (4xx, `success: false`), surface the error and stop.

### 3. Pick the operator's character

If exactly one character → use it. If multiple → list by `name + character_id` (short prefix) and ask the operator to pick. Cache the chosen `character_id`; the BYOA token will be bound to it.

### 4. List corp ships

```bash
curl -s -X POST "${SUPABASE_URL}/functions/v1/my_corporation" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <access_token>" \
  -d '{"character_id": "<character_id>"}'
```

From `corporation.ships`, filter to ships where `byoa` is `null` OR `byoa.owner_character_id_prefix` matches the operator's prefix (i.e. claimable by them).

If `--ship-id` was passed, validate it appears in this filtered list. Otherwise present the list (ship name + 8-char id prefix + sector) and ask the operator to pick.

If the chosen ship is already claimed by the same operator, skip the claim step and go straight to token mint.

### 5. Claim the ship as BYOA

```bash
curl -s -X POST "${SUPABASE_URL}/functions/v1/ship_byoa_configure" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <access_token>" \
  -d '{
    "character_id": "<character_id>",
    "ship_id": "<ship_id>",
    "action": "claim",
    "mode": "private"
  }'
```

Confirm the response has `byoa_owner_character_id` matching the operator's character_id. A `409 ship_busy` means the ship has an active task — ask the operator to wait or stop it; do not auto-retry.

### 6. Mint the BYOA token

```bash
curl -s -X POST "${SUPABASE_URL}/functions/v1/byoa_token_mint" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <access_token>" \
  -d '{
    "character_id": "<character_id>",
    "label": "byoa-setup <hostname> <ISO date>",
    "ttl_days": 90
  }'
```

The response contains `token` (the plaintext HS256 JWT) — **shown exactly once, never re-fetchable**. Capture in memory only for step 7; never log or echo it to the terminal.

If rotating tokens, remind the operator to revoke the old one via `byoa_token_revoke` after the new one works.

### 7. Write `.env.byoa`

Path: `--out` value, or `./.env.byoa` if not provided. File mode **0600**.

```bash
umask 077
cat > "<out_path>" <<EOF
# Written by /byoa-setup on $(date -Iseconds)
SUBAGENT_BUS_TRANSPORT=byoa_pgmq
SUBAGENT_BUS_DATABASE_URL=${SUBAGENT_BUS_DATABASE_URL}
SUBAGENT_BUS_CHANNEL=${SUBAGENT_BUS_CHANNEL}
BYOA_TOKEN=<token from step 6>
BYOA_CHARACTER_ID=<character_id from step 3>
BYOA_SHIP_ID=<ship_id from step 4>
EOF
chmod 600 "<out_path>"
```

Verify the file is `0600` after writing; surface a warning if not.

### 8. Print next steps

Echo a copy-pasteable summary the operator can act on:

- Where the env file was written.
- The exact `uv run byoa` invocation:
  ```bash
  uv run byoa --prompt-file ./prompt.md
  ```
- They need to author `./prompt.md` (≤ 8 KB, appended to the base task-agent prompt). Point at `docs/setup-byoa.md`.
- Token rotation: 90-day TTL by default; re-run this skill before expiry, then revoke the old token via `byoa_token_revoke`.

## Failure modes

- **401 from /login**: bad credentials. Don't retry.
- **No characters**: direct to `/character-create` first.
- **No corp ships**: operator isn't in a corp or their corp has no ships.
- **409 ship_busy on claim**: ship is mid-task. Don't auto-retry.
- **403 on claim**: not a member of the ship's corp.
- **byoa_token_mint non-200**: surface the body and stop. Don't pretend the env file is valid.

## What this skill does NOT do

- Write the operator's custom prompt — that's their authored content, deliberately not in scope.
- Deploy the operator's BYOA agent.
- Manage token rotation automatically.
- Touch the bot's `.env.bot` or `.env.supabase`.
