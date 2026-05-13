# BYOA: Setup Guide

> Bring-Your-Own-Agent — run your own task agent for a corporation ship.
> See [byoa.md](byoa.md) for the architecture and roadmap.

## Quickstart (local dev)

The only fully-supported flow today. Run the bot and your BYOA agent side-by-side on the same machine; both speak to a local Supabase.

**Prereqs.** Working dev stack: `npx supabase start --workdir deployment`, `scripts/reset-world.sh` run at least once after migrations, and a game account with a character in a corporation that owns at least one ship.

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

**4. Start the BYOA wake daemon** (separate terminal, auto-loads `./.env.byoa`):

```bash
uv run byoa serve --prompt-file ./prompt.md
```

Configure the local edge-function env with `WAKE_TARGET=http`, `BYOA_WAKE_URL`, `EDGE_API_TOKEN`, and `BYOA_BUS_DATABASE_URL`. When a task starts, `wake_agent` calls the daemon with `Authorization: Bearer $EDGE_API_TOKEN`, the daemon spawns `uv run byoa run` with the session channel, and the spawned BYOA process joins the same PGMQ bus as the player session through the SQL wrappers.

**Rotate tokens.** Re-run `/byoa-setup local --force` to mint a fresh token, then revoke the old one via `byoa_token_revoke`.

## How the discovery flow works

```
voice client    bot / wake                             BYOA process
     │           │                   │                       │
     │ connect──►│ creates session channel                   │
     │           │                                           │
     │           │                                           │
     │           │◄──presence/ready over PGMQ                │
     │ start_task─► local lock + task.start emit             │
     │           │ wake_agent────────► HTTP wake provider────►│ spawns + joins bus
     │           │ BusTaskRequest───────────────────────────►│ runs task
     │           │                   │                       │
```

When a BYOA task starts, the bot calls `wake_agent` with `task_id` and the voice-session channel. `WAKE_TARGET=http` posts the wake payload to the configured provider URL. Local dev points that at `uv run byoa serve`; future `vercel_sandbox` support will use the same runtime env payload.

## Configuration

### BYOA-side (you, the operator)

Read by `ByoaAgentConfig.from_env()` ([src/gradientbang/byoa/config.py](../src/gradientbang/byoa/config.py)) and the CLI. The `byoa-setup` skill fills the required values in `.env.byoa`; the rest have safe defaults.

| Env var | Required | Default | What it controls |
|---|---|---|---|
| `BYOA_TOKEN` | yes | — | HS256 token minted by `byoa_token_mint` |
| `BYOA_CHARACTER_ID` | yes | — | Operator's character (matches the token) |
| `BYOA_SHIP_ID` | yes | — | Corp ship pseudo-character_id |
| `EDGE_API_TOKEN` | local dev | — | Bearer token expected by `uv run byoa serve`; must match the edge-function `EDGE_API_TOKEN` |
| `BYOA_CHANNEL` | run only | — | Voice-session PGMQ channel. Set by wake for spawned processes; only pass manually when using `uv run byoa run` fallback |
| `--bus-database-url` | run only | — | Restricted Postgres DSN. Wake injects `BYOA_BUS_DATABASE_URL`; only pass manually when using `uv run byoa run` fallback |
| `BYOA_PROMPT_FILE` | — | — | Path to custom prompt markdown (≤ 8 KB). `--prompt-file` wins |
| `BYOA_AGENT_WAKE_TIMEOUT_SECONDS` | — | `30` | Wake handshake timeout |
| `BYOA_AGENT_IDLE_TEARDOWN_SECONDS` | — | `300` | How long a warm agent stays idle before exiting |

Do not use the static `SUBAGENT_BUS_CHANNEL` prefix here. BYOA needs the derived per-session channel.

### Game-operator-side (set on the bot + edge functions)

| Env var | Where | Default | What it controls |
|---|---|---|---|
| `SUBAGENT_BUS_TRANSPORT` | bot | `local` | `pgmq` to enable BYOA |
| `SUBAGENT_BUS_DATABASE_URL` | bot | — | Bot bus DSN. BYOA must not receive this DSN |
| `SUBAGENT_BUS_CHANNEL` | bot | — | Required when `transport=pgmq`; per-deployment prefix (e.g. `gb_prod`). The bot derives a per-session channel from this prefix |
| `BYOA_BUS_DATABASE_URL` | edge fn | — | Restricted BYOA bus DSN injected into spawned BYOA runners by wake_agent |
| `BYOA_WAKE_URL` | edge fn | — | HTTP wake provider URL when `WAKE_TARGET=http`; local dev uses `http://host.docker.internal:8765/wake` |
| `EDGE_API_TOKEN` | edge fn + BYOA daemon | — | Trusted edge token; also used as the bearer token between `wake_agent` and the HTTP wake provider |
| `WAKE_TARGET` | edge fn | `noop` | `http` for local/webhook wake, `noop` manual fallback, `vercel_sandbox` reserved |
| `TASK_AGENT_TIMEOUT` | bot | `1800` | Per-task hard upper bound in seconds (bot-side). Bot cancels the task and clears its local ship lock on expiry. BYOA operators cannot override this |

## Configuring a corp ship as BYOA

One endpoint: `ship_byoa_configure`. The `/byoa-setup` skill drives this for you; the raw HTTP shape is:

```bash
curl -X POST "$SUPABASE_URL/functions/v1/ship_byoa_configure" \
  -H "Authorization: Bearer $ANON_KEY" \
  -H "X-API-Token: $YOUR_USER_JWT" \
  -d '{
    "character_id": "<your character UUID>",
    "ship_id": "<corp ship UUID>",
    "action": "claim"
  }'
```

Other action: `clear` (release). Only the current owner can call it.

| Ship state | Who can issue tasks |
|---|---|
| Not BYOA | Any corp member |
| BYOA | Only the BYOA owner. Others get a BYOA-owner-required failure |

A corp member can always force-cancel via `task_cancel { force: true }`.

## Bus protocol

Every game RPC, lifecycle event, and tool call goes through typed bus messages — defined in [bus_messages.py](../src/gradientbang/pipecat_server/subagents/bus_messages.py). The bundled `TaskAgent` ([task_agent.py](../src/gradientbang/pipecat_server/subagents/task_agent.py)) is the reference implementation.

A BYOA agent needs to handle, at minimum:

- **Inbound**: `BusAgentHelloRequest` (liveness probe), `BusTaskRequest`, `BusTaskCancel`, `BusGameEventMessage`, `BusGameToolCallResponse`
- **Outbound**: `BusByoaPresenceMessage` (process online/offline heartbeat), `BusAgentHelloResponse` (reply `ready=true`), `BusGameToolCallRequest`, `BusTaskFinishNotification`, optional `BusTaskUpdate`

Wake handshake: VoiceAgent sends `BusAgentHelloRequest` and waits up to `BYOA_AGENT_WAKE_TIMEOUT_SECONDS` (default 30s) for the response. Timeout aborts the spawn and clears the bot's local ship lock.

## Lock recovery

The ship-task lock is per-bot in memory — there is no DB-persistent lock. The bot's `VoiceAgent._locked_ships` map is the only authority on "ship busy". When a BYOA dies the bot detects it through the `BusByoaPresenceMessage` heartbeat the BYOA broadcasts every 10s; missing beats for ~30s flip the bot's local lock back to idle and a `task.cancel` event is emitted.

| Failure | Recovery |
|---|---|
| Clean disconnect | < 1s (VoiceAgent shutdown hook clears local map) |
| BYOA crash / network drop | ~30s (BYOA presence heartbeat goes stale → bot clears its local lock + emits `task.cancel`) |
| BYOA alive but task hangs | `TASK_AGENT_TIMEOUT` (default 1800s = 30 min); bot cancels regardless of presence |
| Corp member wants it now | `task_cancel { force: true }` emits a cancel event; the owner's bot picks it up and clears its lock |
