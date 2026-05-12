---
name: byoa-setup
description: Onboard a Gradient Bang operator to run a Bring-Your-Own-Agent (BYOA) — logs in with email/password, claims a corp ship as BYOA, mints an HS256 BYOA token, and writes `.env.byoa` for the `uv run byoa` CLI. Usage `/byoa-setup [env]`.
---

# BYOA setup

Walks an operator through everything they need to run `uv run byoa` against a Gradient Bang corp ship. End state: a populated `.env.byoa` in the current directory (mode 0600), a ship claimed as BYOA in `private` mode, and clear next-step instructions for the operator.

## Parameters

```
/byoa-setup [env] [--force] [--ship-id <uuid>] [--wake-hook <https://…>] [--out <path>]
```

- **env**: `local` (default), `dev`, or `prod`
  - `local` → `.env.supabase`
  - `dev` → `.env.cloud.dev`
  - `prod` → `.env.cloud`
- **--force**: overwrite an existing `.env.byoa` without prompting
- **--ship-id**: skip the ship picker; use this corp ship directly
- **--wake-hook**: optional HTTPS webhook URL to register on the ship for cold-start wake-up (operators deploying to Vercel Sandbox / Lambda)
- **--out**: write the env file somewhere other than `./.env.byoa`

## Pre-flight

Refuse to proceed if any of these is true. Surface a clean error and stop:

- `${SUBAGENT_BUS_DATABASE_URL}` is unset in the resolved env file (BYOA can't run without a DSN — the operator's bus connection depends on it).
- `${SUBAGENT_BUS_CHANNEL}` is unset (operator's channel must match the bot's value).
- The operator already has a `.env.byoa` and `--force` was not passed.

## Steps

### 1. Source environment variables

```bash
set -a && source <env-file> && set +a
```

Read `${SUPABASE_URL}`, `${SUBAGENT_BUS_DATABASE_URL}`, `${SUBAGENT_BUS_CHANNEL}` from the loaded env. The bot's own `.env.bot` (or `.env.cloud`) is the source of truth for `SUBAGENT_BUS_DATABASE_URL` and `SUBAGENT_BUS_CHANNEL`; operators copy these from there.

### 2. Authenticate the operator

Prompt the operator for their game-account email + password (unless already supplied as positional args).

```bash
curl -s -X POST "${SUPABASE_URL}/functions/v1/login" \
  -H "Content-Type: application/json" \
  -d '{"email": "<email>", "password": "<password>"}'
```

Extract `session.access_token` and the character list (`characters`). On any non-success response (4xx, `success: false`), surface the error and stop — don't proceed to ship claim if auth failed.

### 3. Pick the operator's character

If the operator has exactly one character → use it. If multiple → list them by `name + character_id` (short prefix only) and ask the operator to pick. Cache the chosen `character_id`; it's what the BYOA token will be bound to.

### 4. List corp ships

```bash
curl -s -X POST "${SUPABASE_URL}/functions/v1/my_corporation" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <access_token>" \
  -d '{"character_id": "<character_id>"}'
```

From `corporation.ships`, filter to ships where:
- The operator is a corp member (`my_corporation` already enforces this).
- The ship is NOT already claimed as BYOA by someone else (`byoa` is `null` OR `byoa.owner_character_id_prefix` matches the operator's character_id_prefix).

If `--ship-id` was passed, validate it appears in this filtered list. Otherwise present the list and ask the operator to pick (show ship name + 8-char id prefix + current sector).

If the chosen ship is ALREADY claimed by the same operator, skip the claim step (step 5) and go straight to token mint — `ship_byoa_configure` is idempotent for same-owner re-claims, but skipping avoids the redundant 200.

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

If `--wake-hook` was passed, include `"wake_hook": "<url>"` in the body. HTTPS-only — the edge function rejects non-HTTPS values with 400.

Confirm the response has `byoa_owner_character_id` matching the operator's character_id. A `409 ship_busy` here means the ship has an active task — ask the operator to wait or stop it first; do not retry automatically.

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

The response contains `token` (the plaintext HS256 JWT) — **shown exactly once, never re-fetchable**. Capture it in memory only for the next step (writing the env file); never log it or echo it to the terminal.

If the operator is rotating tokens (re-running this skill on a machine that already has a `.env.byoa`), surface the existing token_id (if discoverable) and remind them to revoke it via `byoa_token_revoke` after they confirm the new one works.

### 7. Write `.env.byoa`

Path: `--out` value, or `./.env.byoa` if not provided. File mode **0600** so the token + DSN don't leak via lax permissions.

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

After writing, verify the file's permissions are `0600` (read+write for owner only). If not, surface a warning.

### 8. Print next steps

Echo a copy-pasteable summary the operator can act on. Include:

- Where the env file was written.
- The exact `uv run byoa` invocation:
  ```bash
  uv run byoa --prompt-file ./prompt.md
  ```
- A note that they need to author `./prompt.md` (operator-supplied system prompt, ≤8 KB). Point at `docs/setup-byoa.md` for the prompt-writing guide.
- If they passed `--wake-hook`: confirm it's registered. If not: tell them how to add one later via `/byoa-setup --ship-id <id> --wake-hook <url>` or directly via `ship_byoa_configure action=set_mode wake_hook=…`.
- Token rotation reminder: 90-day TTL by default; re-run this skill before expiry, then revoke the old token via `byoa_token_revoke`.

## Failure modes to handle cleanly

- **401 from /login**: bad credentials. Don't retry; ask the operator to double-check.
- **No characters in login response**: the user has no game characters yet — direct them to `/character-create` first.
- **No corp ships in `my_corporation`**: the operator isn't in a corporation or their corp has no ships. Direct them to join a corp.
- **409 ship_busy on claim**: ship is mid-task. Ask the operator to wait or `task_cancel` first; don't auto-retry.
- **403 on claim**: the operator isn't a member of the ship's corp. Direct them to join, or ask whether they meant a different ship.
- **byoa_token_mint returns non-200**: surface the body and stop. Don't pretend the env file is valid.

## What this skill does NOT do

- It doesn't write the operator's custom prompt — that's their authored content, deliberately not in scope.
- It doesn't deploy the operator's BYOA agent (Vercel function, etc.).
- It doesn't manage token rotation automatically; operators re-run this skill and revoke the old token themselves.
- It doesn't touch the bot's `.env.bot` or `.env.supabase` — only writes `.env.byoa`.
