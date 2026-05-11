# BYOA: Setup Guide

> Bring-Your-Own-Agent — operate a corporation ship with an external agent of your choosing. This guide tracks what's possible *today*; new capabilities land per phase. See [byoa.md](byoa.md) for the architecture roadmap.

## What's available today (Groundwork + Phase 1)

A corp ship has a server-enforced single-task lock, can be claimed as a BYOA ship by any member of its corporation, and the bundled in-process TaskAgent now speaks the **finalised bus protocol** that an external BYOA agent will implement in Phase 3. The contract is locked: every game RPC, lifecycle event, and tool call goes through typed bus messages.

What you can do right now:

- **Claim a corp ship as your BYOA**. The ship still belongs to the corp; only the task-issuance rules change.
- **Pick a mode**: `private` (only you can issue tasks) or `shared` (any corp member can).
- **Trust the lock**: only one task can run on a ship at a time, even across processes and corp members.
- **Recover gracefully**: heartbeats keep your lock alive; a crashed or disconnected agent loses its lock within ~3 minutes (configurable). Corp members can force-cancel a stuck lock immediately.
- **Read the bus protocol contract**: every TaskAgent — bundled or BYOA — speaks the same typed bus messages. The bundled `TaskAgent` in [src/gradientbang/pipecat_server/subagents/task_agent.py](../src/gradientbang/pipecat_server/subagents/task_agent.py) is the **reference implementation** of what a Phase 3 BYOA agent will need to do.

What's *not* available yet (lands in later phases):

- Running your own agent process out-of-tree (Phase 3 — operator quickstart + BYOA tokens).
- Remote-bus transport so the agent can run on a different host (Phase 2 — PGMQ).
- The wake URL trigger for cold-start BYOA hosts (Phase 3 — adds an HTTPS webhook before the bus handshake).

Today, every BYOA ship is still controlled by the same Python TaskAgent that ships in the bot. Claiming a ship as BYOA changes *who* can issue tasks to it, not *what* runs the task. Phase 3 closes that loop.

## Configuring a corp ship as BYOA

There's one endpoint: `ship_byoa_configure`. Authenticate as a corp member of the ship's corporation.

```bash
# Claim a corp ship for yourself in private mode (only you can issue tasks)
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

Switch modes (only the current owner can):

```json
{"action": "set_mode", "mode": "shared"}
```

Release the ship (only the current owner can):

```json
{"action": "clear"}
```

Hard rules:

- You can only claim a ship *for yourself*. There's no field for assigning ownership to someone else.
- Re-configuring is rejected while a task is in flight on the ship (`409 ship_busy`) — finish or cancel the task first.
- Non-corp-members are rejected with `403`.
- Clearing back to "not BYOA" restores the default: any corp member can issue tasks, just as before BYOA existed.

A successful change emits a `ship.byoa_configured` event to the whole corporation.

## Mode semantics

| Ship state | Who can issue tasks |
|---|---|
| Not BYOA (default) | Any corp member |
| BYOA `shared` | Any corp member (informational only — the UI shows it as "Alice's BYOA, shared") |
| BYOA `private` | Only the BYOA owner. Other corp members get `403 byoa_private_not_owner` from `task_lifecycle event_type=start` and from `task_cancel` |

A corp member can always *force-cancel* a task on a corp ship via `task_cancel { force: true }`, even on a BYOA-private ship. This is the escape hatch for stuck locks; it bypasses the owner check and emits a `task.cancel` event for the displaced actor.

## The bus protocol (Phase 1)

TaskAgent no longer holds an `AsyncGameClient`. Every game RPC — tool calls, lifecycle events, corp queries, combat doctrine — flows through typed bus messages to VoiceAgent's broker. **This is the contract a Phase 3 external BYOA agent will implement.**

Messages a BYOA agent will need to handle (defined in [src/gradientbang/pipecat_server/subagents/bus_messages.py](../src/gradientbang/pipecat_server/subagents/bus_messages.py)):

| Direction | Message | Purpose |
|---|---|---|
| Inbound | `BusAgentHelloRequest` | Liveness probe from VoiceAgent. Respond `ready=true` once your agent is up and ready to accept work. |
| Outbound | `BusAgentHelloResponse` | Reply to the hello probe. Carries `protocol_version` (currently `1`) for forward-compat. |
| Inbound | `BusTaskRequest` | A new task to run. Payload includes `task_description`, `task_metadata`, and optional `context`. |
| Inbound | `BusTaskCancel` | Cancellation signal — tear down in-flight RPCs, emit a finish notification with `status="cancelled"`. |
| Inbound | `BusGameEventMessage` | Game events delivered by VoiceAgent's EventRelay (movement complete, combat round, etc.). |
| Inbound | `BusGameToolCallResponse` | Reply to an outbound tool call. |
| Inbound | `BusCombatStrategyResponse` | Reply to a combat-strategy fetch. |
| Inbound | `BusCorporationQueryResponse` | Reply to a corp-query request. |
| Outbound | `BusGameToolCallRequest` | Invoke any game tool by name. Covers all ~31 game tools as a uniform `tool_name + args` shape. |
| Outbound | `BusCombatStrategyRequest` | Fetch the active ship's combat doctrine before combat. |
| Outbound | `BusCorporationQueryRequest` | Read corporation data (`list` / `info` / `my`). |
| Outbound | `BusTaskFinishNotification` | Tell the broker the task is done — triggers server-side lock release. |
| Outbound | `BusTaskUpdate` | Optional progress reports back to the human. |

All payload fields are plain JSON-serializable. The same messages will travel over the in-process bus today and the upstream `PgmqBus` in Phase 2.

### The wake-up handshake

Before any `BusTaskRequest` lands, VoiceAgent sends a `BusAgentHelloRequest` and waits up to `agent_wake_timeout_seconds` (default **30s**) for the matching `BusAgentHelloResponse`. The handshake is universal:

- **In-process TaskAgent**: responds within milliseconds after `build_pipeline` initialises the LLM context.
- **Remote BYOA on Vercel Sandbox / Lambda**: responds after the cold-start completes (typically 3-10s).

A `ready=false` response or a timeout aborts the spawn — the server-side lock is released and the LLM gets a user-facing error. This means a slow agent doesn't silently swallow tasks.

### Idle teardown

A BYOA agent that stays warm but has no work eventually frees its ship slot. The bundled TaskAgent arms a timer for `agent_idle_teardown_seconds` (default **300s = 5 min**) on every task completion / cancellation. The timer is reset on incoming activity; when it fires the agent emits `BusEndAgentMessage` to itself and exits. Player-ship agents don't get the timer (they're reused across tasks); corp-ship agents and (future) BYOA agents do.

## How the lock works

The lock lives on `ship_instances.current_task_id`. The atomic acquire happens inside `task_lifecycle event_type=start`:

1. **Idle** → acquire succeeds, returns `200`.
2. **Held by a live task** → returns `409 ship_busy` with the truncated identity of the holder.
3. **Held but stale** → acquire succeeds *by stealing*, and emits a `task.cancel(cancelled_by: 'stale_lock')` for the displaced actor.

Three stale-recovery layers, in priority order:

| Failure | Recovery time | Mechanism |
|---|---|---|
| Clean disconnect (tab close, app quit) | < 1s | VoiceAgent shutdown hook releases server-side |
| Process crash / network drop | ~3 min | Heartbeat staleness — 3 missed beats → steal-eligible |
| Wedged process still heartbeating | ~30 min | Hard TTL on `task_started_at` regardless of heartbeats |
| Corp member wants the ship now | Immediate | `task_cancel(force=true)` |

While a TaskAgent holds a lock, the VoiceAgent that spawned it posts `task_heartbeat` every 60 seconds with the held `(ship_id, task_id)` pairs. A heartbeat for a stale pair is a silent no-op — the server only refreshes rows whose current lock matches.

## Configuration

Two distinct surfaces. **Do not mix them up** — an agent heartbeating every 200s while the server's stale window is 180s will lose its lock to the next acquire.

### Server-side (game operator only)

Set these on the edge function deploy. BYOA operators cannot override them; only the team running the game server can.

| Env var | Default | What it controls |
|---|---|---|
| `TASK_LOCK_HEARTBEAT_STALE_SECONDS` | `180` | Lock is steal-eligible after this many seconds without a heartbeat |
| `TASK_LOCK_HARD_TTL_MINUTES` | `30` | Safety floor: lock is steal-eligible regardless of heartbeats after this long |
| `TASK_LOCK_BACKFILL_WINDOW_MINUTES` | `60` | One-time migration backfill window for in-flight tasks |

### Agent-side (you, the BYOA operator)

The bundled bot reads `ByoaAgentConfig.from_env()` at startup; an external BYOA agent can construct the dataclass directly. See [src/gradientbang/byoa/config.py](../src/gradientbang/byoa/config.py).

| Env var | Default | What it controls |
|---|---|---|
| `BYOA_HEARTBEAT_INTERVAL_SECONDS` | `60` | How often to post `task_heartbeat`. Must be **strictly less than** `TASK_LOCK_HEARTBEAT_STALE_SECONDS / 2` |
| `BYOA_MAX_CONCURRENT_TASKS` | `4` | Per-agent ceiling on concurrent tasks (server also enforces one per ship) |
| `BYOA_TOOL_CALL_TIMEOUT_SECONDS` | `30.0` | Reply timeout for an outbound `BusGameToolCallRequest` (any tool call over the bus) |
| `BYOA_TASK_REQUEST_TIMEOUT_SECONDS` | `600.0` | Reply timeout for an inbound `BusTaskRequest` (overall task ceiling) |
| `BYOA_AGENT_WAKE_TIMEOUT_SECONDS` | `30.0` | How long VoiceAgent waits for a `BusAgentHelloResponse` after dispatching the wake-up handshake. Generous enough to absorb a Vercel-Sandbox-class cold start |
| `BYOA_AGENT_IDLE_TEARDOWN_SECONDS` | `300.0` | How long a warm agent stays idle before tearing itself down (sends `BusEndAgentMessage` to itself, frees its ship slot). Disabled for player-ship agents — they're reused across tasks |
| `BYOA_SERVER_LOCK_STALE_SECONDS` | `180` | Your understanding of the server's stale window. Mismatch with the actual server value is a startup warning |
| `BYOA_SERVER_LOCK_HARD_TTL_MINUTES` | `30` | Your understanding of the server's hard TTL |

`ByoaAgentConfig.validate_heartbeat_against_server()` returns a warning string when the interval is too slow; the bot logs this at startup.

## Ship-list payload

`list_user_ships` and `corporation_info` now surface a `byoa` block on each ship:

```json
{
  "ship_id": "…",
  "current_task_id": "…",
  "current_task_actor": {
    "character_id_prefix": "0123456789ab",
    "character_name": "Alice"
  },
  "byoa": {
    "owner_character_id_prefix": "0123456789ab",
    "owner_character_name": "Alice",
    "mode": "private"
  }
}
```

`byoa` is `null` on non-BYOA ships. `current_task_actor` is `null` when the ship is idle. **All character IDs in ship-list payloads are truncated to 12 hex chars** (matching the existing `task_id_prefix` convention) — full character UUIDs are never sent in these payloads.

## Endpoint reference

These are the edge functions a *VoiceAgent broker* uses. A BYOA agent itself never calls them directly — its only interface to the game is the bus protocol above. The broker translates inbound `BusGameToolCallRequest`s into the right edge-function calls.

| Endpoint | What it does |
|---|---|
| `ship_byoa_configure` | Claim / set_mode / clear BYOA state on a corp ship |
| `task_lifecycle event_type=start` | Acquire the lock + emit `task.start`. Returns `409 ship_busy` or `403 byoa_private_not_owner` on rejection |
| `task_lifecycle event_type=finish` | Release the lock (pair-matched) + emit `task.finish`. Called by the broker on receipt of `BusTaskFinishNotification` |
| `task_cancel` | Release the lock + emit `task.cancel`. Add `force: true` to bypass owner/actor check as a corp member |
| `task_heartbeat` | Bulk refresh `task_last_heartbeat_at` for a list of `{ship_id, task_id}` pairs. Mismatched pairs are silent no-ops |
| `list_user_ships`, `corporation_info` | Include the `byoa` and `current_task_actor` blocks in the ship-list payload |

## Roadmap

| Phase | Status | What ships |
|---|---|---|
| **Groundwork** | ✅ Shipped | Server-side lock, BYOA columns + modes, heartbeat, `ship_byoa_configure`, ship-list payload extension. The bundled TaskAgent claims the BYOA lock semantics |
| **Phase 1** | ✅ Shipped | Typed bus messages for tool calls / lifecycle / corp queries / wake-up handshake. TaskAgent drops `AsyncGameClient` — every game RPC goes via VoiceAgent's broker over the bus. Idle teardown timer for warm agents. **The bundled TaskAgent is the BYOA contract reference implementation** |
| Phase 2 | 🔜 Planned | Optional remote bus transport (PGMQ). An agent can run in a separate process or on a different host with no code changes |
| Phase 3 | 🔜 Planned | Operator onboarding: BYOA tokens, wake URL trigger, reference SDK, example agent, quickstart docs. The "run your own agent" deliverable |
