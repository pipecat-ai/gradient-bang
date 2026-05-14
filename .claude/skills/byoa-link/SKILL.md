---
name: byoa-link
description: Onboard a Gradient Bang operator to run a Bring-Your-Own-Agent (BYOA) — logs in with email/password, claims a corp ship as BYOA, generates a per-ship wake secret, and writes `.env.byoa` for the `uv run byoa` CLI. Usage `/byoa-link [env]`.
---

# BYOA link

Walks an operator through everything they need to run `uv run byoa` against a Gradient Bang corp ship. End state: a populated `.env.byoa` in the current directory (mode 0600), a ship claimed as BYOA in `private` mode with a wake secret registered server-side, and clear next-step instructions for the operator.

## Parameters

```
/byoa-link [env] [--force] [--ship-id <uuid>] [--out <path>]
```

- **env**: `prod` (default) or `local`. Picks the game server endpoint:
  - `prod` → `https://api.gradient-bang.com/functions/v1` (operator-facing; no env file needed)
  - `local` → sources `SUPABASE_URL` from `.env.supabase` (`http://127.0.0.1:54321` when `npx supabase start` is running)
- **--force**: overwrite an existing `.env.byoa` without prompting
- **--ship-id**: skip the ship picker; use this corp ship directly
- **--out**: write the env file somewhere other than `./.env.byoa`

The `dev` env was dropped — it required internal-only env files (`.env.cloud.dev`, `EDGE_API_TOKEN`) that operators don't have. Internal team members testing against dev should run `local` with their dev Supabase URL exported in shell.

## Pre-flight

Refuse to proceed if any of these is true. Surface a clean error and stop:

- For `local`: `${SUPABASE_URL}` is unset in `.env.supabase` (or the file is missing entirely).
- The operator already has a `.env.byoa` and `--force` was not passed.
- `SUBAGENT_BUS_DATABASE_URL` is **only** required for the local-dev wake daemon (`byoa --serve`); not for setup. Don't pre-flight it here.

## Auth header cheat-sheet

`/ship_byoa_configure` uses `getAuthenticatedUser()` — same pattern as `verify_token`, `user_character_create`, `reset-password`. JWT-only; no admin token. All BYOA actions (list, claim, clear, set) go through it.

| Endpoint | Scheme | Headers required |
|---|---|---|
| `/login` | public | `Content-Type` only |
| `/ship_byoa_configure` | `getAuthenticatedUser()` | `Authorization: Bearer <user_jwt>` |

## Steps

### 1. Resolve the game server URL

For `prod` (the default):

```bash
SUPABASE_URL=https://api.gradient-bang.com
```

Hardcoded — operator never types it. (If the CNAME proxy isn't live, fall back to the direct Supabase project URL; this URL is public.)

For `local`:

```bash
set -a && source .env.supabase && set +a
# SUPABASE_URL now points at http://127.0.0.1:54321 (or whatever the file has).
```

All curls in steps 2–6 append `/functions/v1/<endpoint>` to `SUPABASE_URL`, so the resolved value must NOT include `/functions/v1`.

`BYOA_WAKE_SECRET` is the **per-ship** bearer that authenticates `wake_agent` → wake-receiver (local daemon or operator's Vercel Function). Generate a fresh random hex string (`openssl rand -hex 32`) **per ship** — never share across ships. The skill writes the value into `.env.byoa` AND sends the same value to us via `ship_byoa_configure { action: 'set', wake_secret }`. We encrypt at rest and never return it to clients.

The bus **channel** is allocated server-side per voice session and injected into the harness env by `wake_agent`. Operators never see or set a channel. The local-dev wake daemon (`uv run byoa --serve`) loads `.env.byoa` first, then falls back to `.env.bot` for `SUBAGENT_BUS_DATABASE_URL` when running from a bot checkout. Standalone operators set it in shell env or add it to `.env.byoa` by hand.

### 2. Log the operator in

Prompt for email + password (unless supplied as positional args):

```bash
curl -s -X POST "${SUPABASE_URL}/functions/v1/login" \
  -H "Content-Type: application/json" \
  -d '{"email": "<email>", "password": "<password>"}'
```

Extract `session.access_token` and the character list (`characters`). On any non-success response (4xx, `success: false`), surface the error and stop.

### 3. Pick the operator's character

If exactly one character → use it. If multiple → list by `name + character_id` (short prefix) and ask the operator to pick.

### 4. List corp ships

```bash
curl -s -X POST "${SUPABASE_URL}/functions/v1/ship_byoa_configure" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <access_token>" \
  -d '{"character_id": "<character_id>", "action": "list"}'
```

Response shape: `{ success, action: "list", ships: [{ ship_id, name, sector, byoa_owner_character_id_prefix, claimable_by_me }, ...] }`. Filter to `claimable_by_me === true`.

If `--ship-id` was passed, validate it appears in this filtered list. Otherwise present (`name` + 8-char `ship_id` prefix + `sector`) and ask the operator to pick.

If the chosen ship is already claimed by the same operator (`byoa_owner_character_id_prefix` matches the operator's character prefix), the claim in step 5 is idempotent — proceed anyway.

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

### 6. Generate + register the per-ship wake secret

Generate a fresh random hex bearer (`openssl rand -hex 32`). The wake secret is a per-ship, operator-side credential. Capture the freshly-generated hex in memory; write it to `.env.byoa` in step 7 AND send the same value to us so wake_agent can sign outbound POSTs to the operator's wake receiver:

```bash
curl -s -X POST "${SUPABASE_URL}/functions/v1/ship_byoa_configure" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <access_token>" \
  -d '{
    "character_id": "<character_id>",
    "ship_id": "<ship_id>",
    "action": "set",
    "wake_secret": "<generated hex>"
  }'
```

Ask the operator whether they want a custom **wake URL** (the URL wake_agent POSTs to):

- **Leave unset** (recommended for local dev): `wake_agent` falls back to `http://host.docker.internal:8765/wake` — the default port for `uv run byoa --serve` running on the host. No further config needed.
- **Set explicitly**: pass `source_url` on the same `set` call (or a follow-up). Required for Vercel/prod deploys (`https://<your-project>.vercel.app/api/wake`) and for local daemons listening on a non-default port.

For production also set `BYOA_WAKE_SECRET=<same hex>` as project env on the operator's Vercel project (where their wake receiver runs).

### 7. Write `.env.byoa`

Path: `--out` value, or `./.env.byoa` if not provided. File mode **0600**.

Use `env.byoa.example` (in the repo root) as the template — it contains every config option the harness and daemon understand, with the optional ones commented out at their defaults. Copy it to the output path, then fill in **only** the three required values at the top. Leave the rest of the template untouched so the operator can later uncomment any tunable in place without consulting docs.

```bash
umask 077
cp env.byoa.example "<out_path>"
python3 - "<out_path>" "<character_id>" "<ship_id>" "<wake_secret_hex>" <<'PY'
import sys, pathlib
path, char_id, ship_id, secret = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
text = pathlib.Path(path).read_text()
text = text.replace("BYOA_CHARACTER_ID=\n", f"BYOA_CHARACTER_ID={char_id}\n", 1)
text = text.replace("BYOA_SHIP_ID=\n", f"BYOA_SHIP_ID={ship_id}\n", 1)
text = text.replace("BYOA_WAKE_SECRET=\n", f"BYOA_WAKE_SECRET={secret}\n", 1)
pathlib.Path(path).write_text(text)
PY
chmod 600 "<out_path>"
```

Only the three required values are filled in; every other option (`BYOA_PROMPT_FILE`, `TASK_LLM_*`, `BYOA_TOOL_CALL_TIMEOUT_SECONDS`, …) stays commented out at its default. `SUBAGENT_BUS_DATABASE_URL` is not in the template — `uv run byoa --serve` picks it up from `.env.bot` via fallback when running from the bot checkout. Standalone operator deploys without a bot checkout need to set it in the shell env or add it to `.env.byoa` by hand.

Verify the file is `0600` and that all three values are populated after writing; surface a warning if not.

### 8. Print next steps

Echo a copy-pasteable summary the operator can act on:

- Where the env file was written.
- Author `./prompt.md` (≤ 8 KB, appended to the base task-agent prompt) and set `BYOA_PROMPT_FILE=./prompt.md` (or inline `BYOA_PROMPT=...`) in `.env.byoa`.
- **Local dev** (env != `prod`): start the local wake daemon (separate terminal):
  ```bash
  uv run byoa --serve
  ```
  The daemon reads `.env.byoa` and waits for wakes from `wake_agent`. As long as the ship has no per-ship `source_url` set, `wake_agent` defaults to `http://host.docker.internal:8765/wake` and routes to the daemon automatically using the per-ship `BYOA_WAKE_SECRET`. Only set `DEFAULT_BYOA_SOURCE_URL` on the edge env to override the default for *all* unconfigured ships.
- **Production** (env = `prod`): run `/byoa-deploy-vercel prod` next. It deploys the template at [deployment/vercel/](../../../deployment/vercel/) to the operator's Vercel project (production by default — preview is SSO-gated), pushes `BYOA_WAKE_SECRET` / `TASK_LLM_*` / the matching `*_API_KEY` from `.env.byoa`, health-checks, then logs the operator in again to auto-register `source_url` via `ship_byoa_configure`. Pass `--access-token <jwt>` to reuse the JWT you just minted here and skip the second login prompt.
- Point at `docs/byoa.md` for full env / config reference.
- Rotate the wake secret by re-running `/byoa-link <env> --force --ship-id <ship>` — this writes a fresh value and updates `ship_byoa_configure` in one shot.

## Failure modes

- **401 from /login**: bad credentials. Don't retry.
- **No characters**: direct to `/character-create` first.
- **No corp ships**: operator isn't in a corp or their corp has no ships.
- **409 ship_busy on claim**: ship is mid-task. Don't auto-retry.
- **403 on claim or set**: caller's JWT is for a different operator (not the ship owner). Stop and re-check which account was logged in.
- **401 "No authorization token provided" / "Invalid or expired token" from /ship_byoa_configure**: the `Authorization: Bearer <jwt>` header is missing or the JWT is expired. Re-run `/login` to mint a fresh one.

## What this skill does NOT do

- Write the operator's custom prompt — their authored content, out of scope.
- Deploy the operator's BYOA agent.
- Modify the bot or edge env files — only reads them.
