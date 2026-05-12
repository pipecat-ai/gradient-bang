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

- **env**: `local` (default), `dev`, or `prod`. Each maps to two files — an **edge** env (for `SUPABASE_URL` + `EDGE_API_TOKEN`) and a **bot** env (for `SUBAGENT_BUS_DATABASE_URL`):
  - `local` → edge `.env.supabase`, bot `.env.bot`
  - `dev` → edge `.env.cloud.dev`, bot `.env.bot.dev`
  - `prod` → edge `.env.cloud`, bot `.env.bot.cloud`
- **--force**: overwrite an existing `.env.byoa` without prompting
- **--ship-id**: skip the ship picker; use this corp ship directly
- **--out**: write the env file somewhere other than `./.env.byoa`

## Pre-flight

Refuse to proceed if any of these is true. Surface a clean error and stop:

- `${SUBAGENT_BUS_DATABASE_URL}` is unset in the resolved **bot** env file.
- `${SUPABASE_URL}` is unset in the resolved **edge** env file (used to build the claim endpoint URL).
- The operator already has a `.env.byoa` and `--force` was not passed.

## Steps

### 1. Source environment variables

Source the edge env first (for `SUPABASE_URL` / `EDGE_API_TOKEN`), then the bot env (for `SUBAGENT_BUS_DATABASE_URL`):

```bash
set -a && source <edge-env-file> && source <bot-env-file> && set +a
```

The bot env is sourced only to **validate** that `SUBAGENT_BUS_DATABASE_URL` exists at runtime — the skill does not copy it into `.env.byoa`. `uv run byoa` loads `.env.byoa` first, then falls back to `.env.bot` for anything missing (see `src/gradientbang/byoa/cli.py`), so the bus URL flows through naturally when running from the bot checkout.

The bus **channel** is no longer part of the operator config either — the bot allocates a per-session channel at task time and the BYOA discovers it via `byoa_session_claim`.

### Auth header cheat-sheet

Two edge-function auth schemes exist in this repo. Using the wrong one returns `admin_token_required` or `No authorization token provided`:

| Endpoint | Scheme | Headers required |
|---|---|---|
| `/login` | none | `Content-Type` only |
| `/my_corporation` | `authenticate()` | `X-Edge-Auth: ${EDGE_API_TOKEN}` **and** `X-API-Token: <user_jwt>` |
| `/ship_byoa_configure` | `authenticate()` | `X-Edge-Auth: ${EDGE_API_TOKEN}` **and** `X-API-Token: <user_jwt>` |
| `/byoa_token_mint` | `getAuthenticatedUser()` | `Authorization: Bearer <user_jwt>` (no `X-Edge-Auth`) |

Do not pass `Authorization: Bearer` to the `authenticate()`-style endpoints — they ignore it. Do not pass `X-Edge-Auth` to `byoa_token_mint` — it only reads `Authorization: Bearer`.

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
  -H "X-Edge-Auth: ${EDGE_API_TOKEN}" \
  -H "X-API-Token: <access_token>" \
  -d '{"character_id": "<character_id>"}'
```

From `corporation.ships`, filter to ships where `byoa` is `null` OR `byoa.owner_character_id_prefix` matches the operator's prefix (i.e. claimable by them).

If `--ship-id` was passed, validate it appears in this filtered list. Otherwise present the list (ship name + 8-char id prefix + sector) and ask the operator to pick.

If the chosen ship is already claimed by the same operator, skip the claim step and go straight to token mint.

### 5. Claim the ship as BYOA

```bash
curl -s -X POST "${SUPABASE_URL}/functions/v1/ship_byoa_configure" \
  -H "Content-Type: application/json" \
  -H "X-Edge-Auth: ${EDGE_API_TOKEN}" \
  -H "X-API-Token: <access_token>" \
  -d '{
    "character_id": "<character_id>",
    "ship_id": "<ship_id>",
    "action": "claim",
    "mode": "private"
  }'
```

Confirm the response has `byoa_owner_character_id` matching the operator's character_id. A `409 ship_busy` means the ship has an active task — ask the operator to wait or stop it; do not auto-retry.

### 6. Mint the BYOA token

Note: this endpoint uses `Authorization: Bearer <jwt>` and does NOT accept `X-Edge-Auth` / `X-API-Token`. See the auth cheat-sheet above.

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
BYOA_CLAIM_ENDPOINT_URL=${SUPABASE_URL}/functions/v1/byoa_session_claim
BYOA_TOKEN=<token from step 6>
BYOA_CHARACTER_ID=<character_id from step 3>
BYOA_SHIP_ID=<ship_id from step 4>
EOF
chmod 600 "<out_path>"
```

`SUBAGENT_BUS_DATABASE_URL` is intentionally omitted — `uv run byoa` picks it up from `.env.bot` via fallback when running from the bot checkout. Standalone operator deploys without a bot checkout need to set it in the shell env or add it to `.env.byoa` by hand.

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
- **`admin_token_required` from /my_corporation or /ship_byoa_configure**: caller forgot the `X-Edge-Auth: ${EDGE_API_TOKEN}` header. Re-check the auth cheat-sheet — do not switch to `Authorization: Bearer`, those endpoints ignore it.
- **`No authorization token provided` from /byoa_token_mint**: caller sent `X-Edge-Auth`/`X-API-Token` instead of `Authorization: Bearer <jwt>`. The mint endpoint uses the Bearer scheme only.
- **byoa_token_mint non-200**: surface the body and stop. Don't pretend the env file is valid.

## What this skill does NOT do

- Write the operator's custom prompt — that's their authored content, deliberately not in scope.
- Deploy the operator's BYOA agent.
- Manage token rotation automatically.
- Modify the bot or edge env files — it only reads them (`.env.bot*`, `.env.supabase`, `.env.cloud*`).
