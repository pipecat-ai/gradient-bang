# BYOA on Vercel

Use Vercel when you want the BYOA wake receiver to run outside your local machine.

The deployment is skill-driven:

- `/byoa-setup prod` claims the ship and prepares `.env.byoa`.
- `/byoa-deploy-vercel prod` deploys the wake function and registers it against the ship.

The wake receiver source lives in [deployment/vercel](../deployment/vercel/).

## Quickstart

Prereqs:

- You have run `/byoa-setup prod`.
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

- Run `/byoa-deploy-vercel prod`.
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

## What The Deploy Skill Does

`/byoa-deploy-vercel prod`:

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
| `BYOA_CHARACTER_ID` | Written by `/byoa-setup prod`. |
| `BYOA_SHIP_ID` | Written by `/byoa-setup prod`. |
| `BYOA_WAKE_SECRET` | Written by `/byoa-setup prod`; pushed to Vercel by deploy. |
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
| `BYOA_AGENT_IDLE_TEARDOWN_SECONDS` | Warm-agent idle timeout. |
| `BYOA_REPO_URL` / `BYOA_REPO_REVISION` | Run from a fork or pinned revision. |
| `GITHUB_TOKEN` | Clone a private fork or avoid public rate limits. |

## Files In The Template

- [api/wake.ts](../deployment/vercel/api/wake.ts): authenticates wakes and starts the sandbox.
- [package.json](../deployment/vercel/package.json): Vercel function dependencies.
- [vercel.json](../deployment/vercel/vercel.json): Vercel route settings.
- [prompt.example.md](../deployment/vercel/prompt.example.md): optional prompt starting point.

Most operators only edit `.env.byoa` and optionally `prompt.md`.

## Redeploys

- Code or env changed: run `/byoa-deploy-vercel prod` again.
- Prompt changed in `BYOA_PROMPT`: run `/byoa-deploy-vercel prod` again.
- Prompt file changed in a fork: commit the file, then run `/byoa-deploy-vercel prod`.
- Wake secret rotation: run `/byoa-setup prod --force --ship-id $BYOA_SHIP_ID`, then `/byoa-deploy-vercel prod`.
- New Vercel project: delete `deployment/vercel/.vercel/`, run `npx vercel link`, then `/byoa-deploy-vercel prod`.

## Troubleshooting

- `wake_secret_configured: false`: Vercel env did not reach the deployed function. Re-run `/byoa-deploy-vercel prod`.
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
