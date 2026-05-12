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
| **Groundwork** | ✅ **Shipped** (merged to `main`) | Server-side ship lock, BYOA columns + modes, heartbeat, `ship_byoa_configure`, access control, ship-list payload, VoiceAgent pre-spawn acquire + heartbeat + disconnect release, `ByoaAgentConfig`, client BYOA status popover |
| **Phase 1 — TaskAgent self-contained over the bus** | ✅ **Shipped** (branch `jpt/0.5.0-byoa-phase-1`, PR #380) | Typed bus messages, broker in VoiceAgent, TaskAgent drops `AsyncGameClient`, universal `BusAgentHelloRequest/Response` handshake, idle teardown timer |
| **Phase 2 — Optional remote subagent bus** | ✅ **Shipped** (branch `jpt/0.5.0-byoa-phase-2`, PR #383) | `make_subagent_bus()` factory, PGMQ adapter, transport-pluggable; `SUBAGENT_BUS_CHANNEL` required to prevent cross-talk; `pipecat-ai-subagents` vendored as submodule |
| **Phase 3 — External operator can run an agent** | 🔜 **Next** | BYOA token RPC (mint/revoke), token-gated SECURITY DEFINER SQL wrappers around pgmq for BYOA agents, BYOA bus adapter (uses the wrappers instead of raw pgmq), `TaskAgent.custom_prompt`, `uv run byoa --prompt-file` CLI (auto-loads `.env.byoa`), `env.byoa.example` template, **Claude skill for operator onboarding** (login → claim ship → mint token → write `.env.byoa`) |
| Phase 3.1 — Centralized `wake_agent` endpoint | Planned | New Gradient Bang-owned `wake_agent` edge function the bot calls when `BYOA_WAKE_ENABLED=true`. Stubbed today (logs + returns 200); future versions route to Vercel Sandbox / Lambda. Drops the per-ship `byoa_wake_hook` column entirely — operators never author their own webhook |
| Phase 4 — Operator-chosen LLM provider/model | Planned | `.env.byoa`-driven `TASK_LLM_PROVIDER` / `TASK_LLM_MODEL` / API keys, with CLI-side validation + startup visibility log. Reuses existing `TASK_LLM_*` env names |
| Phase 5 — BYOA management UI | Planned | Game-client UI surfaces for claiming/configuring BYOA ships, prompt editor, telemetry view of "what is my BYOA agent doing on the bus" |

**You are here:** Phase 1 and Phase 2 are both functionally complete on their respective branches; the two PRs are stacked (#383 bases on #380, which bases on the groundwork branch). Ready to cut Phase 3.

Concrete Groundwork deliverables (all in this PR):

- Migration: [20260512000000_ship_task_lock_and_byoa.sql](../deployment/supabase/migrations/20260512000000_ship_task_lock_and_byoa.sql) — BYOA schema in one migration: ship task-lock columns/indexes/backfill/RPCs, BYOA token storage + verification, wake hook column, and BYOA PGMQ wrapper functions.
- Edge functions: [task_heartbeat](../deployment/supabase/functions/task_heartbeat/index.ts), [ship_byoa_configure](../deployment/supabase/functions/ship_byoa_configure/index.ts); modified [task_lifecycle](../deployment/supabase/functions/task_lifecycle/index.ts) (atomic acquire on start, BYOA private check, stolen-lock cancel emit), [task_cancel](../deployment/supabase/functions/task_cancel/index.ts) (atomic release, `force=true` corp-member bypass, BYOA private restriction), [_shared/corporations.ts](../deployment/supabase/functions/_shared/corporations.ts) + [list_user_ships](../deployment/supabase/functions/list_user_ships/index.ts) (truncated `current_task_actor` + `byoa` blocks), [_shared/tasks.ts](../deployment/supabase/functions/_shared/tasks.ts) (column read).
- Bot: [src/gradientbang/byoa/config.py](../src/gradientbang/byoa/config.py) (`ByoaAgentConfig`), [voice_agent.py](../src/gradientbang/pipecat_server/subagents/voice_agent.py) (pre-spawn server acquire on both spawn and reuse paths, lazy heartbeat task, cancel-before-release ordering, server-side release on disconnect, `_dispatch_task_with_id` so both paths share the same pinned task_id), [task_agent.py](../src/gradientbang/pipecat_server/subagents/task_agent.py) (drop redundant `task.start` emit), [supabase_client.py](../src/gradientbang/utils/supabase_client.py) + [api_client.py](../src/gradientbang/utils/api_client.py) (`task_heartbeat`, `task_cancel(force=True)`, `RPCError.body`).
- Tests: Deno [ship_task_lock_test.ts](../deployment/supabase/functions/tests/ship_task_lock_test.ts), [byoa_access_test.ts](../deployment/supabase/functions/tests/byoa_access_test.ts); Python [tests/unit/test_byoa_config.py](../tests/unit/test_byoa_config.py) + extensions to [test_voice_agent.py](../tests/unit/test_voice_agent.py), [test_voice_relay_integration.py](../tests/unit/test_voice_relay_integration.py), [test_task_agent_integration.py](../tests/unit/test_task_agent_integration.py).
- Docs: [docs/setup-byoa.md](setup-byoa.md) (operator guide).
- Client: BYOA status popover on each corp ship card in [client/app/src/components/ShipStatusPopover.tsx](../client/app/src/components/ShipStatusPopover.tsx).

# Phases

## User-facing documentation (process)

After each phase ships, update [docs/setup-byoa.md](setup-byoa.md) — a user-facing README written in operator language that explains what's possible at the current phase. Groundwork seeds it with the ship-lock semantics and BYOA columns; Phase 1 adds the bus protocol surface; Phase 2 adds the local/remote transport choice; Phase 3 turns it into a true quickstart for external operators. The doc grows incrementally with the system rather than being written at the end.

## Agent lifecycle & wake-up (cross-phase)

A core BYOA reality the rest of the plan has to thread: **a target agent may not be alive when a task is dispatched to it**. An external BYOA agent on Vercel Sandbox / AWS Lambda is asleep until something wakes it (cold start ~3–10s). The in-process TaskAgent shipped today is essentially always alive (pipeline init < 100ms), so the gap is invisible — but the same code path has to work for both.

The plan handles this with three orthogonal pieces, each landing in the phase it belongs to:

1. **A bus-level "I'm online" signal** from the agent. In **Phase 1**, the in-process flow is request-driven — VoiceAgent sends a `BusAgentHelloRequest`, TaskAgent responds with `BusAgentHelloResponse(ready=true)` as soon as `on_ready` has fired. That covers in-process agents (essentially instant) and gives Phase 1 testable wake behaviour. **Phase 3** extends this so a remote BYOA agent broadcasts `BusAgentHelloResponse(ready=true)` *unprompted* on cold-start completion — no request to correlate to, just an announcement that the agent is online and ready to drain its bus queue.
2. **An out-of-band wake trigger** (HTTPS POST). For remote agents the bot calls Gradient Bang's `wake_agent` edge function asynchronously and parks the task on the bus while waiting for the agent's online signal. Gated by `BYOA_WAKE_ENABLED` (server-side bot env, default `false` for local dev). Operators do NOT author their own wake webhooks — the routing-to-sandbox logic lives entirely server-side. Implemented in **Phase 3.1**; the bus-side wake plumbing (watchdog, pending-wake map, unsolicited online signal handling) ships in Phase 3 and works regardless of which wake mechanism eventually lives behind `wake_agent`.
3. **An idle teardown timer** so a warm BYOA agent eventually goes back to sleep when there's no work, releasing the ship slot. Implemented in **Phase 1** (lives on TaskAgent); only meaningfully fires for remote BYOA agents in Phase 3.

### Spawn flow — in-process (Phase 1, shipped)

```
1. Acquire server ship lock                              ← Groundwork
2. Emit task.starting → client renders "Starting" badge  ← new (see UX section)
3. Send BusAgentHelloRequest, await BusAgentHelloResponse ← Phase 1
   timeout = agent_wake_timeout_seconds (default 30s)
   - on timeout: release lock, surface error, return failure
4. Dispatch BusTaskRequest via _dispatch_task_with_id    ← Groundwork plumbing
5. Server lock heartbeats run as today                   ← Groundwork
```

The lock is held across steps 2–3 (warmup window). For in-process agents the handshake completes in milliseconds, so the user effectively never sees the "Starting" state.

### Spawn flow — remote BYOA via wake_agent (Phase 3 + 3.1)

The in-process flow above is synchronous because the handshake completes effectively instantly. A remote BYOA agent on Vercel Sandbox is a different problem — cold start is 3–10s and the LLM tool call shouldn't block on it. The flow is async and event-driven:

```
1. Acquire server ship lock                              ← Groundwork
2. Emit task.starting with status="waking"               ← UI shows "Waking"
3. If BYOA_WAKE_ENABLED, POST wake_agent edge function
   (fire-and-forget; short HTTP timeout, logged on
   failure but doesn't block). In local dev wake is
   disabled by default — operators run uv run byoa
   always-on.                                            ← Phase 3.1
4. Publish BusTaskRequest to the bus targeted at the
   agent's identity — PGMQ buffers it until the agent
   connects and drains its queue                         ← Phase 3
5. Register a pending-wake entry keyed by ship_id with
   a 30s timer (BYOA_AGENT_WAKE_TIMEOUT_SECONDS)         ← Phase 3
6. Return { success: true, status: "waking", task_id }
   to the LLM immediately — voice can narrate "Waking
   your agent…" without blocking                         ← Phase 3
```

The agent then drives the next transition unprompted, by broadcasting `BusAgentHelloResponse(ready=true, source=<its_identity>)` once it's connected to the bus and its task context is initialised. The bot's broker handles that signal:

```
- Match the source against the pending-wake map
- If a hit: cancel the wake timer, emit task.start
  with status="active" so the client flips the ship
  card to "Online" / "Active". The agent has already
  picked the BusTaskRequest off its queue by then.
- If no hit (unsolicited or already-cancelled hello):
  drop silently
```

On 30s timeout with no online signal:

```
- The pending-wake entry expires
- Bot calls task_cancel(force=true) with
  reason="byoa_wake_timeout" — releases the server
  lock and emits task.cancel for the UI to render as
  "BYOA agent didn't wake within 30s — try again"
- The BusTaskRequest still sitting in the agent's
  PGMQ queue is left to age out (the agent, if it
  eventually wakes, must verify its task_id is still
  the current lock holder before processing — see
  "stale-task guard" below)
- No bot-side exception, no LLM-facing error during
  the wait (it already returned success: starting)
```

**Stale-task guard (agent-side).** Because the task message can outlive its server-side lock when wake times out, the operator's agent must verify its `task_id` is still the active lock holder before doing real work. The cheapest implementation: include the expected `task_id` in `BusTaskRequest.task_metadata`, and the agent's first action on a new task is to read the ship's `current_task_id` (already in the ship-list payload). Mismatch → silently no-op the task. Documented in the operator quickstart.

### `task.starting` UI bridge (small follow-up to Groundwork)

The current badge in [PlayerShipPanel.tsx:108-118](../client/app/src/components/panels/PlayerShipPanel.tsx#L108-L118) flips idle → active. The BYOA wake flow needs more states. Four-state pill:

| State | Meaning |
|---|---|
| **Idle** | No task running, no lock held |
| **Waking** | `wake_agent` POSTed (or, when `BYOA_WAKE_ENABLED=false`, skipped); awaiting `BusAgentHelloResponse(ready=true)` from the agent. Only fires for BYOA ships; in-process / warm BYOA flows skip straight to Active |
| **Active** | Agent has signalled online and is processing a task |
| **Failed** | Wake timeout or task error — transient, auto-clears on next task issue |

Server emits `task.starting` (status=`waking` or `active`) on lock acquire; the broker emits a state update to `active` when the online signal arrives; `task.cancel` on wake timeout. The "Online / Offline" placeholder in [ShipStatusPopover.tsx](../client/app/src/components/ShipStatusPopover.tsx) renders the four-state pill.

This bit *could* ship as a tiny standalone PR before Phase 1 — the UI plumbing is independent of the bus protocol. Until Phase 1, "waking" never has a meaningful duration, so the user just sees the same idle→active flip they see today.

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

## Phase 1 — TaskAgent self-contained over the bus ✅ Shipped (on `jpt/0.5.0-byoa-phase-1`)

**Goal:** TaskAgent stops holding `AsyncGameClient`. All tool calls, doctrine fetches, corp queries, and the task-finish notification flow over the bus to VoiceAgent's broker. After this phase, the in-process TaskAgent is the BYOA contract.

> **Status:** complete on this branch. The four sub-PRs landed in order — (1) `PendingRequests` + typed messages, (2) VoiceAgent broker handlers, (3) TaskAgent rewritten over the bus, (4) wake-up handshake + idle teardown. Post-merge hardening commits resolved a broker race, a finish-actor mix-up, envelope-identity correctness via contextvars, and pubsub dynamic-scope add preflight/retry. Sections below describe the design as implemented; file pointers under "Critical file index" link to what actually shipped.

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

**Agent lifecycle handshake** (used by VoiceAgent before delivering any `BusTaskRequest` — see "Agent lifecycle & wake-up" near the top of this doc):
- `BusAgentHelloRequest(source, target, correlation_id)` — "are you alive and ready to accept a task?"
- `BusAgentHelloResponse(source, target, correlation_id, ready, capabilities, error)` — `capabilities` is forward-compat for future tool-version negotiation (empty dict is fine now); `protocol_version: int` is included so future bus-message format changes don't break older operator agents.

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
| *(new)* — no equivalent today | Subscribe to `BusAgentHelloRequest`; respond `ready=true` **only after** `on_ready` has fired and `self._llm_context` is initialised |
| *(new)* — no equivalent today | Idle teardown timer reset on every inbound task / tool call; fires `BusEndAgentMessage` to self after `agent_idle_teardown_seconds` of no activity. In-process player-ship agents effectively never hit this; corp-ship and BYOA agents do |

After Phase 1: `rg "self._game_client" src/gradientbang/pipecat_server/subagents/task_agent.py` returns zero matches.

### VoiceAgent broker

[src/gradientbang/pipecat_server/subagents/voice_agent.py](../src/gradientbang/pipecat_server/subagents/voice_agent.py) grows handlers in `on_bus_message` for the four request types plus `BusTaskFinishNotification`. Each handler:

- Dispatches to the appropriate `self._game_client` method.
- For tool calls: applies the inbound `task_id` to `game_client.current_task_id` for the call duration, restoring on a try/finally so concurrent calls don't trample.
- Catches exceptions → returns `error=str(e)` in the response. Never re-raises out of the handler.
- Sends the matching response message back.

The corp-ship `AsyncGameClient(...)` block at [voice_agent.py:2016-2023](../src/gradientbang/pipecat_server/subagents/voice_agent.py#L2016-L2023) (and its `close()` at line 2076) is **deleted**. VoiceAgent's existing client services every TaskAgent's needs through the bus. `set_event_polling_scope()` (line 1607-1619) is unchanged — VoiceAgent still owns event-subscription scope for all its TaskAgent children.

### Wake-handshake in `_handle_start_task`

The spawn flow in [voice_agent.py](../src/gradientbang/pipecat_server/subagents/voice_agent.py) gains an explicit handshake step between the existing server-side lock acquire and the task dispatch. See "Agent lifecycle & wake-up" near the top of this doc for the full flow.

- After the server-side acquire succeeds (Groundwork) and the local lock map is set, VoiceAgent emits a `task.starting` UI signal.
- A `BusAgentHelloRequest` is sent to the target; VoiceAgent awaits `BusAgentHelloResponse` up to `ByoaAgentConfig.agent_wake_timeout_seconds` (default 30s).
- On timeout: call `task_cancel(force=true)` to release the server lock, surface the error to the LLM, return failure. The `task.starting` state on the client cleanly transitions to `task.error`.
- On success: dispatch via the existing `_dispatch_task_with_id` helper, emit `task.start` to the client (or flip the `status` field if a single event is used).

This applies to both spawn paths (new-agent and reuse). For the player-ship reuse path the handshake completes in ~zero time because the existing TaskAgent is already alive.

### `ByoaAgentConfig` additions (Phase 1)

Two new fields land in [src/gradientbang/byoa/config.py](../src/gradientbang/byoa/config.py) alongside the Groundwork fields:

```python
# How long VoiceAgent waits for a target agent to signal alive after
# start_task. Generous enough to cover cold starts on Vercel Sandbox /
# AWS Lambda. Falls back to the local handshake roundtrip for in-process.
agent_wake_timeout_seconds: float = 30.0

# How long an idle warm agent stays around before self-terminating.
# Phase 1 wires TaskAgent to reset a timer on every inbound task / tool
# call. In-process player-ship agents effectively never hit this (reuse
# keeps them busy); corp-ship and BYOA agents do — when this fires the
# ship slot becomes acquire-eligible for someone else.
agent_idle_teardown_seconds: float = 300.0
```

### Test coverage

- `tests/unit/test_bus_messages.py` — every new dataclass has the expected defaults and remains JSON-serializable. Required vs optional enforced.
- `tests/unit/test_bus_correlation.py` — issue/resolve/reject/timeout/cancel-all semantics; concurrent in-flight calls resolve independently.
- `tests/unit/test_task_agent_bus.py` — mock bus; assert each touch point emits the right typed message; inject responses and verify behavior; on cancel, no pending future leaks; regression assertion that `TaskAgent` has no `_game_client` and no `AsyncGameClient` import.
- `tests/unit/test_voice_agent_bus_broker.py` — for each request type, mock `AsyncGameClient`, assert the right method is invoked with correct args; `task_id` tag set and restored on the client per call; exceptions returned as `error`, never raised.
- Extend existing VoiceAgent task tests — spawning a corp-ship task no longer constructs a second `AsyncGameClient` (constructor patch + counter); `actor_character_id` propagates end-to-end.
- `tests/integration/test_corp_ship_bus_only.py` — full path against local Supabase: corp-ship task moves and trades; exactly one `AsyncGameClient` in the process; `ship_instances.current_task_id` transitions correctly throughout.
- `tests/unit/test_agent_handshake.py` — `BusAgentHelloRequest/Response` round-trip; TaskAgent only responds `ready=true` after `on_ready` has fired; VoiceAgent surfaces a structured error on handshake timeout and releases the server lock; the reuse path completes the handshake in ~zero time. Also: an in-process TaskAgent's idle teardown timer fires correctly and emits `BusEndAgentMessage` to itself.

---

## Phase 2 — Optional remote subagent bus 🔜 Next up

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

## Phase 3 — External operator can run an agent 🔜 Planned

**Goal:** an external operator can run their own BYOA agent (typically a Vercel Sandbox) against a corp ship they own. Reuses Phase 1's bus protocol and Phase 2's transport. Adds the missing pieces an operator needs end-to-end: an HS256 token bound to their `character_id`, a wake webhook so a sleeping sandbox cold-starts on task dispatch, **token-gated SECURITY DEFINER SQL wrappers around pgmq** so the operator's bus access is constrained to their bound character's queue (mirrors the 0.4.1 `subscribe_my_events` pattern, just for BYOA), a thin `uv run byoa` CLI that wraps the existing in-process `TaskAgent` (no refactor needed), operator-owned custom prompts, and a Claude skill that handles onboarding (login → claim ship → mint token → write `.env.byoa`) so we don't have to build game-client UI in this phase.

### Auth model: DSN as transport, token as authorization

The bus is a TaskAgent's only interface to the game (VoiceAgent owns the edge-function client; TaskAgents speak the bus to its broker — Phase 1). So "joining the bus" is the entire authorization surface for an external operator. Two facts shape this:

- A Postgres DSN authenticates a **role**, not a character. If an operator had a role with raw `pgmq.*` grants, they could read every character's queue. That's an unacceptable blast radius for anyone but our own infra team.
- The 0.4.1 pubsub design already solved this for the bot: admin DSN for transport, plus a per-character HS256 token, plus SECURITY DEFINER SQL functions (`subscribe_my_events` / `archive_my_events`) that verify the token and enforce per-character ownership. Raw `pgmq.*` calls are intentionally not on the bot's normal path.

Phase 3 extends that model to BYOA: same shape, BYOA-specific wrappers. The operator's CLI never calls raw pgmq — it goes through the new SECURITY DEFINER wrappers, and those refuse to do anything without a valid `verify_byoa_token()` (already shipped in 1/N). The DSN is just the transport that gets the SQL call to the database. A leaked token alone is useless without the DSN; a leaked DSN alone is useless without the token (assuming the role doesn't have direct `pgmq.*` grants, which is the hardening path).

### Operator onboarding flow

1. Operator joins a corporation as a normal player.
2. Operator runs the `byoa-setup` Claude skill, which prompts for game-account email/password, calls `ship_byoa_configure` to claim a corp ship, mints a BYOA token via `byoa_token_mint`, and writes `BYOA_TOKEN` + bus DSN + channel + ship/character ids to `.env.byoa`.
3. Operator deploys their `uv run byoa` process — locally as an always-on terminal session, or in production as a Vercel Sandbox / Lambda / similar. They do NOT author a wake webhook; the wake mechanism lives server-side in the `wake_agent` edge function (Phase 3.1) and is `BYOA_WAKE_ENABLED=false` by default for local dev (the operator's process is always-warm, no wake needed).
4. On first task dispatch the bot optionally pings `wake_agent` (when enabled), the agent connects to Postgres using the DSN, every bus operation passes its `BYOA_TOKEN` through the SECURITY DEFINER wrappers, the agent advertises ready (Phase 1 unsolicited hello), drains the task, and exits cleanly on idle teardown.

The Claude skill stands in for game-client UI in this phase — game-client surfaces for claim/configure/prompt-editor/telemetry land in **Phase 4**.

### Server-side primitives

#### BYOA token RPC (shipped in 1/N)

Edge functions, both Supabase-JWT-authed:

- `byoa_token_mint` — issues an HS256 token bound to `character_id` (verified via `can_user_access_character`). Reuses the `PUBSUB_INTERNAL_SECRET` primitive from 0.4.1; same signing secret, distinct `token_type: "byoa"` + `iss: "byoa_token_mint"` claims to keep audiences separate. Returns the token string once; we never persist the plaintext, only a hash for revocation lookup.
- `byoa_token_revoke` — flips a token's hash row to revoked. The SECURITY DEFINER wrappers (below) check the hash on every call and reject revoked tokens.

Token claims: `character_id`, `token_type: "byoa"`, `iss: "byoa_token_mint"`, `jti` (matches the row's `token_id`), `iat`, `exp` (default 90d, max 365d). Rotation is "mint new + revoke old," not stateful — keeps the lifecycle simple.

The SECURITY DEFINER helper `public.verify_byoa_token(token text) RETURNS uuid` is already shipped — it validates signature + token_type/iss + row presence/revocation/expiry, updates `last_used_at` lazily, and returns the bound character_id (or NULL on failure). The token-gated SQL wrappers below all call it.

#### Bus-side wake plumbing

VoiceAgent's spawn flow gains async wake behavior for BYOA ships, regardless of whether an out-of-band wake actually fires (that's gated by `BYOA_WAKE_ENABLED` and lives in Phase 3.1). The mechanics:

```python
# Inside the spawn path, after lock acquire + task.starting emit
if ship.byoa_owner_character_id:
    # Optional out-of-band wake call (Phase 3.1). Skipped entirely when
    # BYOA_WAKE_ENABLED is false (default in dev). Always fire-and-forget;
    # never blocks the LLM tool call.
    if byoa_wake_enabled:
        asyncio.create_task(self._call_wake_agent(task_id, ship_id, character_id))

    # Publish the task to the bus immediately. PGMQ buffers; the agent
    # drains its queue on connect.
    await self._publish_task_request(target=..., task_id=task_id, ...)

    # Register a pending-wake entry. On BusAgentHelloResponse(ready=true)
    # from the matching source, cancel this timer + emit task.start.
    # On timer expiry: task_cancel(force=true, reason="byoa_wake_timeout").
    self._pending_wakes[ship_id] = asyncio.create_task(
        self._wake_timeout_watchdog(ship_id, task_id, timeout=30.0)
    )

    return {"success": True, "status": "waking", "task_id": task_id}
```

Two new bits of state on the broker:

- `_pending_wakes: dict[ship_id, asyncio.Task]` — the watchdog timers, indexed by ship so a follow-up `BusAgentHelloResponse(ready=true)` can cancel the right one.
- A new handler on `BusAgentHelloResponse` that treats `correlation_id is None or correlation_id not in self._pending` as an unsolicited online signal. Match the response's `source` to a pending-wake entry; on hit, cancel the watchdog and emit `task.start` (status=`active`).

The HTTP POST failing (wake_agent down, sandbox unreachable, etc.) doesn't fail the spawn — the watchdog timer will eventually expire and surface a clear UI error, which is the right failure mode. See Phase 3.1 for the `wake_agent` endpoint design.

#### Token-gated SQL bus wrappers

Additive migration. SECURITY DEFINER functions that wrap the pgmq operations the BYOA agent needs, each requiring an HS256 BYOA token. The pattern mirrors `subscribe_my_events` / `archive_my_events` from the 0.4.1 pubsub migration — same signing-secret primitive, same `verify`-then-act flow.

```sql
-- Long-poll the BYOA agent's per-character queue. Returns pgmq messages
-- restricted to chr_<character_id> where character_id is what the token
-- is bound to. Any attempt to read another character's queue is silently
-- swallowed (returns zero rows) so we don't leak queue existence.
CREATE FUNCTION public.byoa_bus_subscribe(
  p_byoa_token  text,
  p_max_seconds integer DEFAULT 5,
  p_qty         integer DEFAULT 50
) RETURNS SETOF pgmq.message_record
LANGUAGE plpgsql SECURITY DEFINER ...

-- Publish a bus message to a specific peer queue. Validates the token;
-- rewrites the bus envelope's `source` to the token's bound character_id
-- before publishing (prevents impersonation regardless of what the caller
-- passes in `p_message`).
CREATE FUNCTION public.byoa_bus_publish(
  p_byoa_token   text,
  p_target_queue text,
  p_message      jsonb
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER ...

-- Archive consumed messages so the visibility-timeout retry doesn't
-- redeliver them. Pair-matched to msg_ids the caller actually received
-- from byoa_bus_subscribe.
CREATE FUNCTION public.byoa_bus_archive(
  p_byoa_token text,
  p_msg_ids    bigint[]
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER ...
```

Each function:

1. Calls `verify_byoa_token(p_byoa_token)`; on NULL, raises `invalid_token` (`ERRCODE 42501`).
2. Uses the returned `character_id` to constrain the operation (subscribe to `chr_<id>`, archive only messages from that queue, rewrite publish envelope `source`).
3. `last_used_at` updates fall out of the `verify_byoa_token` call.

All three are `REVOKE ALL ... FROM PUBLIC; GRANT EXECUTE ... TO service_role` plus whatever future restricted role we introduce for operators. The bot's existing admin role retains EXECUTE.

### BYOA bus adapter

New `src/gradientbang/adapters/bus/byoa_pgmq.py` implements the `AgentBus` protocol. Subclasses or composes around upstream `PgmqBus` so we get its reader/writer plumbing for free, but **overrides the pgmq read/send/archive calls** to go through `byoa_bus_subscribe` / `byoa_bus_publish` / `byoa_bus_archive` instead of raw `pgmq.read_with_poll` / `pgmq.send` / `pgmq.archive`. The HS256 BYOA token is included on every call.

Picked by `SUBAGENT_BUS_TRANSPORT=byoa_pgmq`; required env: `SUBAGENT_BUS_DATABASE_URL`, `SUBAGENT_BUS_CHANNEL`, `BYOA_TOKEN`. The factory branch extends Phase 2's: `byoa_pgmq` joins `local` and `pgmq` as a third selectable transport. Local TaskAgent / VoiceAgent paths are unaffected — `byoa_pgmq` is only ever picked by the `uv run byoa` runtime in operator processes.

> **Hardening (optional, defer-able):** create a restricted Postgres role with `EXECUTE` only on the three wrappers (no `pgmq.*` grants). Operators get a DSN with that role; bypassing the wrappers becomes impossible at the SQL level. Without it, "trusted operator running malicious code" can still call raw pgmq — same trust assumption as the bot today. Worth landing alongside the first non-team-operator deployment.

### `uv run byoa` runtime

New console script:

```toml
[project.scripts]
bot = "gradientbang.pipecat_server.cli:main"
byoa = "gradientbang.byoa.cli:main"   # new
```

#### `.env.byoa` convention

Mirrors the existing `.env.supabase` / `.env.bot` pattern. The skill writes it; the CLI auto-loads it. Operators can hand-edit, but the round-trip is "re-run the skill" rather than "hand-edit."

We ship **`env.byoa.example`** at the repo root (sibling of `env.bot.example` / `env.supabase.example`) as the canonical template. The skill produces a populated `.env.byoa` from this template; operators bootstrapping by hand can `cp env.byoa.example .env.byoa` and fill in the blanks.

```bash
# env.byoa.example — template committed to the repo
#
# Bus transport. `byoa_pgmq` routes every bus call through the
# token-gated SECURITY DEFINER wrappers so the agent's reach is
# constrained to its bound character_id, regardless of what the DSN
# could otherwise touch.
SUBAGENT_BUS_TRANSPORT=byoa_pgmq

# Postgres DSN — the transport. The role's grants are limited to the
# byoa_bus_* wrapper functions (and pgmq schema USAGE) once the
# hardening role lands; until then this is the same admin DSN the bot
# uses. The token is what authorizes per-character access; the DSN
# alone cannot impersonate another character.
SUBAGENT_BUS_DATABASE_URL=

# Bus channel — must match the bot's value so peer-discovery finds
# everyone in the same deployment. See env.bot.example for the bot's
# corresponding setting.
SUBAGENT_BUS_CHANNEL=

# HS256 BYOA token issued by `byoa_token_mint` (or via the byoa-setup
# Claude skill). Bound to BYOA_CHARACTER_ID; rotation is "mint new +
# revoke old". Every byoa_bus_* call passes this through; an invalid
# or revoked token fails the call.
BYOA_TOKEN=

# Ship + character the operator is acting as. The skill fills these
# from `ship_byoa_configure`'s response so they match the token.
BYOA_SHIP_ID=
BYOA_CHARACTER_ID=

# Optional: path to the custom-prompt file. The CLI also accepts this
# via --prompt-file (the arg wins when both are present).
# BYOA_PROMPT_FILE=./prompt.md
```

The CLI loads it via `python-dotenv` (already a project dep) on startup. Default search path is `./.env.byoa`; override with `--env-file <path>`. Shell environment takes precedence over file contents (standard dotenv pattern), so operators can override individual values without rewriting the file — e.g. `BYOA_TOKEN=newtoken uv run byoa ...` for a token rotation smoke test. Startup logs the resolved env-file path so misconfigured runs are debuggable.

`--ship-id` and `--character-id` can also come from the file (`BYOA_SHIP_ID`, `BYOA_CHARACTER_ID`) so the typical Vercel invocation is just `uv run byoa --prompt-file ./prompt.md`. CLI args win over env when both are present.

#### Invocation

Typical Vercel sandbox shape — everything except the prompt comes from `.env.byoa`:

```bash
uv run byoa --prompt-file ./prompt.md
```

Explicit form (useful for debugging or one-off overrides):

```bash
uv run byoa \
    --prompt-file ./prompt.md \
    --env-file ./.env.byoa.staging \
    --ship-id <uuid> \
    --character-id <uuid>
```

#### What the entry point does, end-to-end

1. Resolve `--env-file` (default `./.env.byoa`). Load it without overriding shell env. Log the resolved path.
2. Parse args + env. Validate prompt file exists, is non-empty, and is under the 8 KB cap; refuse to start otherwise. Read once into memory.
3. Construct the bus via `make_subagent_bus()` — Phase 3 adds the `byoa_pgmq` branch that includes `BYOA_TOKEN` on every wrapped pgmq call.
4. Instantiate `TaskAgent` with `custom_prompt=<file contents>` (see threading below).
5. Hand control to `AgentRunner`. The Phase 1 wake handshake and idle teardown work unchanged.
6. On idle teardown, exit cleanly so the sandbox can sleep.

The runtime is single-purpose: one BYOA agent per process, one ship per process. Multi-ship operators run multiple sandbox functions, each with its own `.env.byoa`.

### Operator-owned prompt

Custom prompts live on the operator's filesystem (committed to their Vercel project), not on `ship_instances`. The full design rationale is documented in [old Phase 4 spec — short version: the operator owns the runtime, so they own the prompt; Vercel redeploys are ~30s; no new schema/edge-function/UI required]. Game-client prompt editing as a UX nicety on top of file-stored defaults is reconsidered in Phase 4.

#### Prompt assembly

Extend [src/gradientbang/utils/prompt_loader.py](../src/gradientbang/utils/prompt_loader.py):

```python
def build_task_agent_prompt(custom_prompt: Optional[str] = None) -> str:
    parts = [
        load_prompt("base/game_overview.md"),
        load_prompt("base/how_to_load_info.md"),
        load_prompt("agents/task_agent.md"),
    ]
    base = "\n\n".join(parts)
    trimmed = (custom_prompt or "").strip()
    if not trimmed:
        return apply_prompt_substitutions(base)
    return apply_prompt_substitutions(
        f"{base}\n\n## Operator guidance\n\n"
        "Layer the following on top of the instructions above:\n\n"
        f"{trimmed}"
    )
```

Mirrors the existing combat-doctrine pattern at [prompt_loader.py:191-218](../src/gradientbang/utils/prompt_loader.py#L191-L218). Empty / whitespace-only custom is a no-op — zero behavioural drift from today's path.

#### TaskAgent threading

- `TaskAgent.__init__` gains `custom_prompt: Optional[str] = None`.
- `on_task_start` ([task_agent.py:384](../src/gradientbang/pipecat_server/subagents/task_agent.py#L384)) passes it through to `build_task_agent_prompt(custom_prompt=self._custom_prompt)`.
- `on_task_progress_query` ([task_agent.py:441](../src/gradientbang/pipecat_server/subagents/task_agent.py#L441)) deliberately does **not** receive the custom prompt — progress queries are operational, not gameplay, and shouldn't pick up operator persona.

In-process TaskAgent never sets `custom_prompt` (bot.py constructs with the kwarg defaulted), so non-BYOA paths are bit-for-bit identical.

#### Length cap and safety

- Prompt files capped at **8 KB** at load time. Larger files raise a startup error with a clear message.
- File read once at startup, never re-read. Operators rotate prompts by redeploying.
- No template substitution (`${key}`) is applied to the custom block — operators shouldn't be able to reach into the runtime's substitution namespace. Document this in the operator guide.

### Task routing default

Shared BYOA ships: who runs a task when the player issues it from their own session?

- **Issuer-first** (default for this phase): tasks always run in the issuing player's VoiceAgent process — today's behavior. The BYOA agent only runs tasks the owner issues from their own session.
- **Operator-first** (deferred): if the BYOA owner's agent is online (heartbeating presence on the bus), tasks route to it; otherwise fall back to in-process. Requires presence detection; revisit when there's real demand.

Private BYOA ships only allow the owner to issue, so the question doesn't arise.

### `byoa-setup` Claude skill

Lives at `.claude/skills/byoa-setup/SKILL.md` (or the project's skill location). One interactive flow:

1. Prompt operator for game-account email + password. Call Supabase Auth's password sign-in; surface auth errors clearly.
2. List the operator's corp ships via `list_user_ships`; let the operator pick one (or take `--ship-id`).
3. Call `ship_byoa_configure` (`action=claim`, `mode=private` default).
4. Call `byoa_token_mint`; receive the token.
5. Write `./.env.byoa` (or an operator-chosen path via `--out`) with all the vars the CLI expects: `SUBAGENT_BUS_TRANSPORT=byoa_pgmq`, `SUBAGENT_BUS_DATABASE_URL`, `SUBAGENT_BUS_CHANNEL`, `BYOA_TOKEN`, `BYOA_SHIP_ID`, `BYOA_CHARACTER_ID`. File mode `0600` so the token + DSN don't leak via lax permissions. Refuse to overwrite an existing file without `--force`.
6. Print the next-step copy-paste for the operator: deploy a Vercel function that shells out to `uv run byoa --prompt-file ./prompt.md`, register its URL, optionally re-run the skill with `--wake-url` to record it on the ship.

We also ship `env.byoa.example` at the repo root (sibling of `env.bot.example` / `env.supabase.example`) so operators can see the exact var set even without running the skill.

Future Phase 4 game-client UI replaces this skill flow with point-and-click; the skill stays as a power-user / scripting path.

### Operator quickstart docs

Extend [docs/setup-byoa.md](setup-byoa.md):

- The Claude-skill onboarding flow, end-to-end.
- The `.env.byoa` shape — point at `env.byoa.example`, explain each var, note that shell env overrides file contents.
- An example `prompt.md` showing the operator-guidance style.
- A minimal Vercel-deployment shape that runs `uv run byoa --prompt-file ./prompt.md` with `.env.byoa` baked into the project. (Routing FROM `wake_agent` TO Vercel lives in a future Phase 3.x; not in this slice.)
- The 8 KB prompt cap; what happens when exceeded (clear startup error).
- A worked example: an operator who configures their BYOA to "always trade aggressively, never engage combat unless attacked first."
- How to rotate a token: re-run the skill with `--rotate`, which mints a fresh token, writes the new `.env.byoa`, then revokes the old one (so the operator's running agent keeps working until they redeploy with the new env).

### Test coverage

- Deno tests for `byoa_token_mint` / `byoa_token_revoke` / `ship_byoa_configure` plus the new `byoa_bus_subscribe` / `byoa_bus_publish` / `byoa_bus_archive` SQL wrappers (valid token reads/writes only its own queue; invalid/revoked/expired tokens raise `invalid_token`; cross-character access attempts return empty / no-op without leaking queue existence; publish envelope `source` is authorized against the token's claimed BYOA ship).
- `tests/unit/test_bus_factory.py` — `byoa_pgmq` branch (mock the asyncpg layer; assert `BYOA_TOKEN` is included on every wrapped call).
- `tests/unit/test_prompt_loader.py` — `build_task_agent_prompt(custom_prompt=...)` cases: empty, whitespace, normal, oversize.
- `tests/unit/test_byoa_cli.py` (new) — arg parsing; missing prompt file errors clearly; oversized prompt rejected; happy path constructs `TaskAgent` with `custom_prompt` threaded.
- `tests/unit/test_task_agent_custom_prompt.py` (new) — custom prompt threads into `on_task_start`'s system message; progress queries deliberately ignore it; default `None` is bit-for-bit identical to today.
- `tests/integration/test_byoa_pgmq_bus.py` (opt-in, real Postgres) — end-to-end: mint a token, two `byoa_bus_publish` / `byoa_bus_subscribe` round-trips against a uuid channel, revoke the token, subsequent call raises `invalid_token`.

### Out of scope for Phase 3 (defer to Phase 4 or hardening)

- Game-client UI: ship-card BYOA management, prompt editor, telemetry view (→ Phase 4).
- Server-stored prompts as an overlay on file-stored defaults (→ Phase 4 if operators ask for in-game prompt editing).
- Restricted Postgres role for operators (DSN whose grants are limited to the `byoa_bus_*` wrappers — closes the "operator with admin DSN calls raw pgmq" hole) (→ hardening).
- Rate limits on inbound `byoa_bus_*` calls per token (→ hardening).
- `agent_kind` discriminator on game events for audit log (→ hardening).
- Operator-first task routing on shared ships (revisit when demand is real).
- Multi-ship-per-process BYOA agents.

---

## Phase 3.1 — Centralized `wake_agent` endpoint 🔜 Planned

**Goal:** Replace the per-ship `byoa_wake_hook` URL (originally planned in Phase 3) with a single Gradient Bang-owned `wake_agent` edge function. The bot calls this one endpoint for every BYOA-ship task dispatch (when wake is enabled). The endpoint decides how to actually wake — today it's a stub (log + return 200), later it routes to Vercel Sandbox / Lambda / etc. Operators never author webhooks; the routing-to-sandbox knowledge lives entirely server-side.

### Why this reframing

The original Phase 3 design stored an operator-supplied HTTPS URL on `ship_instances.byoa_wake_hook` and had VoiceAgent POST directly to it. That moved the wake-mechanism integration *into the operator's code*, which:

- Forced every operator to author a webhook handler (Vercel function or similar), even for the dev / always-warm case where wake isn't needed.
- Required server→operator authentication on the POST (the dropped TODO in `_post_wake_hook` for a verify endpoint).
- Made it hard to evolve the wake mechanism — switching from "Vercel API call" to "AWS Lambda invoke" would require coordinating across every operator's deployment.

Pulling wake routing back into a Gradient Bang edge function fixes all three: operators don't author webhooks, auth uses the standard `authenticate(req)` pattern every other edge function uses, and the wake mechanism can be swapped server-side with zero operator-facing changes.

### Concrete deliverables

**Server side**

- **Migration edit (in place)** — `20260512000000_ship_task_lock_and_byoa.sql` → drop the `byoa_wake_hook` column + CHECK + COMMENT. Editing in place is safe because the migration is only on the Phase 3 branch, not on `main`.
- **`ship_byoa_configure`** ([index.ts](../deployment/supabase/functions/ship_byoa_configure/index.ts)) — drop the `wake_hook` field parsing, the state-transition handling, the response field, and the corp event payload field. The `clear` action no longer mentions wake hook.
- **`_shared/corporations.ts`** — drop `wake_hook` from the `byoa` block + the SELECT column.
- **`list_user_ships/index.ts`** — drop `byoa_wake_hook` from the SELECT.
- **New `wake_agent/index.ts`** edge function:
  - Auth: standard `authenticate(req)` + `canActOnCharacter(auth, ship_id, supabase)`. VoiceAgent calls it via `AsyncGameClient` with the existing `X-Edge-Auth` + `X-API-Token` headers, same as every other player-acting endpoint.
  - Body: `{task_id, ship_id, character_id}` where `character_id` is the BYOA owner (used for future routing).
  - Validates `ship_id` is a BYOA ship the caller can act on; otherwise 403.
  - For 3.1: logs the wake intent and returns `{success: true, status: "stub"}`. Future versions add a `WAKE_TARGET=vercel|lambda|noop` env switch and per-character routing config.

**Bot side** ([voice_agent.py](../src/gradientbang/pipecat_server/subagents/voice_agent.py))

- **Drop** `_lookup_byoa_wake_hook` — the bot no longer needs to read a per-ship URL.
- **Replace** `_post_wake_hook` with `_call_wake_agent(task_id, ship_id, character_id)` that hits the new edge function via `AsyncGameClient`.
- **Spawn-flow branch** in `_handle_start_task` changes from "does this ship have a wake_hook?" to "is this a BYOA ship?" Read `byoa_owner_character_id` from the corp lookup. Watchdog + pending-wake + `on_agent_ready` cancellation are unchanged.
- **New env var `BYOA_WAKE_ENABLED`** read by VoiceAgent. Default `false`. When `false`, the bot skips the `wake_agent` call entirely and relies on the always-warm flow (the agent is already on the bus). When `true`, the bot fires the POST. Canonical home is `env.bot.example` (the bot is what reads it); `env.supabase.example` gets a one-line cross-reference for the local-dev path where the bot sources `.env.supabase`. Flipped to `true` only in production bot deploys.
- **`AsyncGameClient.wake_agent(task_id, ship_id, character_id)`** — new method in `utils/api_client.py` for symmetry with the other RPCs.

**Skill** ([byoa-setup/SKILL.md](../.claude/skills/byoa-setup/SKILL.md))

- Drop `--wake-hook` flag.
- Drop the "set a wake hook later" guidance from the final summary.
- Simpler flow: login → pick ship → claim → mint token → write `.env.byoa`.

**Docs**

- **`docs/setup-byoa.md`** — drop "Vercel Sandbox / cold-start operators" note from the quickstart. Replace with a short paragraph: "In production the bot calls Gradient Bang's `wake_agent` endpoint when `BYOA_WAKE_ENABLED=true`. Today that endpoint is a stub; future versions route to your sandbox. For local dev keep `BYOA_WAKE_ENABLED=false` and run `uv run byoa` always-on."
- **`README.md`** — note the new `BYOA_WAKE_ENABLED` knob in the "Subagent bus transport" or a new "BYOA wake mode" section.
- **`env.supabase.example` + `env.bot.example`** — add `BYOA_WAKE_ENABLED=false` with a comment pointing at production guidance.

**Tests**

- **Drop** the `wake_hook lifecycle` block in [byoa_access_test.ts](../deployment/supabase/functions/tests/byoa_access_test.ts).
- **Rewrite** `TestLookupByoaWakeHook` + `TestStartTaskWakeBranch` in [test_voice_agent_byoa_wake.py](../tests/unit/test_voice_agent_byoa_wake.py): replace the lookup tests with `BYOA_WAKE_ENABLED` toggle tests; replace the POST-wired test with a wake_agent call test.
- **New `wake_agent_test.ts`** Deno test — covers admin gate + valid call path + 403 when caller can't act on the ship + 200 stub response shape.

### Scope estimate

~150 LOC of code change net (mostly deletion of wake_hook plumbing + tiny new edge function + bot rewire), ~80 LOC of test rewrite (delete more than add). One commit, possibly two if I split server-side from bot-side.

### Out of scope for 3.1

- The actual wake mechanism (Vercel Sandbox API call, Lambda invoke, etc.). `wake_agent` is a stub.
- Operator registration of their sandbox endpoint with Gradient Bang. That's the future Phase 3.x that makes the stub do something real.
- Per-task model / wake parameter overrides — bot supplies fixed `{task_id, ship_id, character_id}`.

---

## Phase 4 — Operator-chosen LLM provider/model 🔜 Planned

**Goal:** A BYOA operator can specify which LLM provider + model their agent uses (and pass the matching API key) without touching the bot's config. Today `TASK_LLM_PROVIDER` / `TASK_LLM_MODEL` are resolved lazily from `os.environ` inside `get_task_agent_llm_config` ([src/gradientbang/utils/llm_factory.py:516](../src/gradientbang/utils/llm_factory.py#L516)), so values placed in `.env.byoa` already flow through; but the behavior is undocumented, untested, the precedence is wrong (shell wins, file loses), and there's no startup feedback so the operator can verify which model they got.

### Motivation

- Operators may want a different cost/latency/capability tradeoff than the bot's default (e.g. Claude Sonnet vs. GPT-4.1) without coordinating with the game operator.
- Different operators may have API quota with different providers; their BYOA agent should use their own keys, not the bot's.
- Per Phase 3 (4/N), the operator's `custom_prompt` already personalizes the agent — choice of LLM is a natural extension of "operator owns the runtime."

### Design

#### Env-var contract

Operator's `.env.byoa` may set any of:

- `TASK_LLM_PROVIDER` — `google` | `anthropic` | `openai` | `minimax`. Defaults per `get_task_agent_llm_config`.
- `TASK_LLM_MODEL` — model name. Defaults per provider table in `llm_factory.py`.
- `TASK_LLM_THINKING_BUDGET` — token budget. Default 4096.
- `TASK_LLM_FUNCTION_CALL_TIMEOUT_SECS` — tool-call timeout. Default 20.
- Provider API keys: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `MINIMAX_API_KEY` — only the one matching the chosen provider needs to be set.

We deliberately do NOT introduce `BYOA_LLM_*` aliases. Reusing `TASK_LLM_*` keeps the operator's mental model 1:1 with how the bot is configured (and with `get_task_agent_llm_config`'s docstring, env.bot.example, etc.). Less surface area to document; less risk of drift.

#### Precedence rule

Today the CLI calls `load_dotenv(env_file, override=False)` — shell env wins. For LLM config that's slightly wrong: `.env.byoa` is the *operator's deployment configuration*, and the operator's expectation is that it controls which model their agent runs. A leaked shell `TASK_LLM_PROVIDER` from an unrelated context shouldn't silently change behavior.

**Proposed**: for the specific keys we identify as "deployment-authoritative" (the LLM family + API keys + `BYOA_*` identity vars), the CLI should treat the env file as source of truth — i.e. `load_dotenv(env_file, override=True)` for those keys, or an explicit override loop.

Hold on this — it's a behavior change for the existing `BYOA_TOKEN` / `SUBAGENT_BUS_*` keys, which today are documented as "shell wins for in-place rotation." Two options:

- **A.** Keep `override=False` globally; document that LLM rotation requires editing the file (consistent precedence rule, simpler mental model).
- **B.** Apply `override=True` ONLY for LLM-related keys; document the exception (matches operator intent for deployment config, costs one mental footnote).

Default: **option A** (simplest, no special-casing). Operators who really want shell-override get the standard dotenv behavior. We document the precedence clearly.

#### Startup validation

The CLI gains a small validation pass after dotenv load + before TaskAgent build:

- If `TASK_LLM_PROVIDER` is set to `anthropic` but `ANTHROPIC_API_KEY` is missing/empty → raise a `CliError` with the exact key name needed. Same for openai/google/minimax.
- If `TASK_LLM_PROVIDER` is set but invalid → match `get_task_agent_llm_config`'s warning behavior but surface it visibly to the operator (not just a log line buried in startup).

#### Visibility log

The existing `byoa.cli.starting` log line gains the resolved provider/model so the operator can see at a glance what shipped. Example:

```
byoa.cli.starting agent=byoa_<ship> ship=<id8> character=<id8>
                  llm=anthropic/claude-sonnet-4-5-20250929 thinking_budget=4096
                  prompt_bytes=1234
```

If the resolved values came from `.env.byoa`, log `source=.env.byoa`. If from shell env (overriding file), log `source=shell`. If from defaults (no operator override), log `source=default`. Helps debug the "I changed my model and nothing happened" case.

#### Wake-time integration

The user's framing was "passed through to the agent on wake." There are two interpretations:

- **Cold-start-time** — operator's CLI starts up (which IS "on wake" for a Vercel-sandboxed BYOA agent), reads its `.env.byoa`, instantiates TaskAgent with the resolved LLM config. This is what the implementation above does — the value is baked into the TaskAgent instance for its lifetime.
- **Per-task** — bot supplies a model override in the wake-hook payload or `BusTaskRequest`, and the BYOA agent switches mid-process for that task.

This phase ships **only the cold-start-time interpretation**. Per-task overrides are powerful but introduce coordination (bot needs to know which providers the operator has keys for, operator needs to honor bot-supplied overrides, etc.). Defer until there's a real use case.

### Concrete deliverables

1. **`src/gradientbang/byoa/cli.py`**:
   - New `_validate_llm_config()` helper run after env load. Checks provider/key pairing; raises `CliError` on missing key.
   - Extend the `byoa.cli.starting` log to include LLM provider/model + source attribution.
2. **`env.byoa.example`**:
   - New "LLM provider" section with:
     - Commented `TASK_LLM_PROVIDER` / `TASK_LLM_MODEL` examples (anthropic + openai shown).
     - Note that API key for chosen provider is required.
     - Pointer to `llm_factory.py` for the full provider list.
3. **`docs/setup-byoa.md`**:
   - Quickstart gains a Step 2.5 "Choose your LLM" section (between writing the prompt and running the agent).
   - New "LLM provider" subsection under "Configuration" listing the env vars + default precedence rule + the validation-fails-fast behavior.
4. **Tests**:
   - `tests/unit/test_byoa_cli.py`: extend with cases for the new validation — missing API key for selected provider raises CliError; valid config logs the expected source attribution.
   - No new integration tests required; the existing CLI + LLM-factory paths are independently covered.

### Out of scope for 3.1

- Per-task model overrides supplied by the bot.
- BYOA-prefixed env-var aliases (`BYOA_LLM_PROVIDER` etc.).
- `override=True` for non-LLM keys (would break the documented "shell wins for in-place rotation" pattern for `BYOA_TOKEN`).
- UI for picking a model in the game client (lives with the broader UI work in Phase 4).
- Multi-provider failover (operator picks one provider per deployment; restart to switch).

---

## Phase 5 — BYOA management UI 🔜 Planned

**Goal:** lift BYOA management out of CLI / Claude-skill territory and into the game client. Operators can claim a ship, configure mode + wake hook, edit prompts, mint/revoke tokens, and watch their agent's live bus activity — all from the UI a regular player already uses.

The Phase 3 Claude skill stays as the scripting / power-user path; Phase 4 is purely about lowering the barrier to entry for non-CLI-comfortable operators.

### Surfaces

- **Ship card BYOA panel** — claim/release, switch `private` ↔ `shared`, view current token list with last-used timestamps + revoke button. Extends the existing [ShipStatusPopover.tsx](../client/app/src/components/ShipStatusPopover.tsx).
- **Prompt editor** — in-browser editor for the operator's custom prompt with the 8 KB cap surfaced inline. Saves to a new `ship_instances.byoa_custom_prompt` column (additive migration). The `uv run byoa` runtime is extended to overlay server-stored prompt on top of file-stored default — file wins if both are present so operators in version-controlled flows aren't surprised.
- **Token management** — mint new tokens with custom labels + expirations; copy-to-clipboard once on creation (never re-shown); revoke individual tokens. Surfaces `byoa_token_list` (new edge function).
- **Telemetry view** — live stream of "what is my BYOA agent doing on the bus": inbound `BusTaskRequest`s, outbound `BusGameToolCallRequest`s + responses, errors, idle teardowns. Reuses the existing pubsub channel infrastructure; a new `byoa_telemetry_stream` server-side helper fans out the operator-owned messages without exposing other corp members' traffic.

### Server-side additions

- `ship_instances.byoa_custom_prompt TEXT NULL` + 8 KB check constraint.
- `byoa_token_list` edge function (Supabase-JWT-authed, returns token rows owned by `character_id` — hashes, labels, last-used, revoked status; never plaintext).
- `byoa_telemetry_subscribe` SECURITY DEFINER SQL function for the bus-activity stream, gated by `can_user_access_character`.
- `ship_byoa_configure` extended to accept `custom_prompt` field.

### Test coverage

- Deno tests for `byoa_token_list`, `byoa_telemetry_subscribe`, `ship_byoa_configure` (`custom_prompt` field + 8 KB enforcement).
- React component tests for the new BYOA panel, prompt editor (cap surfacing), token management modal.
- One end-to-end Playwright test for the claim-ship → edit-prompt → mint-token flow.

### Out of scope for Phase 4

- Restricted Postgres role for operator DSNs (→ hardening; needed before non-team operators).
- Rate limits on inbound `byoa_bus_*` calls per token (→ hardening).
- `agent_kind` discriminator on game events for audit log (→ hardening).
- Operator-first task routing on shared ships.
- Multi-ship-per-process BYOA agents.

---

## Why this order

- **Groundwork first** because everything else assumes the server-side ship lock and BYOA columns exist. It's independently shippable, lower-risk than the agent refactor, and fixes a real correctness gap today (two corp members can currently double-task the same ship).
- **Phase 1 second** because it freezes the bus contract. Once TaskAgent is fully bus-based and uses only typed messages, Phase 2 (the optional local/remote bus factory) is mostly transport wiring and Phase 3 (BYOA operator) has a stable target API to implement against.
- **Phase 2 before Phase 3** because BYOA needs the bus transport choice to be explicit. Local/dev BYOA can use the default in-process bus, while production / external remote BYOA opts into PGMQ. Phase 3 layers token-gated SECURITY DEFINER wrappers on top of PGMQ so the operator's reach is constrained to their bound character_id.
- **Phase 3.1 right after Phase 3** because it reverses one design decision from Phase 3 (per-ship `byoa_wake_hook`) before that decision spreads downstream. Doing it as a follow-up rather than rewriting Phase 3's commit history keeps the branch stack clean.
- **Phase 4 (LLM overrides) after Phase 3.1** because it depends on the CLI shipping in Phase 3 (4/N). Mostly env + validation + docs; small surface.
- **Phase 5 last** because UI work depends on every primitive below it: the bus contract (Phase 1), the remote transport (Phase 2), and BYOA token auth + agent runtime (Phase 3). With those in place, Phase 5 is mostly thin React surfaces over the existing edge functions.

Phases 1 and 2 keep player-visible behavior identical (the in-process flow is preserved bit-for-bit at each step). Phase 3 is where new user-facing behavior actually appears. Phase 5 unlocks game-client BYOA management.

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

**Phase 3 — modify:**
- [src/gradientbang/utils/prompt_loader.py](../src/gradientbang/utils/prompt_loader.py) — `build_task_agent_prompt(custom_prompt=...)` kwarg, appended "Operator guidance" section.
- [src/gradientbang/pipecat_server/subagents/task_agent.py](../src/gradientbang/pipecat_server/subagents/task_agent.py) — `__init__` accepts `custom_prompt`; threaded through `on_task_start` only (not `on_task_progress_query`).
- [src/gradientbang/pipecat_server/subagents/voice_agent.py](../src/gradientbang/pipecat_server/subagents/voice_agent.py) — async wake-hook flow (shipped in 2/N).
- [src/gradientbang/adapters/bus/factory.py](../src/gradientbang/adapters/bus/factory.py) — `byoa_pgmq` branch.
- `pyproject.toml` — new `[project.scripts] byoa = ...` entry.
- [docs/setup-byoa.md](setup-byoa.md) — operator quickstart, `env.byoa.example` shape, prompt-file conventions.

**Phase 3 — create:**
- Migration adding the token-gated SQL wrappers (`byoa_bus_subscribe` / `byoa_bus_publish` / `byoa_bus_archive`).
- `src/gradientbang/adapters/bus/byoa_pgmq.py` — `PgmqBus` variant that routes through the SQL wrappers + threads `BYOA_TOKEN` on every call.
- `src/gradientbang/byoa/cli.py` — `uv run byoa --prompt-file …` entry point with `.env.byoa` auto-load.
- `env.byoa.example` at repo root.
- `.claude/skills/byoa-setup/SKILL.md` — onboarding skill.
- `tests/unit/test_byoa_cli.py`, `tests/unit/test_task_agent_custom_prompt.py`, `tests/unit/test_byoa_bus_adapter.py`; extension to `tests/unit/test_prompt_loader.py` + `test_bus_factory.py`.
- Deno tests for the new SQL wrappers (in `deployment/supabase/functions/tests/`).
- `tests/integration/test_byoa_pgmq_bus.py` (opt-in, real Postgres).

**Phase 3.1 — modify:**
- `20260512000000_ship_task_lock_and_byoa.sql` — drop the `byoa_wake_hook` column + CHECK + comment.
- [deployment/supabase/functions/ship_byoa_configure/index.ts](../deployment/supabase/functions/ship_byoa_configure/index.ts) — drop `wake_hook` field everywhere.
- [deployment/supabase/functions/_shared/corporations.ts](../deployment/supabase/functions/_shared/corporations.ts) — drop `wake_hook` from the byoa block + SELECT.
- [deployment/supabase/functions/list_user_ships/index.ts](../deployment/supabase/functions/list_user_ships/index.ts) — drop `byoa_wake_hook` from SELECT.
- [src/gradientbang/pipecat_server/subagents/voice_agent.py](../src/gradientbang/pipecat_server/subagents/voice_agent.py) — drop `_lookup_byoa_wake_hook`, rename `_post_wake_hook` → `_call_wake_agent`, gate on `BYOA_WAKE_ENABLED`.
- [src/gradientbang/utils/api_client.py](../src/gradientbang/utils/api_client.py) — new `wake_agent(...)` method on `AsyncGameClient`.
- `env.bot.example` — add `BYOA_WAKE_ENABLED=false` with comment; cross-reference from `env.supabase.example`.
- [.claude/skills/byoa-setup/SKILL.md](../.claude/skills/byoa-setup/SKILL.md) — drop `--wake-hook` flag + the "set a wake hook later" guidance.
- `docs/setup-byoa.md` + `README.md` — update wake-flow narrative to the centralized endpoint model.

**Phase 3.1 — create:**
- `deployment/supabase/functions/wake_agent/index.ts` — admin-authed stub edge function.
- `deployment/supabase/functions/tests/wake_agent_test.ts` — Deno test for the gate + 200 stub path.

**Phase 4 — modify:**
- [src/gradientbang/byoa/cli.py](../src/gradientbang/byoa/cli.py) — `_validate_llm_config()` helper + extended `byoa.cli.starting` log with provider/model/source.
- `env.byoa.example` — new "LLM provider" section.
- `docs/setup-byoa.md` — Step 2.5 "Choose your LLM" + Configuration subsection.
- [tests/unit/test_byoa_cli.py](../tests/unit/test_byoa_cli.py) — LLM validation cases.

**Phase 5 — create (high level):**
- Client UI surfaces for BYOA management on each corp ship (claim/release, mode toggle, prompt editor, token list).
- `ship_instances.byoa_custom_prompt` column + server-stored-prompt overlay support in the runtime.
- `byoa_token_list` edge function + `byoa_telemetry_subscribe` for live bus-activity stream.
- Playwright E2E coverage of the claim → edit-prompt → mint-token flow.

**Reused throughout (don't reinvent):**
- `GAME_METHOD_ALIASES` in [src/gradientbang/tools/schemas.py](../src/gradientbang/tools/schemas.py).
- `ToolsSchema` (`TASK_TOOLS`, `PLAYER_ONLY_TOOLS`) in [src/gradientbang/tools/__init__.py](../src/gradientbang/tools/__init__.py).
- `pipecat_subagents.bus.AgentBus` injectable pattern.
- PGMQ primitives from [20260505000000_pubsub_and_broadcasts.sql](../deployment/supabase/migrations/20260505000000_pubsub_and_broadcasts.sql).
- `can_user_access_character` SQL predicate.
