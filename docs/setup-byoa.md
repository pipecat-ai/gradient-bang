# BYOA: Setup Guide

> Bring-Your-Own-Agent — run your own task agent for a corporation ship.
> See [byoa.md](byoa.md) for the architecture and roadmap.

## Quickstart (local, always-on)

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

You should see `bus.byoa_pgmq_initialized` then the agent advertising itself on the bus as `byoa_<ship_id>`. Issue a task from the voice client — the bot publishes it over PGMQ; your agent runs it.

**Rotate tokens.** Re-run `/byoa-setup local --force` to mint a fresh token, then revoke the old one via `byoa_token_revoke`.

## Production wake flow (stub)

Sleep-on-idle deployments (Vercel Sandbox, Lambda, etc.) will need a cold-start signal so the agent is on the bus by the time a task lands. The bot calls a server-side `wake_agent` edge function before each BYOA task dispatch when `BYOA_WAKE_ENABLED=true` (default `false`).

- Today `wake_agent` is a stub: it logs and returns 200.
- Future versions route to your chosen sandbox; operators won't author the wake mechanism.
- For local always-on agents, leave `BYOA_WAKE_ENABLED=false` — the bot dispatches straight to the bus.

## Configuration

### Bus transport (game operator, set on the bot)

| Env var | Default | What it controls |
|---|---|---|
| `SUBAGENT_BUS_TRANSPORT` | `local` | `local` → in-process `AsyncQueueBus`; `pgmq` → upstream `PgmqBus` over Postgres |
| `SUBAGENT_BUS_DATABASE_URL` | — | **Required** when transport=`pgmq`. Prefer the session-mode pooler (port 5432) on managed Postgres |
| `SUBAGENT_BUS_CHANNEL` | — | **Required** when transport=`pgmq`. Per-deployment value (e.g. `gb_prod`, `gb_dev_jon`); BYOA agents must match |
| `BYOA_WAKE_ENABLED` | `false` | When `true`, the bot calls the `wake_agent` endpoint before each BYOA dispatch |

Local PGMQ example:

```bash
SUBAGENT_BUS_TRANSPORT=pgmq
SUBAGENT_BUS_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
SUBAGENT_BUS_CHANNEL=gb_dev_local
```

### Lock + heartbeat (game operator, on edge functions)

| Env var | Default | What it controls |
|---|---|---|
| `TASK_LOCK_HEARTBEAT_STALE_SECONDS` | `180` | Lock is steal-eligible after this many seconds without a heartbeat |
| `TASK_LOCK_HARD_TTL_MINUTES` | `30` | Safety floor regardless of heartbeats |

### Agent-side (you, the BYOA operator)

Read by `ByoaAgentConfig.from_env()` ([src/gradientbang/byoa/config.py](../src/gradientbang/byoa/config.py)). Defaults are sensible; override only when you need to.

| Env var | Default | What it controls |
|---|---|---|
| `BYOA_HEARTBEAT_INTERVAL_SECONDS` | `60` | How often to post `task_heartbeat`. Must be **< `TASK_LOCK_HEARTBEAT_STALE_SECONDS / 2`** |
| `BYOA_MAX_CONCURRENT_TASKS` | `4` | Per-agent ceiling (server also enforces one per ship) |
| `BYOA_TOOL_CALL_TIMEOUT_SECONDS` | `30` | Reply timeout on outbound tool calls |
| `BYOA_TASK_REQUEST_TIMEOUT_SECONDS` | `600` | Overall task ceiling |
| `BYOA_AGENT_WAKE_TIMEOUT_SECONDS` | `30` | How long VoiceAgent waits for `BusAgentHelloResponse` |
| `BYOA_AGENT_IDLE_TEARDOWN_SECONDS` | `300` | How long a warm agent stays idle before exiting |

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
- **Outbound**: `BusAgentHelloResponse` (reply `ready=true`), `BusGameToolCallRequest`, `BusTaskFinishNotification`, optional `BusTaskUpdate`

Wake handshake: VoiceAgent sends `BusAgentHelloRequest` and waits up to `BYOA_AGENT_WAKE_TIMEOUT_SECONDS` (default 30s) for the response. Timeout aborts the spawn and releases the lock.

## Lock recovery

| Failure | Recovery |
|---|---|
| Clean disconnect | < 1s (VoiceAgent shutdown hook) |
| Crash / network drop | ~3 min (heartbeat staleness) |
| Wedged but heartbeating | ~30 min (hard TTL) |
| Corp member wants it now | Immediate (`task_cancel { force: true }`) |
