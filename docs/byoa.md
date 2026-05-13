# BYOA: Bring Your Own Agent

Run your own AI agent for a corporation ship. The harness reads its config from env vars at wake time and drives the TaskAgent against the game's PGMQ bus. Two intended modes:

- **Mode A** — deploy our hosted template to Vercel, set env vars on your Vercel project, done. No code.
- **Mode B** — fork the harness, attach hooks (`@app.prompt`, `@app.llm`, …) or eject entirely and write your own runner against the TaskAgent building blocks.

> **Implementation status.** The harness, per-ship wake-URL column, and BYOA token primitives are live on `jpt/0.5.0-byoa-phase-3`. The `set` action on `ship_byoa_configure`, the hosted Vercel-function template, and the runtime tarball CI are rolling out across follow-up PRs. The **local-dev quickstart works end-to-end today**; the **production quickstart** describes the eventual flow.

## How wake works

There's exactly one dispatch path: **HTTP POST to a URL the operator owns**.

```
bot → wake_agent → POST to byoa_runtime_source_url → operator's receiver → harness process
                                                          │
                                                          ├─ local dev: `byoa --serve` daemon spawns `uv run byoa` as a subprocess
                                                          └─ prod:      operator's Vercel Function calls Sandbox.create() with project env merged
```

Operator config (LLM keys, prompt) lives in the receiver's runtime env — `.env.byoa` for the local daemon, Vercel project env for the prod function. We never see operator secrets and never call `Sandbox.create()` ourselves; the operator's function does that with its own project credentials.

## Local-dev quickstart

Run the bot and your BYOA agent side-by-side on the same machine; both speak to a local Supabase.

**Prereqs.** Working dev stack: `npx supabase start --workdir deployment`, `scripts/reset-world.sh` run at least once after migrations, a game account with a character in a corp that owns at least one ship.

**1. Onboard.** From the repo root:

```bash
/byoa-setup local
```

The skill logs in, lets you pick a corp ship to claim, mints a BYOA token bound to your character, and writes `./.env.byoa` (mode `0600`). The plaintext token is shown once and never re-fetchable.

**2. Author a prompt** in `./prompt.md` (≤ 8 KB, appended to the base task-agent system prompt):

```markdown
You are a cautious trader. Prefer profitable trade routes over combat.
If attacked, flee unless the enemy is at <30% shields.
```

Then `export BYOA_PROMPT_FILE=./prompt.md` (or set it in `.env.byoa`).

**3. Start the bot:**

```bash
set -a && source .env.supabase && set +a
uv run bot --host 0.0.0.0
```

**4. Start the local wake daemon** (separate terminal, auto-loads `./.env.byoa`):

```bash
uv run byoa --serve
```

Set the local edge-function env with `BYOA_BUS_DATABASE_URL` and `WAKE_TARGET=http`. Optionally set `DEFAULT_BYOA_SOURCE_URL=http://host.docker.internal:8765/wake` so a freshly-claimed ship without a per-ship URL still routes somewhere sensible.

The per-ship wake bearer is set via `ship_byoa_configure set { source_url, wake_secret }` (the `byoa-setup` skill writes this for you in step 1; it generates the value, stores it in `.env.byoa` for the daemon, and sends the same value to us via the configure endpoint). When a task starts, `wake_agent` looks up the ship's URL + decrypted bearer, POSTs the wake to the URL with `Authorization: Bearer <ship's wake secret>`; the daemon validates the bearer against its own `.env.byoa` copy and spawns `uv run byoa` (no flag — single session) with the merged env. The spawned process joins the per-session PGMQ channel via the SECURITY DEFINER `public.bus_*` wrappers; knowledge of the channel name (transported wake → BYOA over HTTPS) is the bus capability.

**Rotate tokens.** Re-run `/byoa-setup local --force` to mint a fresh token, then revoke the old one via `byoa_token_revoke`.

## Production quickstart

In production, BYOA runs in a Vercel Sandbox the **operator** owns. The operator deploys a small Vercel Function (from our hosted template) on their Vercel project. That function is what calls `Sandbox.create()` — it has access to the operator's project env at runtime (standard Vercel Function behavior), forwards it into the sandbox via the `env` param, and we never see operator secrets.

**1. Onboard.** Same as local — `/byoa-setup prod` claims the ship and mints a BYOA token in our prod env.

**2. Deploy our hosted template to Vercel.** One-click "Deploy to Vercel" from `gradient-bang-byoa-template` (see [byoa-vercel.md](byoa-vercel.md) for the reference function code while that template is still being assembled). The template includes:

- `api/wake.ts` — a Vercel Function that receives our wake POST, calls `Sandbox.create()` with the operator's project env merged into the `env` param, and runs `uv run byoa` inside.
- `prompt.md` — a placeholder prompt the operator edits.
- Project env keys the operator must fill in via the Vercel dashboard or `vercel env add`:
  - `BYOA_WAKE_SECRET` — the per-ship bearer that authenticates wake_agent → this function. Generate a fresh random value (`openssl rand -hex 32`) and use the same value when you `ship_byoa_configure set` in step 3.
  - `TASK_LLM_PROVIDER`, `TASK_LLM_MODEL`, and the matching `*_API_KEY` for your chosen LLM.
  - Optional: `BYOA_PROMPT` (inline; otherwise the deployed `prompt.md` is used), `BYOA_TOOL_CALL_TIMEOUT_SECONDS`, `BYOA_AGENT_IDLE_TEARDOWN_SECONDS`.

The function uses our default runtime tarball URL out of the box; fork the template to use your own.

**3. Point your ship at the deployed function URL and give us a wake bearer:**

Generate a random secret (e.g. `openssl rand -hex 32`). Set it as `BYOA_WAKE_SECRET` on your Vercel project env, then send the **same value** to us so we can sign wakes to your function:

```bash
curl -X POST "$SUPABASE_URL/functions/v1/ship_byoa_configure" \
  -H "Authorization: Bearer $ANON_KEY" \
  -H "X-API-Token: $YOUR_USER_JWT" \
  -d '{
    "character_id": "<your character UUID>",
    "ship_id": "<corp ship UUID>",
    "action": "set",
    "source_url": "https://<your-project>.vercel.app/api/wake",
    "wake_secret": "<the random hex>"
  }'
```

We store the secret encrypted at rest. wake_agent decrypts it inside a SECURITY DEFINER function at dispatch time and uses it as the `Authorization: Bearer …` to your function. The plaintext never appears in any client-readable column.

**4. Trigger a task** through the bot UI. `wake_agent` POSTs the wake payload to your function URL. Your function reads its own `process.env` (= your Vercel project env, automatically inherited), merges with the wake payload, and calls `Sandbox.create({ source: { type: 'tarball', url }, runtime: 'python3.13', env: { …operator config…, …per-session bits… } })`. The sandbox runs `uv run byoa` and the harness reads the merged env.

## Mode B: ejecting from defaults

Fork our hosted template. Two parts you can customise:

1. **The Vercel Function** (`api/wake.ts`). Run any arbitrary logic before/after `Sandbox.create()`: read secrets from HashiCorp Vault, fetch a per-session prompt from your own service, swap the LLM by environment, etc. As long as it accepts our wake POST shape and ultimately runs `uv run byoa` inside a sandbox connected to our bus, it's fine.

2. **The harness tarball.** Add hooks via `gradientbang.byoa.ByoaApp`:

```python
# my_bot.py — your fork's entry point
from gradientbang.byoa import ByoaApp

app = ByoaApp()

@app.prompt
def custom_prompt(ctx) -> str:
    return ctx.prompt + "\n\nExtra: prefer Z-region routes over R-region."

@app.llm
def custom_llm(ctx):
    from pipecat.services.aws.llm import AWSBedrockLLMService
    return AWSBedrockLLMService(aws_region="us-west-2", model="anthropic.claude-...")

@app.on_session_end
async def cleanup(ctx):
    await my_metrics.flush()

if __name__ == "__main__":
    app.run()
```

Rebind the `byoa` console script in your fork's `pyproject.byoa.toml`:

```toml
[project.scripts]
byoa = "my_bot:main"
```

Your function points at your forked tarball URL (`source: { type: 'tarball', url: 'https://your-fork/...' }`); we still POST to your function URL the same way as Mode A.

For a fully-custom runner that skips `ByoaApp` entirely, import `TaskAgent` and `build_byoa_pgmq_bus` directly. See [src/gradientbang/byoa/app.py](../src/gradientbang/byoa/app.py) for the reference wiring.

## Config reference

### Sandbox env (read by `uv run byoa`)

The harness reads only `os.environ`. Population is the receiver's responsibility:

- **Local dev**: `byoa --serve` daemon merges `.env.byoa` (operator config) + the wake POST body (per-session bits) and spawns `uv run byoa` with that merged env.
- **Production**: the operator's Vercel Function merges `process.env` (= Vercel project env) + the wake POST body and passes it to `Sandbox.create({ env })`.

| Env var | Source | What it controls |
|---|---|---|
| `BYOA_SHIP_ID` | wake POST | Corp ship UUID (used as TaskAgent's `character_id`) |
| `BYOA_CHARACTER_ID` | wake POST | Operator's character |
| `BYOA_CHANNEL` | wake POST | Per-voice-session bus channel; capability for `public.bus_*` wrappers |
| `BYOA_TOKEN` | optional, operator-supplied | Reserved for a future HTTP-side BYOA gateway; not used by the bus today |
| `BYOA_BUS_DATABASE_URL` | wake POST | Restricted Postgres DSN |
| `BYOA_TASK_ID` | wake POST | Log correlation |
| `BYOA_WAKE_REQUEST_ID` | wake POST | Log correlation |
| `BYOA_PROMPT` | operator (`.env.byoa` / Vercel project env) | Operator's system-prompt markdown, inline. Wins over `BYOA_PROMPT_FILE` |
| `BYOA_PROMPT_FILE` | operator | Path to a prompt markdown file (≤ 8 KB) |
| `TASK_LLM_PROVIDER` | operator | `google` / `anthropic` / `openai` / `minimax`. Default `google` |
| `TASK_LLM_MODEL` | operator | Provider-specific model id |
| `TASK_LLM_THINKING_BUDGET` | operator | Thinking budget; mapped per provider. Default `4096` |
| `GOOGLE_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `MINIMAX_API_KEY` | operator | Provider key matching `TASK_LLM_PROVIDER` |
| `BYOA_TOOL_CALL_TIMEOUT_SECONDS` | operator (optional) | Bus RPC timeout. Default `30.0` |
| `BYOA_AGENT_IDLE_TEARDOWN_SECONDS` | operator (optional) | Warm-agent idle TTL. Default `300.0` |

### Per-ship wake config (`ship_instances` columns)

The DB holds the wake URL and a **per-ship bearer** that authenticates wake_agent → receiver POSTs. Operator credentials, prompts, and LLM keys never touch our database — they live in the operator's Vercel project env (prod) or `.env.byoa` (local).

| Column | Type | Set by action | Notes |
|---|---|---|---|
| `byoa_owner_character_id` | UUID | `claim` / `clear` | Operator-character binding for the ship |
| `byoa_runtime_source_url` | TEXT | `set` | URL wake_agent POSTs to. Must match `^https?://` and be ≤ 4 KB. NULL = use `DEFAULT_BYOA_SOURCE_URL` env on wake_agent |
| `byoa_wake_secret_enc` | BYTEA | `set` | Per-ship shared bearer between wake_agent and the receiver. Encrypted at rest with `byoa_operator_secret()` (pgcrypto). Never returned to clients. wake_agent refuses to dispatch when NULL |
| `byoa_runtime_updated_at` | TIMESTAMPTZ | auto | Diagnostics; last-write timestamp |

**Why per-ship and not a single shared secret:** one wake_agent serves every BYOA operator. A single env-level secret would mean any operator's leak forges wakes against every other operator's URL. Per-ship binds the bearer to the ship row; a leak only compromises that one ship.

### Game-operator env (bot + edge functions)

| Env var | Where | Default | What it controls |
|---|---|---|---|
| `SUBAGENT_BUS_TRANSPORT` | bot | `local` | `pgmq` to enable BYOA |
| `SUBAGENT_BUS_DATABASE_URL` | bot | — | Bot's privileged bus DSN. BYOA receivers must not receive this |
| `SUBAGENT_BUS_CHANNEL` | bot | — | Per-deployment channel prefix (e.g. `gb_prod`); bot derives per-session channel from this |
| `BYOA_BUS_DATABASE_URL` | wake_agent | — | Restricted BYOA bus DSN injected into the wake POST payload |
| `WAKE_TARGET` | wake_agent | `noop` | `http` to dispatch wakes, `noop` to disable (manual fallback) |
| `DEFAULT_BYOA_SOURCE_URL` | wake_agent | — | Fallback wake URL used when a ship's `byoa_runtime_source_url` is NULL. The per-ship bearer (`byoa_wake_secret_enc`) is **always required** — there is no shared-secret fallback |
| `TASK_AGENT_TIMEOUT` | bot | `1800` | Per-task hard upper bound (seconds). Bot cancels and clears its local ship lock on expiry. Not operator-overridable |

`EDGE_API_TOKEN` stays where it always was (privileged trusted-caller auth for our edge functions); it is **not** related to BYOA wake auth and never leaves our infra.

## `ship_byoa_configure` actions

One endpoint: `POST $SUPABASE_URL/functions/v1/ship_byoa_configure`. All actions require `Authorization: Bearer $ANON_KEY` + `X-API-Token: $YOUR_USER_JWT`. All actions are owner-only and refuse to mutate while the ship has a running task.

| Action | Body fields | Effect |
|---|---|---|
| `claim` | `character_id`, `ship_id` | Set `byoa_owner_character_id = self`. Idempotent if self-claimed; 409 if claimed by someone else |
| `clear` | `character_id`, `ship_id` | Set `byoa_owner_character_id = NULL`. Owner-only |
| `set` | `+ source_url?` / `+ wake_secret?` | Owner-only. Sets any supplied fields; omitted fields are left alone; explicit `null` clears. `wake_secret` is encrypted server-side before storage and never returned. `source_url` is validated `^https?://` and ≤ 4 KB |

| Ship state | Who can issue tasks |
|---|---|
| Not BYOA | Any corp member |
| BYOA | Only the BYOA owner. Others get a BYOA-owner-required failure |

A corp member can always force-cancel via `task_cancel { force: true }`.

## Bus protocol

Every game RPC, lifecycle event, and tool call goes through typed bus messages — defined in [bus_messages.py](../src/gradientbang/pipecat_server/subagents/bus_messages.py). The bundled `TaskAgent` ([task_agent.py](../src/gradientbang/pipecat_server/subagents/task_agent.py)) is the reference implementation; ejecting from the harness means subclassing or replacing it while preserving this protocol.

A BYOA agent must handle, at minimum:

- **Inbound**: `BusAgentHelloRequest` (liveness probe), `BusTaskRequest`, `BusTaskCancel`, `BusGameEventMessage`, `BusGameToolCallResponse`
- **Outbound**: `BusByoaPresenceMessage` (process online/offline heartbeat, broadcast every 10s — the bot's crash-detection signal), `BusAgentHelloResponse` (reply `ready=true`), `BusGameToolCallRequest`, `BusTaskFinishNotification`, optional `BusTaskUpdate`

Wake handshake: VoiceAgent sends `BusAgentHelloRequest` and waits up to `BYOA_AGENT_WAKE_TIMEOUT_SECONDS` (default 30s, bot-side) for the response. Timeout aborts the spawn and clears the bot's local ship lock.

## Lock recovery

The ship-task lock is per-bot in memory — there is no DB-persistent lock. The bot's `VoiceAgent._locked_ships` map is the only authority on "ship busy". When a BYOA dies the bot detects it through the `BusByoaPresenceMessage` heartbeat the BYOA broadcasts every 10s; missing beats for ~30s flip the bot's local lock back to idle and a `task.cancel` event is emitted.

| Failure | Recovery |
|---|---|
| Clean disconnect | < 1s (VoiceAgent shutdown hook clears local map) |
| BYOA crash / network drop | ~30s (presence heartbeat goes stale → bot clears its local lock + emits `task.cancel`) |
| BYOA alive but task hangs | `TASK_AGENT_TIMEOUT` (default 1800s = 30 min); bot cancels regardless of presence |
| Corp member wants it now | `task_cancel { force: true }` emits a cancel event; the owner's bot picks it up and clears its lock |

## Runtime tarball

The Python harness ships as a `byoa-runtime.tar.gz` built from the gradient-bang repo by CI (allowlisted via [scripts/byoa-manifest.txt](../scripts/byoa-manifest.txt)). It contains the harness (`gradientbang.byoa.app:main`), TaskAgent + tool schemas + bus adapters + prompts, and a slim [pyproject.byoa.toml](../pyproject.byoa.toml) with only the deps needed for the four Mode-A LLM providers.

The tarball is fetched by the operator's receiver (their Vercel Function in prod), not by us. Our hosted template's Vercel Function defaults to the latest release asset URL; Mode-B forks point at their own tarball.
