# BYOA: Setup Guide

> Bring-Your-Own-Agent — operate a corporation ship with an external agent of your choosing. This guide tracks what's possible *today*; new capabilities land per phase. See [byoa.md](byoa.md) for the architecture roadmap.

## What's available today (Groundwork)

A corp ship has a server-enforced single-task lock and can be claimed as a BYOA ship by any member of its corporation. The bundled in-process TaskAgent already speaks the BYOA contract: server-side acquire before work begins, heartbeats while it runs, release on disconnect.

What you can do right now:

- **Claim a corp ship as your BYOA**. The ship still belongs to the corp; only the task-issuance rules change.
- **Pick a mode**: `private` (only you can issue tasks) or `shared` (any corp member can).
- **Trust the lock**: only one task can run on a ship at a time, even across processes and corp members.
- **Recover gracefully**: heartbeats keep your lock alive; a crashed or disconnected agent loses its lock within ~3 minutes (configurable). Corp members can force-cancel a stuck lock immediately.

What's *not* available yet (lands in later phases):

- Running your own agent process (Phase 3 — operator quickstart).
- Speaking the subagent bus protocol from outside the bundled bot (Phase 1 — typed bus messages).
- Remote-bus transport so the agent can run on a different host (Phase 2 — PGMQ).

Today, every BYOA ship is controlled by the same Python TaskAgent that ships in the bot. Claiming a ship as BYOA changes *who* can issue tasks to it, not *what* runs the task.

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
| `BYOA_TOOL_CALL_TIMEOUT_SECONDS` | `30.0` | Reply timeout for a bus RPC. *Inert until Phase 1.* |
| `BYOA_TASK_REQUEST_TIMEOUT_SECONDS` | `600.0` | Reply timeout for a BusTaskRequest. *Inert until Phase 1.* |
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

| Endpoint | What it does |
|---|---|
| `ship_byoa_configure` | Claim / set_mode / clear BYOA state on a corp ship |
| `task_lifecycle event_type=start` | Acquire the lock + emit `task.start`. Returns `409 ship_busy` or `403 byoa_private_not_owner` on rejection |
| `task_lifecycle event_type=finish` | Release the lock (pair-matched) + emit `task.finish` |
| `task_cancel` | Release the lock + emit `task.cancel`. Add `force: true` to bypass owner/actor check as a corp member |
| `task_heartbeat` | Bulk refresh `task_last_heartbeat_at` for a list of `{ship_id, task_id}` pairs. Mismatched pairs are silent no-ops |
| `list_user_ships`, `corporation_info` | Include the `byoa` and `current_task_actor` blocks in the ship-list payload |

## Roadmap

| Phase | What ships |
|---|---|
| **Groundwork** (this) | Server-side lock, BYOA columns + modes, heartbeat, `ship_byoa_configure`, ship-list payload extension. The bundled TaskAgent now matches the BYOA contract |
| Phase 1 | Typed bus messages for tool calls / lifecycle / corp queries. TaskAgent stops holding `AsyncGameClient` — all edge-function calls go via VoiceAgent's broker over the bus |
| Phase 2 | Optional remote bus transport (PGMQ). An agent can run in a separate process or on a different host |
| Phase 3 | Operator onboarding: BYOA tokens, reference SDK, example agent, quickstart docs. The "run your own agent" deliverable |
