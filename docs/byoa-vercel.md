# BYOA on Vercel

Deploy the BYOA wake receiver as a Vercel Function. This is the production path, but it also works against a local game stack for development — see [Testing Locally](#testing-locally).

The deployment is skill-driven:

- `/byoa-link` claims the ship and prepares `.env.byoa`.
- `/byoa-deploy-vercel` deploys the wake function and registers it against the ship.

The wake receiver source lives in [deployment/vercel](../deployment/vercel/).

## Quickstart

Prereqs:

- You have run `/byoa-link`.
- `.env.byoa` contains your LLM provider, model, and matching API key.
- You are logged in to Vercel CLI: `npx vercel whoami`.
- `deployment/vercel/` is linked to your Vercel project.

First-time Vercel link:

```bash
cd deployment/vercel
npx vercel link
```

Suggested project name: `gradient-bang-byoa-<your-handle>`.

Deploy:

- Run `/byoa-deploy-vercel`.
- Let the skill push env to Vercel.
- Let the skill deploy to the production alias.
- Let the skill health-check `/api/wake`.
- Let the skill register `https://<projectName>.vercel.app/api/wake` as the ship `source_url`.
- Trigger a task on the ship from the bot.

Tail logs:

```bash
npx vercel logs https://<projectName>.vercel.app
```

First wake can take longer while Vercel creates and prepares the sandbox. Later wakes should resume faster.

## Testing Locally

You can point a Vercel-deployed wake receiver at your **local** game stack (local Supabase + local bot). The receiver itself still runs on Vercel; the only thing that needs to be reachable from the public internet is your local Postgres, because the Vercel sandbox connects to it directly to consume task messages on the BYOA bus.

Expose your local Supabase Postgres with `ngrok tcp`:

```bash
ngrok tcp 54322
```

ngrok prints a forwarding line like `Forwarding tcp://7.tcp.eu.ngrok.io:20789 -> localhost:54322`. Use that as the bus DSN in `.env.supabase`:

```
BYOA_BUS_DATABASE_URL=postgresql://byoa_login:byoa_dev_password@7.tcp.eu.ngrok.io:20789/postgres
```

Restart `npx supabase functions serve` so `wake_agent` picks up the new URL. Every wake injects this DSN into the sandbox so the harness can reach your machine.

Caveats:

- Only the bus needs a tunnel — the wake URL on Vercel is still the public alias.
- ngrok TCP forwarding hostnames change on every restart for free-tier accounts. Update `.env.supabase` and restart `supabase functions serve` whenever the tunnel reconnects.
- Tunnel latency adds a small overhead to every bus round-trip; expect slower harness boot than a pure-prod setup.

## What The Deploy Skill Does

`/byoa-deploy-vercel`:

- Reads `.env.byoa`.
- Verifies required BYOA and LLM env keys.
- Pushes operator env to the Vercel production environment.
- Deploys [deployment/vercel](../deployment/vercel/) with `npx vercel deploy --prod`.
- Uses the stable production alias, not the per-deploy URL.
- Checks that the wake function is reachable.
- Confirms bearer auth rejects unauthenticated wake POSTs.
- Registers the wake URL with `ship_byoa_configure`.

Useful flags:

- `--access-token <jwt>`: skip the email/password prompt during registration.
- `--skip-register`: deploy and health-check only; print the manual registration curl.
- `--preview`: rarely useful for BYOA because preview URLs are usually SSO-protected.

## What To Put In `.env.byoa`

Required:

| Key | Purpose |
|---|---|
| `BYOA_CHARACTER_ID` | Written by `/byoa-link`. |
| `BYOA_SHIP_ID` | Written by `/byoa-link`. |
| `BYOA_WAKE_SECRET` | Written by `/byoa-link`; pushed to Vercel by deploy. |
| `TASK_LLM_PROVIDER` | `google`, `anthropic`, `openai`, or `minimax`. |
| `TASK_LLM_MODEL` | Provider-specific model id. |
| Provider API key | One of `GOOGLE_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `MINIMAX_API_KEY`. |

Optional:

| Key | Purpose |
|---|---|
| `BYOA_PROMPT` | Inline prompt. Wins over `BYOA_PROMPT_FILE`. |
| `BYOA_PROMPT_FILE` | Prompt file path inside the sandbox checkout, for example `./prompt.md`. |
| `TASK_LLM_THINKING_BUDGET` | Model thinking budget. |
| `BYOA_TOOL_CALL_TIMEOUT_SECONDS` | Tool-call timeout. |
| `TASK_AGENT_EVENT_DRAIN_GRACE_SECONDS` | Task-agent event inference drain grace, default `0.25`. |
| `BYOA_REPO_URL` / `BYOA_REPO_REVISION` | Run from a fork or pinned revision. |
| `GITHUB_TOKEN` | Clone a private fork or avoid public rate limits. |

## Files In The Template

- [api/wake.ts](../deployment/vercel/api/wake.ts): authenticates wakes and starts the sandbox.
- [package.json](../deployment/vercel/package.json): Vercel function dependencies.
- [vercel.json](../deployment/vercel/vercel.json): Vercel route settings.
- [prompt.example.md](../deployment/vercel/prompt.example.md): optional prompt starting point.

Most operators only edit `.env.byoa` and optionally `prompt.md`.

## Redeploys

- Code or env changed: run `/byoa-deploy-vercel` again.
- Prompt changed in `BYOA_PROMPT`: run `/byoa-deploy-vercel` again.
- Prompt file changed in a fork: commit the file, then run `/byoa-deploy-vercel`.
- Wake secret rotation: run `/byoa-link --force --ship-id $BYOA_SHIP_ID`, then `/byoa-deploy-vercel`.
- New Vercel project: delete `deployment/vercel/.vercel/`, run `npx vercel link`, then `/byoa-deploy-vercel`.

## Troubleshooting

- `wake_secret_configured: false`: Vercel env did not reach the deployed function. Re-run `/byoa-deploy-vercel`.
- HTML "Authentication Required": you are using a protected Vercel URL. Use `https://<projectName>.vercel.app/api/wake`.
- Wake POSTs return 401 in production: check that the registered URL is the production alias, not a per-deploy URL.
- Registration failed: re-run with `--access-token <jwt>` or use the printed manual curl.
- First wake times out: retry once after the sandbox has been created, or use a Vercel plan with a longer function duration.
- Sandbox setup repeats every wake: the persistent sandbox snapshot expired or was not reused.

## Manual Registration

The deploy skill normally handles this. Use the manual path only when registration fails or you are running a custom deployment.

```bash
curl -X POST "$SUPABASE_URL/functions/v1/ship_byoa_configure" \
  -H "Authorization: Bearer $YOUR_USER_JWT" \
  -d '{
    "character_id": "<your character UUID>",
    "ship_id": "<corp ship UUID>",
    "action": "set",
    "source_url": "https://<your-project>.vercel.app/api/wake"
  }'
```

Only send `wake_secret` in the same request when rotating the secret. Otherwise, leave it unchanged.
