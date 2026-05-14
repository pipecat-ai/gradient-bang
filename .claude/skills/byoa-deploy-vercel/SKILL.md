---
name: byoa-deploy-vercel
description: Deploy the BYOA wake-receiver Vercel Function from `deployment/vercel/`. Reads `.env.byoa`, pushes the operator's required env to the Vercel project, deploys via `npx vercel`, health-checks the URL, logs the operator in, and registers the resulting alias as the ship's `source_url` via `ship_byoa_configure`. Picks up from `/byoa-setup` (which claims the ship and writes `.env.byoa`). Usage `/byoa-deploy-vercel [env]`.
---

# BYOA: deploy Vercel wake function

Picks up where `/byoa-setup` finishes. The operator's ship is already claimed as BYOA, `.env.byoa` is populated with `BYOA_CHARACTER_ID` / `BYOA_SHIP_ID` / `BYOA_WAKE_SECRET`, and the per-ship wake secret is registered server-side. This skill takes the template Vercel Function at [deployment/vercel/](../../../deployment/vercel/) and walks the operator through deploying their own copy.

End state: a Vercel deployment at `https://<their-project>.vercel.app/api/wake` that auths inbound wakes against `BYOA_WAKE_SECRET` and spawns a persistent `@vercel/sandbox` running `uv run byoa` per wake. The skill prints a ready-to-run `ship_byoa_configure set { source_url }` curl so the operator can point their ship at it.

## Parameters

```
/byoa-deploy-vercel [env] [--preview] [--no-link] [--out-url <path>] [--access-token <jwt>] [--skip-register]
```

- **env**: `prod` (default) or `local`. Picks the game server endpoint that `/login` + `/ship_byoa_configure` are called against (the auto-register step at the end):
  - `prod` → `https://api.gradient-bang.com` (hardcoded; operator never types it; no env file needed)
  - `local` → sources `SUPABASE_URL` from `.env.supabase` (e.g. `http://127.0.0.1:54321` when `npx supabase start` is running)

  The `dev` env was dropped — it required internal-only env files that external developers don't have. The skill no longer needs `EDGE_API_TOKEN` either; `ship_byoa_configure` and `my_corporation` authenticate on the user JWT alone via the standard `getAuthenticatedUser()` pattern (`Authorization: Bearer <jwt>`).
- **--preview**: deploy as a Vercel preview instead of production. **Almost never what you want for BYOA**: Vercel's default Standard Protection gates preview URLs behind SSO, so the game server can't reach them. Use only if you've disabled Project Protection or are testing with a bypass token.
- **--no-link**: skip the link verification (steps 3a + 3b). Use only when you're certain `deployment/vercel/.vercel/project.json` is correct.
- **--out-url**: write the final canonical (alias) URL to this file. Defaults to stdout only.
- **--access-token <jwt>**: skip the email+password prompt in step 8 by reusing an existing user JWT (e.g. one just minted by `/byoa-setup`). Token must be valid for the same operator who owns the ship.
- **--skip-register**: stop after the health-check; don't auto-register `source_url`. Falls back to printing a manual curl. Use when the operator wants to inspect the deployment first or doesn't have credentials handy.

**Default deploy target is production.** The BYOA wake endpoint must be publicly reachable by the game server, and only the production alias (`<projectName>.vercel.app`) is exempt from Vercel's Standard Protection. Per-deploy URLs (`<projectName>-<hash>-<team>.vercel.app`) are SSO-gated regardless of target.

**Tested with Vercel CLI 54.x.**

**Game tool calls route through the bus, not direct HTTP.** The BYOA harness running in the Vercel sandbox never calls the game server directly — it publishes `BusGameToolCallRequest` messages onto the Postgres bus, and the bot-side VoiceAgent broker forwards them to Supabase using the bot's own `SUPABASE_URL`. wake_agent's injected env (`BYOA_BUS_DATABASE_URL`, `BYOA_CHANNEL`, `BYOA_SHIP_ID`, `BYOA_CHARACTER_ID`, `BYOA_TASK_ID`, `BYOA_WAKE_REQUEST_ID`) contains no game-server URL on purpose. Practical implication: for local-stack testing against a Vercel-deployed receiver, **only the Postgres bus needs to be publicly reachable** (e.g. via `ngrok tcp 54322` + `BYOA_BUS_DATABASE_URL` set in `.env.supabase`). No second tunnel for the game server is required. See `voice_agent.py` `_on_game_tool_call_request` for the broker side.

## Pre-flight

Stop with a clean error if any of these is true:

- `.env.byoa` does not exist in cwd → direct the operator to run `/byoa-setup` first.
- `.env.byoa` is missing any required key: `BYOA_WAKE_SECRET`, `BYOA_SHIP_ID`, `BYOA_CHARACTER_ID`, `TASK_LLM_PROVIDER`, `TASK_LLM_MODEL`, and the API key matching the provider (one of `ANTHROPIC_API_KEY` / `GOOGLE_API_KEY` / `OPENAI_API_KEY` / `MINIMAX_API_KEY`).
- [deployment/vercel/](../../../deployment/vercel/) does not exist or is missing `api/wake.ts`, `package.json`, or `vercel.json` — the template was deleted or this skill is being run against the wrong checkout.
- `npx vercel --version` errors (Vercel CLI not available via npx).
- For `env=local`: `.env.supabase` is missing or `SUPABASE_URL` is unset inside it.

Resolve which API key is required from `TASK_LLM_PROVIDER`:

| Provider | Required key |
|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` |
| `google` | `GOOGLE_API_KEY` |
| `openai` | `OPENAI_API_KEY` |
| `minimax` | `MINIMAX_API_KEY` |

If both `BYOA_PROMPT` and `BYOA_PROMPT_FILE` are unset, mention that the agent will fall back to the bundled default prompt at [deployment/vercel/prompt.md](../../../deployment/vercel/prompt.md) (auto-loaded by `wake.ts` on every wake — operators can edit it pre-deploy, fork the deploy template, or override via `BYOA_PROMPT` / `BYOA_PROMPT_FILE` on the Vercel project env).

## Steps

### 1. Load envs

```bash
set -a && source .env.byoa && set +a
```

Then resolve `SUPABASE_URL` per the env arg:

```bash
# prod (default)
SUPABASE_URL=https://api.gradient-bang.com

# local
set -a && source .env.supabase && set +a
# SUPABASE_URL now points at http://127.0.0.1:54321 (or whatever the file has)
```

All curls in step 8 append `/functions/v1/<endpoint>`, so `SUPABASE_URL` must NOT include `/functions/v1`. Never echo `BYOA_WAKE_SECRET` or any `*_API_KEY` to the console.

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

Push the values from `.env.byoa` to the **production** Vercel environment only. The wake function is invoked through the production alias (`<projectName>.vercel.app`) and preview/development environments are never reached by the game server, so syncing env vars to them is pure noise. Use the `rm`-then-`add` pattern so re-runs are idempotent.

All `vercel` invocations use `--cwd deployment/vercel` instead of `cd deployment/vercel && ...` — that way the snippet runs the same whether or not the caller wraps it in a subshell, and accidental cwd drift can't bleed into later steps. **Keep `--cwd` if you edit these commands** — chained `cd` patterns silently move the Bash-tool cwd and break later steps (the operator-side curl in step 8 tries to source `.env.supabase` from the repo root).

First resolve the LLM-provider API key name + value from `TASK_LLM_PROVIDER` in one shot (resolving both here avoids `${!VAR}` indirect expansion, which works in bash but not zsh — and zsh is the default macOS shell):

```bash
case "$TASK_LLM_PROVIDER" in
  anthropic) API_KEY_NAME=ANTHROPIC_API_KEY; API_KEY_VALUE="$ANTHROPIC_API_KEY" ;;
  google)    API_KEY_NAME=GOOGLE_API_KEY;    API_KEY_VALUE="$GOOGLE_API_KEY"    ;;
  openai)    API_KEY_NAME=OPENAI_API_KEY;    API_KEY_VALUE="$OPENAI_API_KEY"    ;;
  minimax)   API_KEY_NAME=MINIMAX_API_KEY;   API_KEY_VALUE="$MINIMAX_API_KEY"   ;;
  *) echo "Unknown TASK_LLM_PROVIDER=$TASK_LLM_PROVIDER"; exit 1 ;;
esac
```

Then push every key to production. The function reads named globals (`KEY` / `VAL`) instead of positional bash args — the slash-command loader substitutes literal positional refs (dollar-N) inside fenced code blocks with the skill's command-line args, which silently corrupts shell snippets. Don't use bash positional parameters in skill snippets — use named env vars on the call line instead, as below:

```bash
push_env() {
  [ -z "$VAL" ] && return
  npx vercel --cwd deployment/vercel env rm "$KEY" production --yes >/dev/null 2>&1 || true
  if npx vercel --cwd deployment/vercel env add "$KEY" production --value "$VAL" --yes >/dev/null 2>&1; then
    echo "  ✓ $KEY → production"
  else
    echo "  ✗ $KEY → production FAILED"
  fi
}

# Required
KEY=BYOA_WAKE_SECRET   VAL="$BYOA_WAKE_SECRET"   push_env
KEY=TASK_LLM_PROVIDER  VAL="$TASK_LLM_PROVIDER"  push_env
KEY=TASK_LLM_MODEL     VAL="$TASK_LLM_MODEL"     push_env
KEY="$API_KEY_NAME"    VAL="$API_KEY_VALUE"      push_env

# Optional — only push when set
[ -n "$BYOA_PROMPT" ]                       && KEY=BYOA_PROMPT                      VAL="$BYOA_PROMPT"                      push_env
[ -n "$BYOA_PROMPT_FILE" ]                  && KEY=BYOA_PROMPT_FILE                 VAL="$BYOA_PROMPT_FILE"                 push_env
[ -n "$TASK_LLM_THINKING_BUDGET" ]          && KEY=TASK_LLM_THINKING_BUDGET         VAL="$TASK_LLM_THINKING_BUDGET"         push_env
[ -n "$BYOA_TOOL_CALL_TIMEOUT_SECONDS" ]    && KEY=BYOA_TOOL_CALL_TIMEOUT_SECONDS   VAL="$BYOA_TOOL_CALL_TIMEOUT_SECONDS"   push_env
[ -n "$BYOA_AGENT_IDLE_TEARDOWN_SECONDS" ]  && KEY=BYOA_AGENT_IDLE_TEARDOWN_SECONDS VAL="$BYOA_AGENT_IDLE_TEARDOWN_SECONDS" push_env
```

Note on `--value`: this puts the secret in the process command line, briefly visible to other local users via `ps aux`. Acceptable on a developer machine; if pushing on shared infrastructure use `vercel env pull` + manual edit instead.

If `vercel env rm` complains "Environment Variable was not found" on first run, that's fine — `|| true` swallows it. The real failure mode is an `action_required` JSON blob from the `add` step; if you see one, surface the message and stop. **Do not** echo `BYOA_WAKE_SECRET` or API keys to the console in error reporting.

### 5. Deploy and capture the canonical alias

Default to production (see "Default deploy target" note above). Tee the output so we can grep for the alias line. Same `--cwd` rule as step 4 — don't replace with chained `cd` patterns, even in pipelines:

```bash
npx vercel --cwd deployment/vercel deploy --prod --yes 2>&1 | tee /tmp/byoa-deploy.log
```

For `--preview` (rarely correct for BYOA), drop `--prod` — but warn the operator the resulting URL will be SSO-gated.

After the deploy, capture **two** URLs:

```bash
# Per-deploy URL (immutable, SSO-gated under Standard Protection — not useful for source_url)
DEPLOY_URL=$(grep -oE 'https://[a-z0-9-]+\.vercel\.app' /tmp/byoa-deploy.log | head -1)

# Canonical alias (public for prod, the URL the game server actually hits).
# Use `cut`, not awk's positional-field operator — the loader rewrites literal
# dollar-N tokens in this file with the slash-command args, which would mangle
# any awk field reference inside a fenced code block.
ALIAS_URL=$(grep -oE 'Aliased: https://[^ ]+' /tmp/byoa-deploy.log | head -1 | cut -d' ' -f2)

# Fallback: construct from project.json if the Aliased: line is missing (e.g. on preview deploys)
if [ -z "$ALIAS_URL" ]; then
  PROJECT_NAME=$(grep -o '"projectName":"[^"]*"' deployment/vercel/.vercel/project.json | cut -d'"' -f4)
  ALIAS_URL="https://${PROJECT_NAME}.vercel.app"
fi
```

On non-zero exit from `vercel deploy`, surface the CLI's error and stop.

**Use `ALIAS_URL` for everything downstream (health-check, smoke-test, source_url).** The per-deploy `DEPLOY_URL` will 401 on any unauthenticated request because Vercel's Standard Protection gates it behind SSO — even when the function itself is wired correctly. Hitting it during health-checks is the single biggest source of false-negative deployment reports.

Write `ALIAS_URL` to `--out-url` if provided.

### 6. Health-check (against `ALIAS_URL`)

The function's `GET /api/wake` returns `{ status: "ok", wake_secret_configured: <bool> }`:

```bash
curl -sS -w "\nHTTP %{http_code}\n" "${ALIAS_URL}/api/wake"
```

Required: HTTP 200 with `wake_secret_configured: true`.

Failure interpretations:

- **HTML body starting with `<!doctype html>` and an "Authentication Required" page** → you hit a SSO-gated URL. You're using `DEPLOY_URL` instead of `ALIAS_URL`. Switch and retry. (Do not paste a Vercel bypass token into this skill.)
- **HTTP 200 but `wake_secret_configured: false`** → the env push in step 4 didn't land. Re-run step 4 just for `BYOA_WAKE_SECRET`, redeploy, re-check.
- **HTTP 404** → the function didn't deploy. Check the `vercel deploy` build log in `/tmp/byoa-deploy.log` for errors in `api/wake.ts`.

### 7. Auth smoke-test (against `ALIAS_URL`)

Confirm the bearer check rejects unsigned requests:

```bash
curl -s -o /tmp/byoa-post.out -w "%{http_code}\n" -X POST "${ALIAS_URL}/api/wake" \
  -H "Content-Type: application/json" -d '{}'
cat /tmp/byoa-post.out
```

Expect HTTP `401` and body `{"success":false,"error":"unauthorized"}`. Anything else (especially HTML or `200`) means either:

- you hit `DEPLOY_URL` (the 401 here would be Vercel SSO, not the function's bearer check — false positive), or
- bearer auth isn't wired correctly.

Confirm the body matches `unauthorized` exactly before proceeding. Do **not** let the operator point a ship at a function that doesn't enforce bearer auth.

### 8. Register `source_url` with the game server

Now that the deployment is verified, register `ALIAS_URL` as the ship's `source_url` so the game server's `wake_agent` knows where to POST. The ship was already claimed by `/byoa-setup`, and `wake_secret` was already registered there — this call is a partial `set` that only touches `source_url`. (Verified: `ship_byoa_configure` supports `wake_secret` and `source_url` independently via `p_update_wake_secret` / `p_update_source_url`.)

Skip this whole step if `--skip-register` was passed; jump straight to the manual-fallback block at the bottom.

**8a. Get a user JWT.**

If `--access-token <jwt>` was passed, use it as `ACCESS_TOKEN` and skip to 8b.

Otherwise prompt the operator in chat (one message asking for email + password — they paste back). Then:

```bash
LOGIN_RESPONSE=$(curl -s -X POST "${SUPABASE_URL}/functions/v1/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\": \"$EMAIL\", \"password\": \"$PASSWORD\"}")

ACCESS_TOKEN=$(echo "$LOGIN_RESPONSE" | grep -o '"access_token":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ -z "$ACCESS_TOKEN" ]; then
  echo "Login failed:"
  echo "$LOGIN_RESPONSE"
  # Don't stop — fall through to the manual curl in 8c so the operator can finish by hand.
fi
```

Never echo `$PASSWORD` after capture. Don't print `$ACCESS_TOKEN` to chat either — it's a short-lived but still-sensitive bearer.

On a 401 or `success: false` response: don't retry (likely bad creds). Surface the response body and fall through to 8c. Other failure modes (5xx, network) also fall through.

**8b. POST `source_url`.**

```bash
REGISTER_RESPONSE=$(curl -s -X POST "${SUPABASE_URL}/functions/v1/ship_byoa_configure" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -d "{
    \"character_id\": \"$BYOA_CHARACTER_ID\",
    \"ship_id\": \"$BYOA_SHIP_ID\",
    \"action\": \"set\",
    \"source_url\": \"${ALIAS_URL}/api/wake\"
  }")
echo "$REGISTER_RESPONSE"
```

Expect a response containing `"source_url_updated":true`. If not, surface the body and fall through to 8c. Common failure modes:

- "No authorization token provided" / "Invalid or expired token" → `ACCESS_TOKEN` is empty or expired; re-run step 8a
- 403 `forbidden` → the JWT's user does not own the ship referenced by `BYOA_SHIP_ID`; re-run `/byoa-setup` with the right account
- `source_url must be http(s):// and ≤ 4096 chars` → `ALIAS_URL` is empty/malformed; check step 5's fallback

**8c. Manual fallback (printed only on auto-register failure or `--skip-register`).**

```bash
curl -s -X POST "${SUPABASE_URL}/functions/v1/ship_byoa_configure" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <your access token from /login>" \
  -d '{
    "character_id": "'"$BYOA_CHARACTER_ID"'",
    "ship_id": "'"$BYOA_SHIP_ID"'",
    "action": "set",
    "source_url": "'"$ALIAS_URL"'/api/wake"
  }'
```

`ALIAS_URL` (the `<projectName>.vercel.app` form) is stable, so the registered `source_url` survives future deploys — no re-registration needed unless you change Vercel projects. Never register a `DEPLOY_URL` (per-deploy hash): it rotates every deploy and 401s the game server via Vercel SSO.

Fresh access tokens can be minted by re-running `/byoa-setup <env> --force --ship-id $BYOA_SHIP_ID` (also rotates `wake_secret`, which then needs a redeploy here to sync the Vercel env — pass `--access-token <jwt>` to skip the re-login on the redeploy).

### 9. Report

End with a terse summary:

- Canonical alias (`${ALIAS_URL}`) — what's registered as `source_url`
- Per-deploy URL (`${DEPLOY_URL}`) — for `vercel inspect` / dashboard only; SSO-gated
- Wake endpoint (`${ALIAS_URL}/api/wake`)
- Health-check result (✓ wake_secret_configured, ✓ 401 `unauthorized` on unauthed POST)
- Registration result: ✓ `source_url_updated: true` (or, if step 8 fell through: ⚠️ auto-register skipped/failed — see the manual curl above)
- Next step: start a task on the ship from the bot. Tail Vercel logs with `npx vercel logs ${ALIAS_URL}` and watch for the first wake — the initial clone + `uv sync` takes 30–60s on cold sandbox.
- Pointer to [docs/byoa-vercel.md](../../../docs/byoa-vercel.md) for troubleshooting.

## Failure modes

- **Missing `.env.byoa`**: run `/byoa-setup` first.
- **`vercel whoami` says not authenticated**: `npx vercel login`, then re-run.
- **`deployment/vercel/.vercel/project.json` missing**: run `cd deployment/vercel && npx vercel link` interactively, then re-run.
- **Stray `.vercel/` at repo root or `deployment/`**: an earlier `vercel link` was run from the wrong cwd. Either `mv` it into `deployment/vercel/.vercel/` or `rm -rf` it and re-link from inside `deployment/vercel/`.
- **Health check returns HTML "Authentication Required"**: you're hitting `DEPLOY_URL` (per-deploy hash URL), which is gated by Vercel Standard Protection. Use `ALIAS_URL` (`<projectName>.vercel.app`) instead. This is **always** a URL confusion, never a function-level auth bug.
- **Health check returns `wake_secret_configured: false`**: env push didn't propagate to production — re-run step 4 for `BYOA_WAKE_SECRET` and redeploy. (Step 4 only writes to the `production` Vercel env, so a preview-target deploy will *always* see this; if you deployed `--preview`, redeploy `--prod`.)
- **POST returns anything but 401 `{"success":false,"error":"unauthorized"}` in step 7**: bearer check broken (or you hit `DEPLOY_URL` and saw a Vercel SSO 401 — re-check against `ALIAS_URL`). Do not register `source_url` until the function-level 401 is confirmed.
- **`Aliased:` line missing from `vercel deploy` output**: happens on preview deploys (no automatic alias) and on first-ever production deploy for some projects. The step-5 snippet falls back to constructing `https://<projectName>.vercel.app` from `.vercel/project.json`.
- **Deploy went to `target: production` even without `--prod`**: the project default in Vercel is set to production-on-deploy. Harmless for BYOA (we want prod anyway) but worth knowing if you expected a preview.
- **First wake takes > 60s and times out on Hobby plan**: bump `maxDuration` in `vercel.json` (Hobby caps at 60s; Pro at 800s) or upgrade plan.
- **`/login` returns 401 / `success: false`** in step 8a: bad credentials. Don't retry — fall through to the manual curl. Skill prints 8c and the operator finishes by hand.
- **`ship_byoa_configure` returns 403 `forbidden`** or `Only the current BYOA owner can set wake config`: the JWT belongs to a different operator than the one who claimed the ship. Either re-run `/byoa-setup` with the right account, or supply `--access-token` from the right account on the next deploy.
- **`ship_byoa_configure` returns 401 "No authorization token provided"**: the `Authorization: Bearer` header was empty (likely because step 8a's `ACCESS_TOKEN` extraction failed silently). Surface the raw login response and re-run step 8a.

## What this skill does NOT do

- Claim the ship or generate the wake secret — that's `/byoa-setup`. This skill only registers the `source_url` for an already-claimed, already-wake-secret-registered ship.
- Persist the user JWT — it's used in-memory for the single `ship_byoa_configure` call and discarded. Operators wanting to skip the login prompt should pass `--access-token <jwt>` directly.
- Edit the wake function code — operators who want custom behavior should fork the template directory.
- Author the prompt for the operator — `wake.ts` auto-loads [deployment/vercel/prompt.md](../../../deployment/vercel/prompt.md) on every wake when neither `BYOA_PROMPT` nor `BYOA_PROMPT_FILE` is set in operator env. Operators wanting to override the default either edit `prompt.md` before deploying (changes ride along with the next `vercel deploy`, picked up by sandboxes on next provision) or set `BYOA_PROMPT` (inline ≤ 8 KB) on the Vercel project env.
