---
name: byoa-deploy-vercel
description: Deploy the BYOA wake-receiver Vercel Function from `deployment/vercel/`. Reads `.env.byoa`, pushes the operator's required env to the Vercel project, deploys via `npx vercel`, health-checks the URL, and prints the `ship_byoa_configure set { source_url }` command to wire the ship at this deployment. Picks up from `/byoa-setup`. Usage `/byoa-deploy-vercel [env]`.
---

# BYOA: deploy Vercel wake function

Picks up where `/byoa-setup` finishes. The operator's ship is already claimed as BYOA, `.env.byoa` is populated with `BYOA_CHARACTER_ID` / `BYOA_SHIP_ID` / `BYOA_WAKE_SECRET`, and the per-ship wake secret is registered server-side. This skill takes the template Vercel Function at [deployment/vercel/](../../../deployment/vercel/) and walks the operator through deploying their own copy.

End state: a Vercel deployment at `https://<their-project>.vercel.app/api/wake` that auths inbound wakes against `BYOA_WAKE_SECRET` and spawns a persistent `@vercel/sandbox` running `uv run byoa` per wake. The skill prints a ready-to-run `ship_byoa_configure set { source_url }` curl so the operator can point their ship at it.

## Parameters

```
/byoa-deploy-vercel [env] [--prod] [--no-link] [--out-url <path>]
```

- **env**: `local` (default), `dev`, or `prod`. Picks the edge env file the skill sources for `SUPABASE_URL` + `EDGE_API_TOKEN` (used only to fill the `ship_byoa_configure` curl printed at the end):
  - `local` → `.env.supabase`
  - `dev` → `.env.cloud.dev`
  - `prod` → `.env.cloud`
- **--prod**: deploy to Vercel production (`vercel deploy --prod`). Default is preview.
- **--no-link**: skip the link verification (steps 3a + 3b). Use only when you're certain `deployment/vercel/.vercel/project.json` is correct.
- **--out-url**: write the final deployment URL to this file (handy for chaining into other tooling). Defaults to stdout only.

## Pre-flight

Stop with a clean error if any of these is true:

- `.env.byoa` does not exist in cwd → direct the operator to run `/byoa-setup` first.
- `.env.byoa` is missing any required key: `BYOA_WAKE_SECRET`, `BYOA_SHIP_ID`, `BYOA_CHARACTER_ID`, `TASK_LLM_PROVIDER`, `TASK_LLM_MODEL`, and the API key matching the provider (one of `ANTHROPIC_API_KEY` / `GOOGLE_API_KEY` / `OPENAI_API_KEY` / `MINIMAX_API_KEY`).
- [deployment/vercel/](../../../deployment/vercel/) does not exist or is missing `api/wake.ts`, `package.json`, or `vercel.json` — the template was deleted or this skill is being run against the wrong checkout.
- `npx vercel --version` errors (Vercel CLI not available via npx).
- The resolved edge env file is missing `SUPABASE_URL` or `EDGE_API_TOKEN`.

Resolve which API key is required from `TASK_LLM_PROVIDER`:

| Provider | Required key |
|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` |
| `google` | `GOOGLE_API_KEY` |
| `openai` | `OPENAI_API_KEY` |
| `minimax` | `MINIMAX_API_KEY` |

If both `BYOA_PROMPT` and `BYOA_PROMPT_FILE` are unset, mention that the agent will run on the base TaskAgent prompt only.

## Steps

### 1. Load envs

```bash
set -a && source .env.byoa && source <edge-env-file> && set +a
```

Source `.env.byoa` first so any keys present in *both* (e.g. `TASK_LLM_*`) take the operator's value, then layer the edge env on top for `SUPABASE_URL` / `EDGE_API_TOKEN`. Never echo `BYOA_WAKE_SECRET` or any `*_API_KEY` to the console.

### 2. Verify Vercel CLI login

```bash
npx vercel whoami
```

If this prints "Not authenticated" (or errors), tell the operator to run `npx vercel login` in their shell and re-run the skill. Do not try to log them in for them.

### 3. Verify (or set up) the Vercel link

The canonical link location is `deployment/vercel/.vercel/project.json`. All subsequent `vercel` commands must be run from `deployment/vercel/` so they pick up the right link.

Skip-able if the link is already in place; otherwise the skill **must stop** until the operator establishes it — `vercel link` is interactive (scope / project name / create-new prompts) and operator-specific. Do not pass `--yes`.

**3a. Check for a misplaced `.vercel/` at the repo root or `deployment/`.**

```bash
ls .vercel/project.json deployment/.vercel/project.json 2>/dev/null
```

If either prints, a previous `vercel link` was run from the wrong cwd. Bail with the exact remediation, pasted ready-to-run, and **stop**:

```bash
# If the existing link is for this BYOA project, move it to the right place:
mkdir -p deployment/vercel
mv deployment/.vercel deployment/vercel/.vercel   # or: mv .vercel deployment/vercel/.vercel

# If the link is for a different project (or you want a fresh start), remove it:
rm -rf .vercel deployment/.vercel
```

Do not auto-move or auto-delete — the operator may have a legitimate `.vercel/` for some other project in the repo. Let them pick.

**3b. Confirm the canonical link exists.**

```bash
ls deployment/vercel/.vercel/project.json 2>/dev/null
```

If present → linked, proceed to step 4.

If missing → **stop** and surface this exactly:

```bash
cd deployment/vercel && npx vercel link
```

Tell the operator: run that in their shell, follow the prompts (suggested project name: `gradient-bang-byoa-<their-handle>`), then re-run `/byoa-deploy-vercel`. The interactive prompts (scope / "link to existing?" / project name) can't be driven from this skill — they must run it themselves.

### 4. Push project env to Vercel

For each key below, push the value from `.env.byoa` to **all three** Vercel environments (production, preview, development). Older `vercel env add` errors on existing keys; use the `rm`-then-`add` pattern for compatibility:

```bash
for env_name in production preview development; do
  (cd deployment/vercel && npx vercel env rm "$KEY" "$env_name" --yes >/dev/null 2>&1 || true)
  (cd deployment/vercel && printf "%s" "$VALUE" | npx vercel env add "$KEY" "$env_name")
done
```

Keys to push (skip any that are unset in `.env.byoa`):

- **Required**: `BYOA_WAKE_SECRET`, `TASK_LLM_PROVIDER`, `TASK_LLM_MODEL`, the resolved `*_API_KEY`.
- **Optional** (push only if set): `BYOA_PROMPT`, `BYOA_PROMPT_FILE`, `TASK_LLM_THINKING_BUDGET`, `BYOA_TOOL_CALL_TIMEOUT_SECONDS`, `BYOA_AGENT_IDLE_TEARDOWN_SECONDS`.

Strip secrets from any error output you surface to the user.

### 5. Deploy

Preview (default):

```bash
(cd deployment/vercel && npx vercel deploy --yes)
```

Prod (`--prod` flag):

```bash
(cd deployment/vercel && npx vercel deploy --prod --yes)
```

The CLI prints the deployment URL on the last line of stdout — capture it (e.g. `https://gradient-bang-byoa-abc123.vercel.app`). On any non-zero exit, surface the CLI's error and stop.

Write the URL to `--out-url` if provided.

### 6. Health-check

The function's `GET /api/wake` returns `{ status: "ok", wake_secret_configured: <bool> }`. Verify both:

```bash
curl -s "${DEPLOY_URL}/api/wake"
```

Required: HTTP 200 with `wake_secret_configured: true`. If `wake_secret_configured` is `false`, the env push in step 4 didn't land — re-run step 4 for `BYOA_WAKE_SECRET` and redeploy.

### 7. Auth smoke-test

Confirm the bearer check rejects unsigned requests:

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST "${DEPLOY_URL}/api/wake" \
  -H "Content-Type: application/json" -d '{}'
```

Expect `401`. Anything else (especially `200`) means bearer auth isn't wired correctly — stop and surface the actual response. Do **not** let the operator point a ship at a function that doesn't enforce bearer auth.

### 8. Print the source_url registration command

The skill never has the operator's user JWT in hand, so don't run `ship_byoa_configure` automatically. Instead, print a ready-to-copy curl with everything except the access token filled in:

```bash
curl -s -X POST "${SUPABASE_URL}/functions/v1/ship_byoa_configure" \
  -H "Content-Type: application/json" \
  -H "X-Edge-Auth: ${EDGE_API_TOKEN}" \
  -H "X-API-Token: <your access token from /login>" \
  -d '{
    "character_id": "'"$BYOA_CHARACTER_ID"'",
    "ship_id": "'"$BYOA_SHIP_ID"'",
    "action": "set",
    "source_url": "'"$DEPLOY_URL"'/api/wake"
  }'
```

Mention: a fresh access token can be minted by re-running the `/login` step from `/byoa-setup` (or simpler — just re-run `/byoa-setup <env> --force --ship-id $BYOA_SHIP_ID` which mints a new wake secret AND lets the operator update `source_url` interactively).

### 9. Report

End with a terse summary:

- Deployment URL (`${DEPLOY_URL}`)
- Wake endpoint (`${DEPLOY_URL}/api/wake`)
- Health-check result (✓ wake_secret_configured, ✓ 401 on unauthed POST)
- Next step: run the `ship_byoa_configure` curl above, then start a task on the ship from the bot — watch Vercel function logs for the first wake (the initial clone + `uv sync` takes 30–60s on cold sandbox).
- Pointer to [docs/byoa-vercel.md](../../../docs/byoa-vercel.md) for troubleshooting.

## Failure modes

- **Missing `.env.byoa`**: run `/byoa-setup` first.
- **`vercel whoami` says not authenticated**: `npx vercel login`, then re-run.
- **`deployment/vercel/.vercel/project.json` missing**: run `cd deployment/vercel && npx vercel link` interactively, then re-run.
- **Stray `.vercel/` at repo root or `deployment/`**: an earlier `vercel link` was run from the wrong cwd. Either `mv` it into `deployment/vercel/.vercel/` or `rm -rf` it and re-link from inside `deployment/vercel/`.
- **`vercel env add` errors with "already exists" even after rm**: older CLI versions buffer; wait a few seconds and retry, or upgrade `vercel`.
- **Health check returns `wake_secret_configured: false`**: env push didn't propagate — re-run step 4 for `BYOA_WAKE_SECRET` and redeploy.
- **POST returns anything but 401 in step 7**: bearer check broken — do not register `source_url`.
- **First wake takes > 60s and times out on Hobby plan**: bump `maxDuration` in `vercel.json` (Hobby caps at 60s; Pro at 800s) or upgrade plan.

## What this skill does NOT do

- Generate the wake secret — that's `/byoa-setup`.
- Mint a user JWT or call `ship_byoa_configure` — prints the curl for the operator to run.
- Edit the wake function code — operators who want custom behavior should fork the template directory.
- Push the operator's `prompt.md` file as a baked-in asset — pass the prompt via `BYOA_PROMPT` (inline ≤ 8 KB) in `.env.byoa`, or commit a `prompt.md` into a fork of `deployment/vercel/` and set `BYOA_PROMPT_FILE=./prompt.md` on the Vercel project env.
