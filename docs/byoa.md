# BYOA: Architecture & Migration Roadmap

> Bring-Your-Own-Agent: an external operator runs their own LLM-driven agent that controls a corporation ship by speaking the Gradient Bang subagent bus protocol.

## Goal

A BYOA agent is a standalone process — Python, JS, anything — that:

1. Connects to the subagent bus.
2. Listens for `BusTaskRequest` messages addressed to it.
3. Receives game events as `BusGameEventMessage`.
4. For any edge-function call (move, trade, query, lifecycle), sends a typed request over the bus to **VoiceAgent's broker** and awaits the typed response.

Critically, a BYOA agent **never** touches `AsyncGameClient`, never makes a Supabase HTTP request, never sees a player JWT. The bus is its only interface to the game. VoiceAgent's broker is the sole edge-function ingress for the agent ecosystem.

The in-process TaskAgent that ships today is the **specification** for what a BYOA agent must implement. Make TaskAgent self-contained over the bus, and the BYOA contract follows for free.

## What 0.4.1 already gave us

Released to `main` as the foundation for this work:

- **Pluggable game-event delivery** — `EventAdapter` protocol in [src/gradientbang/adapters/events/base.py](../src/gradientbang/adapters/events/base.py); `polling` and `pubsub` implementations selected by `EVENT_TRANSPORT` env via [src/gradientbang/adapters/events/factory.py](../src/gradientbang/adapters/events/factory.py).
- **PGMQ infrastructure** in Supabase — per-character queues, `subscribe_my_events()` / `pgmq_publish()` SECURITY DEFINER RPCs, dual-write of game events, HS256 internal-token auth. See [deployment/supabase/migrations/20260505000000_pubsub_and_broadcasts.sql](../deployment/supabase/migrations/20260505000000_pubsub_and_broadcasts.sql).
- **Reserved BYOA auth context** at [deployment/supabase/functions/_shared/auth.ts:103-120](../deployment/supabase/functions/_shared/auth.ts#L103-L120). Predicate `can_user_access_character` already in place.
- **Pipecat 1.0 + `pipecat-ai-subagents`** — injectable `AgentBus` at `AgentRunner.__init__(bus=...)`. Default `AsyncQueueBus` (asyncio.Queue, in-process). Custom adapters work today.

What 0.4.1 did not do: the **control plane** (TaskAgent ↔ VoiceAgent tool calls, lifecycle, doctrine, corp queries) is still in-process. Server-side ship locking doesn't exist. BYOA columns on `ship_instances` don't exist. This roadmap closes those gaps.

---

# Status

| Phase | Status | What ships |
|---|---|---|
| **Groundwork** | ✅ **Shipped** (this PR) | Server-side ship lock, BYOA columns + modes, heartbeat, `ship_byoa_configure`, access control, ship-list payload, VoiceAgent pre-spawn acquire + heartbeat + disconnect release, `ByoaAgentConfig`, client BYOA status popover |
| Phase 1 — TaskAgent self-contained over the bus | Planned | Typed bus messages, broker in VoiceAgent, TaskAgent drops `AsyncGameClient` |
| Phase 2 — Optional remote subagent bus | Planned | `make_subagent_bus()` factory, PGMQ adapter, transport-pluggable |
| Phase 3 — BYOA operator contract | Planned | Token issuance, reference SDK, operator quickstart, hardening |

Concrete Groundwork deliverables (all in this PR):

- Migration: [20260512000000_ship_task_lock_and_byoa.sql](../deployment/supabase/migrations/20260512000000_ship_task_lock_and_byoa.sql) — six new columns on `ship_instances`, partial unique index on `current_task_id`, backfill, four RPCs (`acquire_ship_task_lock`, `release_ship_task_lock`, `force_release_ship_task_lock`, `refresh_ship_task_heartbeats`).
- Edge functions: [task_heartbeat](../deployment/supabase/functions/task_heartbeat/index.ts), [ship_byoa_configure](../deployment/supabase/functions/ship_byoa_configure/index.ts); modified [task_lifecycle](../deployment/supabase/functions/task_lifecycle/index.ts) (atomic acquire on start, BYOA private check, stolen-lock cancel emit), [task_cancel](../deployment/supabase/functions/task_cancel/index.ts) (atomic release, `force=true` corp-member bypass, BYOA private restriction), [_shared/corporations.ts](../deployment/supabase/functions/_shared/corporations.ts) + [list_user_ships](../deployment/supabase/functions/list_user_ships/index.ts) (truncated `current_task_actor` + `byoa` blocks), [_shared/tasks.ts](../deployment/supabase/functions/_shared/tasks.ts) (column read).
- Bot: [src/gradientbang/byoa/config.py](../src/gradientbang/byoa/config.py) (`ByoaAgentConfig`), [voice_agent.py](../src/gradientbang/pipecat_server/subagents/voice_agent.py) (pre-spawn server acquire on both spawn and reuse paths, lazy heartbeat task, cancel-before-release ordering, server-side release on disconnect, `_dispatch_task_with_id` so both paths share the same pinned task_id), [task_agent.py](../src/gradientbang/pipecat_server/subagents/task_agent.py) (drop redundant `task.start` emit), [supabase_client.py](../src/gradientbang/utils/supabase_client.py) + [api_client.py](../src/gradientbang/utils/api_client.py) (`task_heartbeat`, `task_cancel(force=True)`, `RPCError.body`).
- Tests: Deno [ship_task_lock_test.ts](../deployment/supabase/functions/tests/ship_task_lock_test.ts), [byoa_access_test.ts](../deployment/supabase/functions/tests/byoa_access_test.ts); Python [tests/unit/test_byoa_config.py](../tests/unit/test_byoa_config.py) + extensions to [test_voice_agent.py](../tests/unit/test_voice_agent.py), [test_voice_relay_integration.py](../tests/unit/test_voice_relay_integration.py), [test_task_agent_integration.py](../tests/unit/test_task_agent_integration.py).
- Docs: [docs/setup-byoa.md](setup-byoa.md) (operator guide).
- Client: BYOA status popover on each corp ship card in [client/app/src/components/ShipStatusPopover.tsx](../client/app/src/components/ShipStatusPopover.tsx).

# Phases

## User-facing documentation (process)

After each phase ships, update [docs/setup-byoa.md](setup-byoa.md) — a user-facing README written in operator language that explains what's possible at the current phase. Groundwork seeds it with the ship-lock semantics and BYOA columns; Phase 1 adds the bus protocol surface; Phase 2 adds the local/remote transport choice; Phase 3 turns it into a true quickstart for external operators. The doc grows incrementally with the system rather than being written at the end.

## Groundwork — Server-side ship lock, BYOA columns, heartbeat ✅ Shipped

**Goal:** make the data model and edge functions BYOA-ready, without yet changing how the in-process agents talk to each other. Independently shippable.

> **Status:** complete. The sections below describe what was built; file pointers above link to the actual implementation. Behaviour matches the original spec; one minor refinement during implementation — VoiceAgent's reuse path acquires the server lock *before* dispatching to the idle TaskAgent (via a new `_dispatch_task_with_id` helper that lets both spawn paths pin the same `framework_task_id`), so a TaskAgent never starts work for a task whose lock isn't yet held.

### Schema (one migration)

[deployment/supabase/migrations/20260512000000_ship_task_lock_and_byoa.sql](../deployment/supabase/migrations/20260512000000_ship_task_lock_and_byoa.sql) (new):

```sql
ALTER TABLE ship_instances
  ADD COLUMN current_task_id          UUID NULL,
  ADD COLUMN task_started_at          TIMESTAMPTZ NULL,
  ADD COLUMN task_actor_character_id  UUID NULL,
  ADD COLUMN task_last_heartbeat_at   TIMESTAMPTZ NULL,
  ADD COLUMN byoa_owner_character_id  UUID NULL,
  ADD COLUMN byoa_mode                TEXT NOT NULL DEFAULT 'private'
    CHECK (byoa_mode IN ('private', 'shared'));

CREATE UNIQUE INDEX ship_instances_current_task_id_uniq
  ON ship_instances(current_task_id) WHERE current_task_id IS NOT NULL;

CREATE INDEX ship_instances_task_last_heartbeat_idx
  ON ship_instances(task_last_heartbeat_at) WHERE task_last_heartbeat_at IS NOT NULL;
```

`byoa_owner_character_id IS NOT NULL` is the canonical "is BYOA" signal. `byoa_mode` is inert when the owner is null. The same migration includes a backfill that scans recent `task.start` events for in-flight tasks and populates the lock columns so the cutover doesn't lose state, plus the `refresh_ship_task_heartbeats(pairs jsonb)` SQL helper used by the heartbeat endpoint.

### Server-side ship lock

The "lock" is an atomic UPDATE on the new columns. Acquire happens at `task_lifecycle event_type=start`:

```sql
-- Steal-eligible when:
--   no current lock                                  -- idle
--   OR no heartbeat in 3 min                          -- holder dropped
--   OR lock older than 30 min regardless of beats    -- hard TTL paranoia
UPDATE ship_instances
SET current_task_id        = $task_id,
    task_started_at        = NOW(),
    task_last_heartbeat_at = NOW(),
    task_actor_character_id = $actor_character_id
WHERE ship_id = $ship_id
  AND (
    current_task_id IS NULL
    OR task_last_heartbeat_at < NOW() - INTERVAL '3 minutes'
    OR task_started_at        < NOW() - INTERVAL '30 minutes'
  )
RETURNING current_task_id, task_started_at, task_actor_character_id;
```

If 0 rows: return **HTTP 409 `ship_busy`** with the current holder's truncated info. If 1 row and a previous task was stolen (stale), emit `task.cancel` with `cancelled_by: 'stale_lock'` for the displaced actor.

Release on `task_lifecycle event_type=finish` and on `task_cancel`: atomic UPDATE clearing the columns where `current_task_id = $task_id`. 0 rows affected is fine (idempotent).

### BYOA access control

Checked in `task_lifecycle event_type=start` after ship resolution, before the atomic acquire:

| Ship state | Who can start a task |
|---|---|
| Not a BYOA ship (`byoa_owner_character_id IS NULL`) | Any corp member (unchanged) |
| BYOA `shared` | Any corp member |
| BYOA `private` | Only `actor_character_id = byoa_owner_character_id`. Others get **HTTP 403 `byoa_private_not_owner`** |

A new edge function `ship_byoa_configure` lets a corp member claim a corp ship as their BYOA (self-only — can't assign someone else as owner), toggle the mode, or clear BYOA status. Refuses to clear or reassign while `current_task_id IS NOT NULL`.

### Stale-lock recovery (four layers, in priority order)

| Failure mode | Recovery time | Mechanism |
|---|---|---|
| Clean tab close / app quit | < 1s | **Layer 1** — VoiceAgent shutdown hook calls server `task_cancel` for every held lock |
| Process crash / network drop / VPN flap | ~3 min | **Layer 2** — heartbeat-driven staleness. VoiceAgent bulk-posts `task_heartbeat` every 60s; 3 missed beats = lock is steal-eligible at next acquire |
| Stuck process still heartbeating | ~30 min | **Layer 3** — hard TTL on `task_started_at` regardless of beats. Paranoia floor |
| Corp member wants the ship now | Immediate | **Layer 4** — `task_cancel(force=true)`. Any corp member can release the lock; emits `task.cancel` for the displaced actor |

The acquire predicate combines L2 and L3 in one atomic UPDATE. Windows are env-configurable (`TASK_LOCK_HEARTBEAT_STALE_SECONDS=180`, `TASK_LOCK_HARD_TTL_MINUTES=30`).

Heartbeat endpoint: new [task_heartbeat/index.ts](../deployment/supabase/functions/task_heartbeat/index.ts). One request body carries a list of `{ship_id, task_id}` pairs; the SECURITY DEFINER SQL helper bulk-updates `task_last_heartbeat_at = NOW()` where the pair matches the current lock. Mismatched pairs are silently no-op (lock was released or stolen).

### Edge-function payload changes

[deployment/supabase/functions/_shared/tasks.ts](../deployment/supabase/functions/_shared/tasks.ts) — `fetchActiveTaskIdsByShip` switches from event-table scanning (~150 lines) to a direct SELECT on `ship_instances.current_task_id`. Free perf win for `list_user_ships`, `corporation_info`, `combat_finalization`.

Ship-list payloads (`corporation_info`, `list_user_ships`) gain two blocks per ship, with **all player IDs truncated to 12 hex chars** (matching the existing `task_id_prefix` convention from [20260119000000_add_task_id_prefix_index.sql:21](../deployment/supabase/migrations/20260119000000_add_task_id_prefix_index.sql#L21)):

```ts
{
  // ... existing fields ...
  current_task_id: string | null,                  // full UUID, unchanged
  current_task_actor: {
    character_id_prefix: string,                   // 12 chars
    character_name: string | null,
  } | null,
  byoa: {
    owner_character_id_prefix: string,             // 12 chars
    owner_character_name: string | null,
    mode: 'private' | 'shared',
  } | null,                                         // null when not a BYOA ship
}
```

Full character UUIDs **never** appear in any ship-list payload.

### Local code cleanup in VoiceAgent

[src/gradientbang/pipecat_server/subagents/voice_agent.py](../src/gradientbang/pipecat_server/subagents/voice_agent.py):

- `_handle_start_task` calls server `task_lifecycle(event_type="start", ...)` *before* spawning. On 409, surface a user-facing error like "Ship busy — currently used by Alice." On 403 (BYOA private), surface "Bob's BYOA ship is private."
- `_locked_ships` set (line 146) is **repositioned**: still used for in-process steer routing ("do I have a child for this ship?"), but the cross-process mutex is now server-side. Same-VoiceAgent rapid re-tasking still routes to steer (unchanged); cross-process / cross-corp races arbitrate server-side.
- Disconnect/shutdown path (lines 2230-2236) — for each held lock, call `task_cancel` server-side before clearing the local set. Today this only clears the local set; the lock would leak on disconnect.
- A new background asyncio task posts `task_heartbeat` every 60s for the full set of held locks. Starts lazily on first acquire; exits when `_locked_ships` becomes empty.

[src/gradientbang/pipecat_server/subagents/task_agent.py](../src/gradientbang/pipecat_server/subagents/task_agent.py):

- Stop emitting `task.start` directly (lines 359-364). VoiceAgent already acquired it server-side; TaskAgent's start emit becomes redundant.
- Still emits `task.finish` directly via `_game_client.task_lifecycle("finish", ...)` — moves to the bus in Phase 1.

### Test coverage

- New `deployment/supabase/functions/tests/ship_task_lock_test.ts`: concurrent acquire (one wins, one 409); release-by-task-id; Layer 2 staleness; Layer 3 hard TTL; stolen-lock `task.cancel` notification; Layer 4 force cancel; backfill correctness.
- New `deployment/supabase/functions/tests/byoa_access_test.ts`: private blocks non-owner, shared allows corp members, `ship_byoa_configure` happy paths and rejections.
- Extend ship-list tests (`corporation_info_test.ts`, `list_user_ships_test.ts`): `byoa` block shape, `current_task_actor` shape, exactly 12-char prefixes, regex assertion that no full UUIDs leak.
- Extend `tests/unit/test_voice_agent.py`: 200/409/403 paths; disconnect releases server-side; heartbeat task starts and stops cleanly.
- New `tests/integration/test_server_ship_lock.py`: two real VoiceAgent-like clients against local Supabase. Covers concurrent acquire, heartbeat stale recovery, clean disconnect release, BYOA private rejection.

---

## Configuration

BYOA-adjacent tunables live in two distinct surfaces. Mixing them up is a source of subtle bugs (e.g. an agent heartbeats every 200s thinking the server allows 300s, but the server steals every lock at 180s).

### Server-side (game operator)

Enforced inside edge functions and Postgres. BYOA operators cannot override these — only the team running the game server can.

| Env var | Default | What it controls |
|---|---|---|
| `TASK_LOCK_HEARTBEAT_STALE_SECONDS` | 180 | Lock is steal-eligible if last heartbeat older than this. Layer 2 of stale recovery. |
| `TASK_LOCK_HARD_TTL_MINUTES` | 30 | Lock is steal-eligible regardless of heartbeats if started before this. Layer 3 of stale recovery. |
| `TASK_LOCK_BACKFILL_WINDOW_MINUTES` | 60 | Migration-time backfill lookback for in-flight tasks. |

Documented alongside the existing edge-function env in `env.supabase.example`.

### Agent-side (BYOA operator or game operator)

Lives in [src/gradientbang/byoa/config.py](../src/gradientbang/byoa/config.py) as a frozen dataclass. Defaults are safe for the bundled in-process TaskAgent. External BYOA operators construct their own instance or use `ByoaAgentConfig.from_env()`.

```python
@dataclass(frozen=True)
class ByoaAgentConfig:
    heartbeat_interval_seconds: int = 60               # Must be < server stale / 2
    max_concurrent_tasks: int = 4                       # Per-agent ceiling
    tool_call_timeout_seconds: float = 30.0             # Phase 1 — bus RPC reply timeout
    task_request_timeout_seconds: float = 600.0         # Phase 1 — BusTaskRequest reply timeout
    server_lock_stale_seconds_expected: int = 180       # Informational; mismatch logged at startup
    server_lock_hard_ttl_minutes_expected: int = 30     # Informational
```

Env override prefix is `BYOA_` (e.g. `BYOA_HEARTBEAT_INTERVAL_SECONDS=90`). Mismatches between `server_lock_*_expected` and the actual server config are warning-level log lines — the agent doesn't error out, it just observes.

In Groundwork, only `heartbeat_interval_seconds` and the `server_lock_*_expected` fields are live. The Phase 1 fields (`tool_call_timeout_seconds`, `task_request_timeout_seconds`) are declared but inert until the bus RPC layer lands.

---

## Phase 1 — TaskAgent self-contained over the bus 🔜 Planned

**Goal:** TaskAgent stops holding `AsyncGameClient`. All tool calls, doctrine fetches, corp queries, and the task-finish notification flow over the bus to VoiceAgent's broker. After this phase, the in-process TaskAgent is the BYOA contract.

### Why typed bus messages, not a generic RPC layer

- **Self-documenting wire format.** A BYOA implementor reads [bus_messages.py](../src/gradientbang/pipecat_server/subagents/bus_messages.py) and sees exactly what to send and receive. No `AsyncGameClient` introspection required.
- **No leaky abstraction.** A generic `BusGameRpcRequest(method, kwargs)` would implicitly expose every method on `AsyncGameClient` including `_request`. Typed messages let the broker validate against an explicit allow-list.
- **Cleaner evolution.** Each message type evolves on its own schema; tool changes don't cascade through a generic dispatcher.
- **Forward-compat for Phase 2 (PGMQ).** Plain dataclasses with JSON-serializable fields are PGMQ-ready as-is.

### Correlation helper

[src/gradientbang/pipecat_server/subagents/bus_correlation.py](../src/gradientbang/pipecat_server/subagents/bus_correlation.py) (new, ~30 lines):

```python
class PendingRequests:
    """Maps correlation_id → Future for matching request/response pairs."""
    async def issue(self, correlation_id: str, timeout: float) -> asyncio.Future: ...
    def resolve(self, correlation_id: str, result: Any) -> None: ...
    def reject(self, correlation_id: str, error: str) -> None: ...
    def cancel_all(self, reason: str) -> None: ...
```

No RPC abstraction — just future-tracking. Each call site builds and sends its specific typed message and awaits its specific response future.

### New typed bus messages

Extend [src/gradientbang/pipecat_server/subagents/bus_messages.py](../src/gradientbang/pipecat_server/subagents/bus_messages.py). All fields plain JSON-serializable.

**Tool-call pair** (covers all 31 tools — uniform shape: name + args → dict):
- `BusGameToolCallRequest(source, target, correlation_id, tool_name, args, character_id, actor_character_id)`
- `BusGameToolCallResponse(source, target, correlation_id, result, error)`

**Task-finish notification** (fire-and-forget; triggers server-side lock release):
- `BusTaskFinishNotification(source, target, character_id, task_id, status, summary)`

**Combat doctrine** (one-off):
- `BusCombatStrategyRequest(source, target, correlation_id, character_id)`
- `BusCombatStrategyResponse(source, target, correlation_id, strategy, error)`

**Corporation queries** (the three `_request(...)` paths in `_tool_corporation_info`):
- `BusCorporationQueryRequest(source, target, correlation_id, query_type, character_id, corp_id)`
- `BusCorporationQueryResponse(source, target, correlation_id, result, error)`

There is no `BusTaskStartRequest` — Groundwork moved task.start emission to VoiceAgent's pre-spawn flow.

### TaskAgent edits

[src/gradientbang/pipecat_server/subagents/task_agent.py](../src/gradientbang/pipecat_server/subagents/task_agent.py):

| Today (file:line) | After Phase 1 |
|---|---|
| `__init__` takes `game_client: AsyncGameClient` (line 239) | Drop the parameter; init `self._pending = PendingRequests()` |
| `_call_game()` does `getattr(self._game_client, method)(...)` (line 1611) | Build `BusGameToolCallRequest`, send, await response, raise on error |
| `_tool_corporation_info` calls `_game_client._request(...)` (line 1640) | Map `list_all`/`corp_id`/default to `BusCorporationQueryRequest(query_type=...)` |
| `_tool_ship_definitions` (line 1654) | Route through standard `BusGameToolCallRequest` |
| `combat_get_strategy()` direct call (line 757) | `BusCombatStrategyRequest` |
| `task_lifecycle("finish", ...)` (lines 403-409) | `BusTaskFinishNotification` |
| `self._game_client.current_task_id` tag (line 628) | Broker tags its outbound RPC from inbound request's task_id |

After Phase 1: `rg "self._game_client" src/gradientbang/pipecat_server/subagents/task_agent.py` returns zero matches.

### VoiceAgent broker

[src/gradientbang/pipecat_server/subagents/voice_agent.py](../src/gradientbang/pipecat_server/subagents/voice_agent.py) grows handlers in `on_bus_message` for the four request types plus `BusTaskFinishNotification`. Each handler:

- Dispatches to the appropriate `self._game_client` method.
- For tool calls: applies the inbound `task_id` to `game_client.current_task_id` for the call duration, restoring on a try/finally so concurrent calls don't trample.
- Catches exceptions → returns `error=str(e)` in the response. Never re-raises out of the handler.
- Sends the matching response message back.

The corp-ship `AsyncGameClient(...)` block at [voice_agent.py:2016-2023](../src/gradientbang/pipecat_server/subagents/voice_agent.py#L2016-L2023) (and its `close()` at line 2076) is **deleted**. VoiceAgent's existing client services every TaskAgent's needs through the bus. `set_event_polling_scope()` (line 1607-1619) is unchanged — VoiceAgent still owns event-subscription scope for all its TaskAgent children.

### Test coverage

- `tests/unit/test_bus_messages.py` — every new dataclass has the expected defaults and remains JSON-serializable. Required vs optional enforced.
- `tests/unit/test_bus_correlation.py` — issue/resolve/reject/timeout/cancel-all semantics; concurrent in-flight calls resolve independently.
- `tests/unit/test_task_agent_bus.py` — mock bus; assert each touch point emits the right typed message; inject responses and verify behavior; on cancel, no pending future leaks; regression assertion that `TaskAgent` has no `_game_client` and no `AsyncGameClient` import.
- `tests/unit/test_voice_agent_bus_broker.py` — for each request type, mock `AsyncGameClient`, assert the right method is invoked with correct args; `task_id` tag set and restored on the client per call; exceptions returned as `error`, never raised.
- Extend existing VoiceAgent task tests — spawning a corp-ship task no longer constructs a second `AsyncGameClient` (constructor patch + counter); `actor_character_id` propagates end-to-end.
- `tests/integration/test_corp_ship_bus_only.py` — full path against local Supabase: corp-ship task moves and trades; exactly one `AsyncGameClient` in the process; `ship_instances.current_task_id` transitions correctly throughout.

---

## Phase 2 — Optional remote subagent bus 🔜 Planned

**Goal:** make the subagent bus transport-pluggable. The default remains the in-process `AsyncQueueBus` so existing deployments and local development do not change. Remote execution is opt-in via an upstream PGMQ-backed bus; after this phase, an agent can either run locally in the same process/machine or remotely in a separate process/machine and still act as a TaskAgent.

BYOA placement depends on the selected transport:

- `local` — the BYOA-compatible agent runs in the same process/machine using `AsyncQueueBus`. This is the default.
- `pgmq` — the BYOA-compatible agent can run as a separate local process or on another machine using upstream `pipecat_subagents.bus.network.pgmq.PgmqBus`.

Configuration:

```env
SUBAGENT_BUS_TRANSPORT=local # local | pgmq, default local
SUBAGENT_BUS_DATABASE_URL=   # required only when transport=pgmq
SUBAGENT_BUS_CHANNEL=        # optional; isolates deployments/sessions
```

Behavior:

- Missing `SUBAGENT_BUS_TRANSPORT` means `local`.
- `local` uses the current in-process `AsyncQueueBus`.
- `pgmq` initializes a `PGMQueue` from `SUBAGENT_BUS_DATABASE_URL` and constructs upstream `PgmqBus`.
- Missing `SUBAGENT_BUS_DATABASE_URL` with `SUBAGENT_BUS_TRANSPORT=pgmq` is a startup error.
- Existing deployments remain unchanged unless they opt into `pgmq`.

### New `BusAdapter` factory

Mirror the existing `EventAdapter` pattern at [src/gradientbang/adapters/events/factory.py](../src/gradientbang/adapters/events/factory.py):

- `src/gradientbang/adapters/bus/base.py` — re-export `pipecat_subagents.bus.AgentBus` as the protocol.
- `src/gradientbang/adapters/bus/local.py` — re-export `AsyncQueueBus`.
- `src/gradientbang/adapters/bus/pgmq.py` — optional tiny DSN helper only if needed; do not implement a local PGMQ bus.
- `src/gradientbang/adapters/bus/factory.py` — `make_subagent_bus()` branching on `SUBAGENT_BUS_TRANSPORT` env var (`local` | `pgmq`, default `local`).

`bot.py` switches from the implicit default in `AgentRunner()` to `AgentRunner(bus=make_subagent_bus())`. No other call sites change.

### Remote `PgmqBus` design

Use the upstream `PgmqBus` from `pipecat-subagents` rather than building a Gradient Bang-specific bus implementation. Gradient Bang owns only the factory and configuration; queue topology, peer discovery, fan-out, long-polling, and message deletion are owned by upstream `PgmqBus`.

- Each `PgmqBus` process gets its own peer-instance queue under the configured channel.
- `publish(message)` broadcasts to peer queues in that channel; normal `target` filtering remains part of the bus message / agent layer.
- `SUBAGENT_BUS_CHANNEL` isolates deployments, sessions, or test runs that share the same Postgres database.
- Remote integration tests run only when a local Supabase/PGMQ database is explicitly available.

### Message serialization

Use upstream `JSONMessageSerializer` for bus serialization. It serializes dataclass bus messages by fully qualified type name, so Gradient Bang custom messages must remain importable and JSON-safe. There is no local `BUS_MESSAGE_REGISTRY` and no per-message `to_dict()` / `from_dict()` requirement.

Coverage includes:

- The four typed request/response pairs from Phase 1.
- `BusTaskFinishNotification`.
- `BusGameEventMessage` (already used today).
- Framework messages: `BusTaskRequest`, `BusTaskResponse`, `BusTaskUpdate`, `BusTaskCancel`, `BusEndAgentMessage`.

Pre-condition for this phase: Phase 1's JSON-safety guarantee. If we let an object reference sneak into a `BusMessage` field, this is where it breaks.

### Auth boundary moves to the broker

In Phase 1, the broker is in-process inside VoiceAgent — same trust boundary as `AsyncGameClient`. In Phase 2, a TaskAgent (or future BYOA agent) might be in a different process, possibly a different host. The broker still runs inside VoiceAgent's process (the player's trusted session) and authenticates inbound bus requests against the bus-message envelope (`source` field), not via a separate auth check. PGMQ queue ACLs (SECURITY DEFINER on the SQL functions) prevent unauthorized publishing.

### Backwards-compatibility

Setting `SUBAGENT_BUS_TRANSPORT=local` (default) keeps today's `AsyncQueueBus` behavior bit-for-bit. Setting `pgmq` is opt-in per deployment.

### Tests

- `tests/unit/test_bus_factory.py` — unset env returns local bus; `SUBAGENT_BUS_TRANSPORT=local` returns local bus; `SUBAGENT_BUS_TRANSPORT=pgmq` requires `SUBAGENT_BUS_DATABASE_URL`; invalid transport fails clearly.
- `tests/unit/test_bus_serialization.py` — every Gradient Bang custom `BusMessage` subclass round-trips through upstream `JSONMessageSerializer`.
- `tests/integration/test_pgmq_bus.py` (PGMQ/local-Supabase marker) — spawn VoiceAgent + TaskAgent in separate processes connected via upstream `PgmqBus`. Run an end-to-end task. Assert identical behavior to the in-process baseline. This test is opt-in so default test runs do not require Postgres PGMQ.

---

## Phase 3 — BYOA operator contract 🔜 Planned

**Goal:** an external operator can run their own agent process, claim a corp ship as their BYOA, and have it participate in the game. Builds on Groundwork (the BYOA columns + ship lock + access control) and Phase 2 (the transport-pluggable bus).

Local BYOA/dev mode can use the default local bus. Production or external remote BYOA uses PGMQ, or a BYOA gateway backed by PGMQ if the operator boundary needs to hide raw database credentials.

### Operator onboarding

1. Operator joins a corporation as a normal player.
2. From the client UI (or CLI), operator calls `ship_byoa_configure` for a corp ship they want to control. Server records `byoa_owner_character_id = <operator>`, `byoa_mode = 'private'` (default) or `'shared'`.
3. Operator requests a **BYOA token** — HS256, bound to their character_id. Same primitive as the `PUBSUB_INTERNAL_SECRET` tokens already in 0.4.1. Token lives on the operator's machine only.
4. For local/dev BYOA, the operator agent can run on the local bus. For remote BYOA, the operator agent connects through PGMQ or a BYOA gateway backed by PGMQ; the token boundary resolves the operator to their character_id and grants only the allowed ship/bus access.

### Agent contract

The operator's agent must implement, in any language:

| Inbound (from bus) | Outbound (to bus) |
|---|---|
| `BusTaskRequest` — new task to run | `BusGameToolCallRequest` — invoke a game tool |
| `BusTaskCancel` — cancellation signal | `BusGameToolCallResponse` (other direction; not sent by agent) |
| `BusGameEventMessage` — game events for its character | `BusCombatStrategyRequest` — fetch doctrine before combat |
| `BusGameToolCallResponse` — RPC reply | `BusCorporationQueryRequest` — query corp data |
| `BusCombatStrategyResponse` | `BusTaskFinishNotification` — done with the current task |
| `BusCorporationQueryResponse` | `BusTaskUpdate` — progress reports for the human |

This is **exactly** the surface the in-process TaskAgent exposes after Phase 1. Reference implementation: the existing TaskAgent code is the spec; an operator can read it to understand the expected behavior.

### Task routing

When a player issues a task on a shared BYOA ship, who runs it? Two reasonable defaults, both possible to support:

- **Operator-first**: if the BYOA owner's agent is online (heartbeating its presence to the bus), tasks route to it. If offline, tasks route to a fallback in-process TaskAgent in the issuing player's VoiceAgent.
- **Issuer-first**: tasks always run in the issuing player's VoiceAgent process (today's behavior); the BYOA agent only runs tasks the *owner* issues from their own session.

Default for first ship: **issuer-first** (simpler, no presence detection needed). Operator-first is a follow-up if real demand emerges.

For BYOA `private` ships, only the owner can issue, so this question doesn't arise — there's only one place for the task to go.

### Operator-facing tooling

Out of scope for the first Phase 3 ship; treat as separate sub-work-items:

- Reference operator SDK (Python) that wraps local or PGMQ bus setup + typed message helpers.
- Reference example agent (could be the existing in-process TaskAgent extracted into a standalone runnable).
- Docs / quickstart for operators.
- Telemetry surface so operators can see their agent's bus activity in the same UI as everyone else's.

### Server-side hardening (only required for Phase 3)

- BYOA token lifecycle: issuance, rotation, revocation.
- Rate limits on inbound bus messages per BYOA agent.
- Audit log of which agent (in-process vs BYOA) actioned each tool call. The `actor_character_id` field already exists on game events; extend with an `agent_kind` discriminator (`voice` | `task` | `byoa`).

---

## Why this order

- **Groundwork first** because everything else assumes the server-side ship lock and BYOA columns exist. It's independently shippable, lower-risk than the agent refactor, and fixes a real correctness gap today (two corp members can currently double-task the same ship).
- **Phase 1 second** because it freezes the bus contract. Once TaskAgent is fully bus-based and uses only typed messages, Phase 2 (the optional local/remote bus factory) is mostly transport wiring and Phase 3 (BYOA operator) has a stable target API to implement against.
- **Phase 2 before Phase 3** because BYOA needs the bus transport choice to be explicit. Local/dev BYOA can use the default in-process bus, while production or external remote BYOA can opt into PGMQ or a PGMQ-backed gateway.

Phases 1 and 2 keep player-visible behavior identical (the in-process flow is preserved bit-for-bit at each step). Phase 3 is where new user-facing behavior actually appears.

## Critical file index

**Groundwork — modify:**
- [deployment/supabase/functions/task_lifecycle/index.ts](../deployment/supabase/functions/task_lifecycle/index.ts) — BYOA private check; atomic acquire; atomic release on finish; emit stolen-lock cancel.
- [deployment/supabase/functions/task_cancel/index.ts](../deployment/supabase/functions/task_cancel/index.ts) — atomic release; `force=true` corp-member bypass.
- [deployment/supabase/functions/_shared/tasks.ts](../deployment/supabase/functions/_shared/tasks.ts) — `fetchActiveTaskIdsByShip` reads new column.
- [deployment/supabase/functions/_shared/corporations.ts](../deployment/supabase/functions/_shared/corporations.ts) — `CorporationShipSummary` shape extension.
- [deployment/supabase/functions/list_user_ships/index.ts](../deployment/supabase/functions/list_user_ships/index.ts) — same shape extension.
- [src/gradientbang/pipecat_server/subagents/voice_agent.py](../src/gradientbang/pipecat_server/subagents/voice_agent.py) — pre-spawn server acquire; `_locked_ships` repositioned; disconnect releases server-side; heartbeat task.
- [src/gradientbang/pipecat_server/subagents/task_agent.py](../src/gradientbang/pipecat_server/subagents/task_agent.py) — drop the redundant `task.start` emit.

**Groundwork — create:**
- [deployment/supabase/migrations/20260512000000_ship_task_lock_and_byoa.sql](../deployment/supabase/migrations/20260512000000_ship_task_lock_and_byoa.sql) — schema, indexes, backfill, `refresh_ship_task_heartbeats` SQL helper.
- [deployment/supabase/functions/task_heartbeat/index.ts](../deployment/supabase/functions/task_heartbeat/index.ts) — bulk heartbeat endpoint.
- [deployment/supabase/functions/ship_byoa_configure/index.ts](../deployment/supabase/functions/ship_byoa_configure/index.ts) — BYOA owner/mode setter.
- `deployment/supabase/functions/tests/ship_task_lock_test.ts`, `byoa_access_test.ts` (Deno).
- `tests/integration/test_server_ship_lock.py`.

**Phase 1 — modify:**
- [src/gradientbang/pipecat_server/subagents/task_agent.py](../src/gradientbang/pipecat_server/subagents/task_agent.py) — drop `game_client` param; rewrite the 5 remaining touch points.
- [src/gradientbang/pipecat_server/subagents/voice_agent.py](../src/gradientbang/pipecat_server/subagents/voice_agent.py) — broker handlers; delete corp-ship `AsyncGameClient` path.
- [src/gradientbang/pipecat_server/subagents/bus_messages.py](../src/gradientbang/pipecat_server/subagents/bus_messages.py) — 3 request/response pairs + 1 finish notification.
- [src/gradientbang/pipecat_server/bot.py](../src/gradientbang/pipecat_server/bot.py) — stop passing `game_client=` into TaskAgent.

**Phase 1 — create:**
- [src/gradientbang/pipecat_server/subagents/bus_correlation.py](../src/gradientbang/pipecat_server/subagents/bus_correlation.py) — `PendingRequests` helper.
- `tests/unit/test_bus_messages.py`, `test_bus_correlation.py`, `test_task_agent_bus.py`, `test_voice_agent_bus_broker.py`.
- `tests/integration/test_corp_ship_bus_only.py`.

**Phase 2 — create:**
- `src/gradientbang/adapters/bus/{base,local,factory}.py`; optionally `pgmq.py` only for DSN parsing/helpers.
- `tests/unit/test_bus_factory.py`, `tests/unit/test_bus_serialization.py`.
- `tests/integration/test_pgmq_bus.py` behind a PGMQ/local-Supabase marker.

**Phase 3 — create (high level):**
- BYOA token issuance + rotation primitives in Supabase.
- Reference operator SDK + example agent (likely in `examples/byoa/`).
- Operator quickstart docs.

**Reused throughout (don't reinvent):**
- `GAME_METHOD_ALIASES` in [src/gradientbang/tools/schemas.py](../src/gradientbang/tools/schemas.py).
- `ToolsSchema` (`TASK_TOOLS`, `PLAYER_ONLY_TOOLS`) in [src/gradientbang/tools/__init__.py](../src/gradientbang/tools/__init__.py).
- `pipecat_subagents.bus.AgentBus` injectable pattern.
- PGMQ primitives from [20260505000000_pubsub_and_broadcasts.sql](../deployment/supabase/migrations/20260505000000_pubsub_and_broadcasts.sql).
- `can_user_access_character` SQL predicate.
