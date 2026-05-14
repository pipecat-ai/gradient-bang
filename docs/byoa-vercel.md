# BYOA: Vercel wake function

Operator-facing reference for the wake receiver that runs on the operator's Vercel project. Implements the wake contract described in [byoa.md](byoa.md#how-wake-works).

The source lives in-tree at [deployment/vercel/](../deployment/vercel/):

- [api/wake.ts](../deployment/vercel/api/wake.ts) — the function itself (bearer-auth, persistent-sandbox lookup, harness launch).
- [package.json](../deployment/vercel/package.json) — pins `@vercel/sandbox@beta`.
- [vercel.json](../deployment/vercel/vercel.json) — sets `maxDuration: 300` on the wake route.
- [prompt.example.md](../deployment/vercel/prompt.example.md) — copy to `prompt.md` and edit; load via `BYOA_PROMPT_FILE` on the Vercel project env.

Deploy it with `/byoa-deploy-vercel <env>` — see [.claude/skills/byoa-deploy-vercel/SKILL.md](../.claude/skills/byoa-deploy-vercel/SKILL.md).

## What the function does

On every wake POST from `wake_agent`:

1. **Authenticates** the inbound request against `BYOA_WAKE_SECRET` — the per-ship bearer the operator stored against their ship via `ship_byoa_configure set { wake_secret }` and pasted into this Vercel project's env. wake_agent decrypts the per-ship value from `ship_instances.byoa_wake_secret_enc` at dispatch time and signs the POST with it.
2. **Looks up the ship's persistent sandbox** by name `byoa-<ship_id>`. First wake provisions a fresh one (clones the gradient-bang repo, runs `uv sync` against [pyproject.byoa.toml](../pyproject.byoa.toml)); subsequent wakes resume from the auto-snapshot in seconds.
3. **Merges env**: operator project env (allowlisted keys only — see `OPERATOR_ENV_KEYS` in `api/wake.ts`) + per-session wake env (`BYOA_CHANNEL`, `BYOA_TASK_ID`, `BYOA_BUS_DATABASE_URL`, …) injected by `wake_agent`. Wake bits win on overlap.
4. **Spawns `uv run byoa` detached** inside the sandbox with the merged env.
5. **Returns 202** with `{ sandbox_name, cmd_id, task_id, request_id, created }`.

Operator-private state (LLM keys, prompt, tunables) stays on the operator's Vercel project. Our `wake_agent` only sees the URL and signs requests with the per-ship bearer.

## Required project env on the operator's Vercel project

`/byoa-deploy-vercel` pushes these from `.env.byoa` for you. Pasted here as a reference if you'd rather configure via the Vercel dashboard.

| Key | Required | What it does |
|---|---|---|
| `BYOA_WAKE_SECRET` | yes | Per-ship bearer authenticating wake_agent → this function. Generate with `openssl rand -hex 32`; set this value here AND send the same value to us via `ship_byoa_configure set { wake_secret }`. Per-ship (not shared across operators) so a leak only compromises that one ship. |
| `TASK_LLM_PROVIDER` | yes | One of `google` / `anthropic` / `openai` / `minimax`. |
| `TASK_LLM_MODEL` | yes | Provider-specific model id. |
| `GOOGLE_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `MINIMAX_API_KEY` | yes (matching `TASK_LLM_PROVIDER`) | The operator's own LLM credential. Never leaves their Vercel project. |
| `BYOA_PROMPT` | optional | Inline operator prompt (≤ 8 KB). Wins over `BYOA_PROMPT_FILE`. |
| `BYOA_PROMPT_FILE` | optional | Path inside the sandbox checkout, e.g. `./prompt.md` if you committed one alongside `api/wake.ts` in your fork. |
| `TASK_LLM_THINKING_BUDGET` | optional | Default `4096`. |
| `BYOA_TOOL_CALL_TIMEOUT_SECONDS` | optional | Default `30.0`. |
| `BYOA_AGENT_IDLE_TEARDOWN_SECONDS` | optional | Default `300.0`. |
| `BYOA_REPO_URL` / `BYOA_REPO_REVISION` | optional | Point the sandbox at a fork / specific revision of the gradient-bang repo. |
| `GITHUB_TOKEN` | optional | Fine-grained PAT for cloning a private fork (avoids public rate limits even on public repos). |

Vercel auth (`VERCEL_OIDC_TOKEN`) is automatic when the function runs on Vercel — no extra env needed for the `@vercel/sandbox` SDK.

## End-to-end operator flow

1. **Claim a ship + generate the wake secret.** `/byoa-setup prod` — claims a corp ship as BYOA, writes `BYOA_*` to `.env.byoa`, registers the wake secret server-side.
2. **Edit your operator config.** Open `.env.byoa`, fill in `TASK_LLM_PROVIDER`, `TASK_LLM_MODEL`, the matching `*_API_KEY`, and (optionally) `BYOA_PROMPT` / `BYOA_PROMPT_FILE`.
3. **First-time Vercel project setup.** From `deployment/vercel/`, run `npx vercel link` interactively to associate the directory with a Vercel project (suggested name: `gradient-bang-byoa-<your-handle>`).
4. **Deploy.** `/byoa-deploy-vercel prod --prod` pushes env from `.env.byoa` to the Vercel project, runs `vercel deploy --prod`, health-checks `GET /api/wake`, smoke-tests bearer auth on `POST /api/wake`, and prints the `ship_byoa_configure set { source_url }` curl.
5. **Wire the ship at the deployment.** Run the printed curl (or re-run `/byoa-setup prod --force --ship-id <ship>` to mint a fresh wake secret AND update both sides in one shot).
6. **Trigger a wake.** Start a task on the ship from the bot. Watch Vercel function logs — first wake takes 30–60s for the cold-sandbox clone + `uv sync`; subsequent wakes resume the snapshot and complete in seconds.

## Troubleshooting

- **`wake_secret_configured: false` on `GET /api/wake`** — env didn't propagate to the deployed function. Re-run `/byoa-deploy-vercel` (it pushes env *and* redeploys).
- **`POST /api/wake` returns 200 without auth** — bearer check is broken; do not register `source_url`. Investigate before pointing wake_agent at this function.
- **First wake times out on Hobby plan** — `maxDuration` is capped at 60s on Hobby; the cold-sandbox clone + `uv sync` needs ~30–60s. Upgrade to Pro (caps at 800s) or accept that the first wake will fail and the second will succeed once the snapshot exists.
- **Sandbox runs `uv sync` every wake** — the persistent sandbox snapshot expired. Bump `SNAPSHOT_EXPIRATION_MS` in `api/wake.ts` (default 30 days).
- **Want to customize the wake function** — fork `deployment/vercel/` into your own repo, point `vercel link` at it. The skill keys off paths under `deployment/vercel/`; either symlink or keep your fork separate and run `vercel` commands by hand.
