---
name: byoa-setup
description: Onboard a Gradient Bang operator to run a Bring-Your-Own-Agent (BYOA) — logs in with email/password, claims a corp ship as BYOA, generates a per-ship wake secret, and writes `.env.byoa` for the `uv run byoa` CLI. Usage `/byoa-setup [env]`.
---

# BYOA setup

Walks an operator through everything they need to run `uv run byoa` against a Gradient Bang corp ship. End state: a populated `.env.byoa` in the current directory (mode 0600), a ship claimed as BYOA in `private` mode with a wake secret registered server-side, and clear next-step instructions for the operator.

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
- `${SUPABASE_URL}` is unset in the resolved **edge** env file.
- The operator already has a `.env.byoa` and `--force` was not passed.

## Auth header cheat-sheet

| Endpoint | Scheme | Headers required |
|---|---|---|
| `/login` | none | `Content-Type` only |
| `/my_corporation` | `authenticate()` | `X-Edge-Auth: ${EDGE_API_TOKEN}` **and** `X-API-Token: <user_jwt>` |
| `/ship_byoa_configure` | `authenticate()` | `X-Edge-Auth: ${EDGE_API_TOKEN}` **and** `X-API-Token: <user_jwt>` |

## Steps

### 1. Source environment variables

Source the edge env first (for `SUPABASE_URL` / `EDGE_API_TOKEN`), then the bot env (for `SUBAGENT_BUS_DATABASE_URL`):

```bash
set -a && source <edge-env-file> && source <bot-env-file> && set +a
```

The bot env is sourced only to validate that `SUBAGENT_BUS_DATABASE_URL` exists at runtime. The local-dev wake daemon (`uv run byoa --serve`) loads `.env.byoa` first, then falls back to `.env.bot` for anything missing. The single-session harness (`uv run byoa`, spawned by the daemon per wake) reads only `os.environ` — values arrive via the spawned-child env.

The bus **channel** is allocated server-side per voice session and injected into the harness env by `wake_agent`. Operators never see or set a channel.

`BYOA_WAKE_SECRET` is the **per-ship** bearer that authenticates `wake_agent` → wake-receiver (local daemon or operator's Vercel Function). Generate a fresh random hex string (`openssl rand -hex 32`) **per ship** — never share across ships, never reuse `EDGE_API_TOKEN` (privileged trusted-caller auth, must never leave our infra). The skill writes the value into `.env.byoa` AND sends the same value to us via `ship_byoa_configure { action: 'set', wake_secret }`. We encrypt at rest and never return it to clients.

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
curl -s -X POST "${SUPABASE_URL}/functions/v1/my_corporation" \
  -H "Content-Type: application/json" \
  -H "X-Edge-Auth: ${EDGE_API_TOKEN}" \
  -H "X-API-Token: <access_token>" \
  -d '{"character_id": "<character_id>"}'
```

From `corporation.ships`, filter to ships where `byoa` is `null` OR `byoa.owner_character_id_prefix` matches the operator's prefix.

If `--ship-id` was passed, validate it appears in this filtered list. Otherwise list (ship name + 8-char id prefix + sector) and ask the operator to pick.

If the chosen ship is already claimed by the same operator, skip the claim and go to step 6.

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

### 6. Generate + register the per-ship wake secret

Generate a fresh random hex bearer (`openssl rand -hex 32`). **Never reuse `EDGE_API_TOKEN`** — that's privileged trusted-caller auth for our edge functions and must not leave our infra; the wake secret is a per-ship, operator-side credential. Capture the freshly-generated hex in memory; write it to `.env.byoa` in step 7 AND send the same value to us so wake_agent can sign outbound POSTs to the operator's wake receiver:

```bash
curl -s -X POST "${SUPABASE_URL}/functions/v1/ship_byoa_configure" \
  -H "Content-Type: application/json" \
  -H "X-Edge-Auth: ${EDGE_API_TOKEN}" \
  -H "X-API-Token: <access_token>" \
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
- **Production** (env = `prod`): run `/byoa-deploy-vercel prod --prod` next. It deploys the template at [deployment/vercel-function/](../../../deployment/vercel-function/) to the operator's Vercel project, pushes `BYOA_WAKE_SECRET` / `TASK_LLM_*` / the matching `*_API_KEY` from `.env.byoa`, health-checks, and prints the `ship_byoa_configure set { source_url }` curl to point this ship at the deployment.
- Point at `docs/byoa.md` for full env / config reference.
- Rotate the wake secret by re-running `/byoa-setup <env> --force --ship-id <ship>` — this writes a fresh value and updates `ship_byoa_configure` in one shot.

## Failure modes

- **401 from /login**: bad credentials. Don't retry.
- **No characters**: direct to `/character-create` first.
- **No corp ships**: operator isn't in a corp or their corp has no ships.
- **409 ship_busy on claim**: ship is mid-task. Don't auto-retry.
- **403 on claim**: not a member of the ship's corp.
- **`admin_token_required` from /my_corporation or /ship_byoa_configure**: caller forgot the `X-Edge-Auth: ${EDGE_API_TOKEN}` header.

## What this skill does NOT do

- Write the operator's custom prompt — their authored content, out of scope.
- Deploy the operator's BYOA agent.
- Modify the bot or edge env files — only reads them.
