# BYOA: Setup Guide

> Bring-Your-Own-Agent — run your own task agent for a corporation ship.
> See [byoa.md](byoa.md) for the architecture and roadmap.

## Quickstart (local dev)

The only fully-supported flow today. Run the bot and your BYOA agent side-by-side on the same machine; both speak to a local Supabase.

**Prereqs.** Working dev stack: `npx supabase start --workdir deployment`, a game account with a character in a corporation that owns at least one ship.

**1. Onboard.** From the repo root, run the [byoa-setup skill](../.claude/skills/byoa-setup/SKILL.md):

```
/byoa-setup local
```

It logs in, lets you pick a corp ship to claim, mints a BYOA token bound to your character, and writes `./.env.byoa` (mode `0600`). The token is shown once and never re-fetchable.

**2. Author a prompt** in `./prompt.md` (≤ 8 KB, appended to the base task-agent prompt):

```markdown
You are a cautious trader. Prefer profitable trade routes over combat.
If attacked, flee unless the enemy is at <30% shields.
```

**3. Start the bot:**

```bash
set -a && source .env.supabase && set +a
uv run bot --host 0.0.0.0
```

**4. Run the BYOA agent** (separate terminal, auto-loads `./.env.byoa`):

```bash
uv run byoa --prompt-file ./prompt.md
```

You should see `byoa.cli.claim.polling` — the agent is polling `byoa_session_claim` waiting for the bot to delegate a task. Issue a task from the voice client; the bot calls `wake_agent` server-side (allocates a per-session channel), your agent's next claim discovers the channel, joins, and runs the task. Log line on join: `byoa.cli.claim.allocated channel=...`.

**Rotate tokens.** Re-run `/byoa-setup local --force` to mint a fresh token, then revoke the old one via `byoa_token_revoke`.

## How the discovery flow works

```
voice client    bot               edge fn              BYOA process
     │           │                   │                       │
     │ start_task─►                  │                       │  (polling claim)
     │           │ acquire_lock──────►                       │
     │           │ wake_agent────────► writes session_channel│
     │           │                   │                       │
     │           │                   │◄──claim───────────────│  channel: bot_dev
     │           │                   │──{channel}───────────►│  joins bus
     │           │◄──BYOA peer joins channel                 │
     │           │ BusTaskRequest────►                       │  runs task
     │           │                   │                       │
```

`wake_agent` only does process-spawn dispatch when `WAKE_TARGET` is set to `vercel` / `lambda` (server-side). In local dev (`WAKE_TARGET=noop`, the default), the operator's `uv run byoa` is already running and polling — wake just allocates the channel and the agent's next claim picks it up. The claim response carries `lifecycle_hint=idle_loop` (dev) or `single_task` (prod) so the agent knows whether to exit or keep polling after a task completes.

## Configuration

### BYOA-side (you, the operator)

Read by `ByoaAgentConfig.from_env()` ([src/gradientbang/byoa/config.py](../src/gradientbang/byoa/config.py)) and the CLI. The `byoa-setup` skill fills the required values in `.env.byoa`; the rest have safe defaults.

| Env var | Required | Default | What it controls |
|---|---|---|---|
| `BYOA_TOKEN` | yes | — | HS256 token minted by `byoa_token_mint` |
| `BYOA_CHARACTER_ID` | yes | — | Operator's character (matches the token) |
| `BYOA_SHIP_ID` | yes | — | Corp ship pseudo-character_id |
| `BYOA_CLAIM_ENDPOINT_URL` | yes | — | URL of `byoa_session_claim` (e.g. `https://<project>.supabase.co/functions/v1/byoa_session_claim`) |
| `SUBAGENT_BUS_DATABASE_URL` | yes | — | Postgres DSN. Prefer session-mode pooler (port 5432 on Supabase) |
| `BYOA_PROMPT_FILE` | — | — | Path to custom prompt markdown (≤ 8 KB). `--prompt-file` wins |
| `BYOA_POLL_INTERVAL_SECONDS` | — | `5` | Claim polling cadence (dev / idle-loop mode) |
| `BYOA_HEARTBEAT_INTERVAL_SECONDS` | — | `60` | Task-lock heartbeat (must be `< TASK_LOCK_HEARTBEAT_STALE_SECONDS / 2`) |
| `BYOA_AGENT_WAKE_TIMEOUT_SECONDS` | — | `30` | Wake handshake timeout |
| `BYOA_AGENT_IDLE_TEARDOWN_SECONDS` | — | `300` | How long a warm agent stays idle before exiting |

There is no client-side bus transport / channel env var — the BYOA discovers its channel from the claim response.

### Game-operator-side (set on the bot + edge functions)

| Env var | Where | Default | What it controls |
|---|---|---|---|
| `SUBAGENT_BUS_TRANSPORT` | bot | `local` | `pgmq` to enable BYOA |
| `SUBAGENT_BUS_DATABASE_URL` | bot | — | Required when `transport=pgmq` |
| `SUBAGENT_BUS_CHANNEL` | bot | — | Required when `transport=pgmq`; per-deployment value (e.g. `gb_prod`). The bot passes this to `wake_agent` so the BYOA's claim returns it |
| `WAKE_TARGET` | edge fn | `noop` | `noop` (dev / always-on operators), `vercel` / `lambda` (server-spawned single-task). Mirrored to BYOA as `lifecycle_hint` |
| `TASK_LOCK_HEARTBEAT_STALE_SECONDS` | edge fn | `180` | Lock is steal-eligible after this many seconds without a heartbeat |
| `TASK_LOCK_HARD_TTL_MINUTES` | edge fn | `30` | Safety floor regardless of heartbeats |

## Configuring a corp ship as BYOA

One endpoint: `ship_byoa_configure`. The `/byoa-setup` skill drives this for you; the raw HTTP shape is:

```bash
curl -X POST "$SUPABASE_URL/functions/v1/ship_byoa_configure" \
  -H "Authorization: Bearer $ANON_KEY" \
  -H "X-API-Token: $YOUR_USER_JWT" \
  -d '{
    "character_id": "<your character UUID>",
    "ship_id": "<corp ship UUID>",
    "action": "claim",
    "mode": "private"
  }'
```

Other actions: `set_mode` (mode toggle), `clear` (release). Only the current owner can call these.

| Ship state | Who can issue tasks |
|---|---|
| Not BYOA | Any corp member |
| BYOA `shared` | Any corp member |
| BYOA `private` | Only the BYOA owner. Others get `403 byoa_private_not_owner` |

A corp member can always force-cancel via `task_cancel { force: true }`.

## Bus protocol

Every game RPC, lifecycle event, and tool call goes through typed bus messages — defined in [bus_messages.py](../src/gradientbang/pipecat_server/subagents/bus_messages.py). The bundled `TaskAgent` ([task_agent.py](../src/gradientbang/pipecat_server/subagents/task_agent.py)) is the reference implementation.

A BYOA agent needs to handle, at minimum:

- **Inbound**: `BusAgentHelloRequest` (liveness probe), `BusTaskRequest`, `BusTaskCancel`, `BusGameEventMessage`, `BusGameToolCallResponse`
- **Outbound**: `BusByoaPresenceMessage` (process online/offline heartbeat), `BusAgentHelloResponse` (reply `ready=true`), `BusGameToolCallRequest`, `BusTaskFinishNotification`, optional `BusTaskUpdate`

Wake handshake: VoiceAgent sends `BusAgentHelloRequest` and waits up to `BYOA_AGENT_WAKE_TIMEOUT_SECONDS` (default 30s) for the response. Timeout aborts the spawn and releases the lock.

## Lock recovery

| Failure | Recovery |
|---|---|
| Clean disconnect | < 1s (VoiceAgent shutdown hook) |
| Crash / network drop | ~3 min (heartbeat staleness) |
| Wedged but heartbeating | ~30 min (hard TTL) |
| Corp member wants it now | Immediate (`task_cancel { force: true }`) |
